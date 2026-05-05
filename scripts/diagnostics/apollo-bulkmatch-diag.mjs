#!/usr/bin/env node
/**
 * apollo-bulkmatch-diag.mjs — one-shot diagnostic for Apollo enrichment by id.
 *
 * `mixed_people/api_search` returns `apollo_person_id` but no `linkedin_url` or
 * `email`. Stage 3 needs `bulk_match` to fill those in. Apollo's docs list `id`
 * as a valid match key, but the docs sample passes every field. Before we wire
 * id-only `bulk_match` into Stage 3, we run this script once against ~10 known
 * IDs from a saved search dump to verify, empirically, that:
 *
 *   1) `bulk_match` returns `linkedin_url` when called with id-only details.
 *   2) `bulk_match` returns `email` (status filtered by your plan).
 *   3) Credit cost is what we expect (≤ 1 per matched email).
 *
 * As a control, the same IDs are also enriched one at a time via `/people/match`
 * (you've manually confirmed this works with id alone). That tells us whether
 * any difference between bulk and single is plan-related vs id-key-related.
 *
 * Usage:
 *   node scripts/diagnostics/apollo-bulkmatch-diag.mjs <path/to/<job_id>-search.json> [count]
 *
 * Output:
 *   data/stage3/diag-bulkmatch-by-id-<ts>.json   (full per-id breakdown)
 *   stdout                                       (aggregate summary JSON)
 *
 * Env: APOLLO_API_KEY (required). Same .env discovery as Stage 3.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDotenv, requireEnv } from '../../integrations/google/env.mjs';
import { bulkMatchPeople } from '../../integrations/apollo/client.mjs';

await loadDotenv();
const APOLLO_API_KEY = requireEnv('APOLLO_API_KEY');
const APOLLO_BASE = 'https://api.apollo.io/api/v1';

/**
 * Direct `/people/match` call with id-only body. We bypass `enrichPerson()`
 * because the current build doesn't yet accept `apolloPersonId` (that's a
 * Phase 2 change). Keeping the diag self-contained means we can prove the
 * id-key contract without modifying any production code first.
 */
async function peopleMatchById(apolloPersonId) {
  const res = await fetch(`${APOLLO_BASE}/people/match`, {
    method: 'POST',
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json',
      'accept': 'application/json',
      'X-Api-Key': APOLLO_API_KEY,
    },
    body: JSON.stringify({ id: apolloPersonId, reveal_personal_emails: false }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: (json && json.error) || text.slice(0, 300),
      raw: json,
    };
  }
  const raw = json && (json.person || json.matched_person || json.contact);
  return { ok: true, raw, full: json };
}

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    'Usage: node scripts/diagnostics/apollo-bulkmatch-diag.mjs <path/to/<job_id>-search.json> [count]'
  );
  process.exit(2);
}

const dumpPath = resolve(args[0]);
const requestedCount = Math.max(1, Math.min(10, Number(args[1]) || 10));

if (!existsSync(dumpPath)) {
  console.error(`Search dump not found: ${dumpPath}`);
  process.exit(2);
}

const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const candidates = Array.isArray(dump?.people) ? dump.people : [];
const ids = [];
for (const p of candidates) {
  if (ids.length >= requestedCount) break;
  if (p && typeof p.apollo_person_id === 'string' && p.apollo_person_id) {
    ids.push({
      apollo_person_id: p.apollo_person_id,
      name: p.name || '',
      title: p.title || '',
      kind: p.kind || '',
    });
  }
}

if (ids.length === 0) {
  console.error(`No apollo_person_id values found in ${dumpPath}`);
  process.exit(2);
}

/* ───────────────────────────── bulk_match (id-only) ───────────────────── */

const bulkInput = ids.map((x) => ({ id: x.apollo_person_id }));
const bulkRes = await bulkMatchPeople({
  details: bulkInput,
  revealPersonalEmails: false,
});

// Apollo returns an array aligned (best-effort) with the input order. Build a
// lookup by apollo_person_id so we can attribute each match back to the source
// id even if the order isn't preserved.
const bulkById = new Map();
for (const m of bulkRes.matches || []) {
  if (!m) continue;
  if (m.apollo_person_id) bulkById.set(m.apollo_person_id, m);
}

/* ───────────────────────────── people/match (control) ─────────────────── */

// Apollo's `/people/match` returns the same shape as `bulk_match`'s `matches[i]`
// but for one id at a time. We only extract the fields we care about so the
// diag JSON stays small.
const singleResults = [];
for (const x of ids) {
  let match = null;
  let err = null;
  try {
    const r = await peopleMatchById(x.apollo_person_id);
    if (r.ok && r.raw) {
      match = {
        apollo_person_id: r.raw.id || x.apollo_person_id,
        linkedin_url: r.raw.linkedin_url || '',
        email: typeof r.raw.email === 'string' ? r.raw.email.trim() : '',
        email_status: String(r.raw.email_status || '').toLowerCase(),
      };
    } else if (!r.ok) {
      err = `HTTP ${r.status}: ${r.error}`;
    }
  } catch (e) {
    err = e?.message || String(e);
  }
  singleResults.push({ apollo_person_id: x.apollo_person_id, match, error: err });
  // Light pacing — same as Stage 3.
  await new Promise((r) => setTimeout(r, 1200));
}

/* ───────────────────────────── per-id rows + aggregates ───────────────── */

const perId = ids.map((x) => {
  const b = bulkById.get(x.apollo_person_id) || null;
  const sEntry = singleResults.find((s) => s.apollo_person_id === x.apollo_person_id);
  const s = sEntry?.match || null;
  const summarize = (m) =>
    m
      ? {
          matched: true,
          linkedin_url: m.linkedin_url || '',
          email: m.email || '',
          email_status: m.email_status || '',
          email_confidence: m.email_confidence || '',
        }
      : { matched: false, linkedin_url: '', email: '', email_status: '', email_confidence: '' };

  return {
    apollo_person_id: x.apollo_person_id,
    name: x.name,
    title: x.title,
    kind: x.kind,
    bulk_match: summarize(b),
    match_single: summarize(s),
    match_single_error: sEntry?.error || null,
  };
});

const aggregate = {
  source_dump: dumpPath,
  ids_total: ids.length,
  bulk_matched: perId.filter((r) => r.bulk_match.matched).length,
  bulk_linkedin_returned: perId.filter((r) => r.bulk_match.linkedin_url).length,
  bulk_email_returned: perId.filter((r) => r.bulk_match.email).length,
  bulk_credits_estimated: perId.filter((r) => r.bulk_match.email).length,
  single_matched: perId.filter((r) => r.match_single.matched).length,
  single_linkedin_returned: perId.filter((r) => r.match_single.linkedin_url).length,
  single_email_returned: perId.filter((r) => r.match_single.email).length,
  bulk_status_code: bulkRes.status_code,
  bulk_missing: bulkRes.missing,
};

const ts = new Date()
  .toISOString()
  .replace(/[-:T]/g, '')
  .slice(0, 15)
  .replace(/(\d{8})(\d{6})/, '$1-$2');
const outDir = join(REPO_ROOT, 'data', 'stage3');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `diag-bulkmatch-by-id-${ts}.json`);
writeFileSync(
  outPath,
  JSON.stringify(
    {
      ...aggregate,
      out_path: outPath,
      ids: perId,
    },
    null,
    2
  )
);

console.log(JSON.stringify({ ...aggregate, out_path: outPath }, null, 2));
