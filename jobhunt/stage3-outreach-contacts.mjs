#!/usr/bin/env node
/**
 * stage3-outreach-contacts.mjs — Apollo enrich-only Stage 3.
 *
 * After Stage 2 has produced ASSETS for every PURSUE row, this script:
 *   1) Calls Apollo `/v1/mixed_people/api_search` per company (recruiter + HM passes).
 *      Discovery only — credit-free on the basic plan.
 *   2) Dedups against CONTACTS_MASTER using `apollo_person_id` (from notes) >
 *      `linkedin_url` > `email`.
 *   3) Reveals emails for net-new contacts via `/v1/people/bulk_match` (≤ 10 per call,
 *      ~1 credit per new email). Falls back to `/v1/people/match` if needed.
 *   4) Reuses Stage 2's outreach email body and LinkedIn invite — swaps only the
 *      salutation (and `[Name]` placeholder for the LI invite). No per-contact
 *      Claude call when `JOBHUNT_STAGE3_ENRICH_ONLY=1` (default).
 *   5) Appends one CONTACTS row per (job_id, contact_id) and upserts CONTACTS_MASTER.
 *   6) Writes per-run dumps to `data/stage3/<runId>/` so a `cleanup` that wipes
 *      the sheet does not lose the discovered contacts. Writes `CONTACTS_MASTER`
 *      disk snapshots to `data/snapshots/` (history + latest pointer), decoupled
 *      from per-run folders so early-exit runs cannot starve rebuild.
 *
 * It does NOT send anything. Drafts only.
 *
 * Usage:
 *   npm run jobhunt:stage3
 *
 * Tunables (env, all optional except APOLLO_API_KEY / GOOGLE_*):
 *   APOLLO_API_KEY                              required
 *   JOBHUNT_STAGE3_ENRICH_ONLY=1                default ON; set 0 to disable (not yet wired)
 *   JOBHUNT_STAGE3_PER_KIND_DEFAULT_MAX=40      cap per kind for non-priority companies
 *   JOBHUNT_STAGE3_PER_KIND_PRIORITY_MAX=80     cap per kind for priority-companies.yml entries
 *   JOBHUNT_STAGE3_PER_KIND_MIN=2               soft floor (warn-only)
 *   JOBHUNT_APOLLO_PERSON_LOCATIONS=...         comma-separated; default US-only
 *   JOBHUNT_APOLLO_CONTACT_EMAIL_STATUS=...     default "verified,likely to engage"
 *   JOBHUNT_APOLLO_BULK_MATCH_BATCH=10          Apollo hard cap is 10
 *   JOBHUNT_APOLLO_REVEAL_PERSONAL_EMAILS=0     1 = reveal personal emails too (extra credits)
 *   JOBHUNT_STAGE3_DUMP_DIR=data/stage3         relative to career-ops/
 *   JOBHUNT_SNAPSHOTS_DIR=data/snapshots        CONTACTS_MASTER JSON snapshots (relative)
 *   JOBHUNT_STAGE3_LIMIT=                       cap PURSUE rows per run (dry-run)
 *   JOBHUNT_REGENERATE_CONTACTS=                1 = re-run for jobs already in CONTACTS
 *
 * Deprecated (ignored when config/priority-companies.yml exists):
 *   JOBHUNT_STAGE3_PER_KIND_MAX, JOBHUNT_STAGE3_BIGCO_EMPLOYEE_THRESHOLD
 */

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { loadDotenv, normalizeGoogleSheetId, requireEnv } from '../integrations/google/env.mjs';
import { getSheetsClient } from '../integrations/google/auth.mjs';
import { appendRows, updateRanges } from '../integrations/google/sheets.mjs';
import { withGoogleApi, getGoogleApiMetrics } from '../integrations/google/rate-limit.mjs';
import {
  getRootFolder,
  ensureSubfolders,
  ensureFolderPath,
  createTextFile,
  parseDriveFileId,
  exportFileUtf8,
} from '../integrations/google/drive.mjs';
import { ymd, slugifyFolderName } from './ids.mjs';
import { loadCandidateContext } from './lib/candidate-context.mjs';
import {
  applyDeterministicEmailSignature,
  parseCandidateFromProfileYaml,
  formatEmailFile,
} from './lib/claude-asset-generators.mjs';
import {
  searchPeopleApiSearch,
  bulkMatchPeople,
  enrichPerson,
  guessDomainFromCompany,
  buildApiSearchQuery,
  buildApolloSearchUrl,
} from '../integrations/apollo/client.mjs';
import {
  RECRUITER_TITLES,
  HM_SENIORITIES,
  roleToHmTitleKeywords,
} from '../integrations/apollo/taxonomy.mjs';

await loadDotenv();

// Surface clear errors before we do any work.
requireEnv('APOLLO_API_KEY');
const sheets = await getSheetsClient();
const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));

/* ───────────────────────────── env config ─────────────────────────────── */

const ENRICH_ONLY = String(process.env.JOBHUNT_STAGE3_ENRICH_ONLY ?? '1').trim() !== '0';
if (!ENRICH_ONLY) {
  console.error(
    JSON.stringify({
      ok: false,
      error:
        'JOBHUNT_STAGE3_ENRICH_ONLY=0 is not wired in this build. Per-contact Claude personalization is intentionally deferred. Unset the env var to run the default (enrich-only) flow.',
    })
  );
  process.exit(1);
}

const PER_KIND_DEFAULT_MAX = Math.max(
  1,
  Number(
    process.env.JOBHUNT_STAGE3_PER_KIND_DEFAULT_MAX ||
      process.env.JOBHUNT_STAGE3_PER_KIND_MAX ||
      40
  )
);
const PER_KIND_PRIORITY_MAX = Math.max(
  PER_KIND_DEFAULT_MAX,
  Number(process.env.JOBHUNT_STAGE3_PER_KIND_PRIORITY_MAX || 80)
);
const PER_KIND_MIN = Math.max(1, Number(process.env.JOBHUNT_STAGE3_PER_KIND_MIN || 2));
const RUN_LIMIT = Number(process.env.JOBHUNT_STAGE3_LIMIT || 0);
const REGENERATE = String(process.env.JOBHUNT_REGENERATE_CONTACTS || '').trim() === '1';

const PERSON_LOCATIONS = parseCsvEnv(
  process.env.JOBHUNT_APOLLO_PERSON_LOCATIONS,
  'United States,USA,United States of America,US'
);
const CONTACT_EMAIL_STATUS = parseCsvEnv(
  process.env.JOBHUNT_APOLLO_CONTACT_EMAIL_STATUS,
  'verified,likely to engage'
);
const BULK_MATCH_BATCH = Math.min(
  10,
  Math.max(1, Number(process.env.JOBHUNT_APOLLO_BULK_MATCH_BATCH || 10))
);
const REVEAL_PERSONAL_EMAILS =
  String(process.env.JOBHUNT_APOLLO_REVEAL_PERSONAL_EMAILS || '').trim() === '1';
const DUMP_DIR_REL = process.env.JOBHUNT_STAGE3_DUMP_DIR || 'data/stage3';
const SNAPSHOTS_DIR_REL = process.env.JOBHUNT_SNAPSHOTS_DIR || 'data/snapshots';

const SLEEP_APOLLO_MS = 1200;

function parseCsvEnv(raw, fallback) {
  return String(raw == null || raw === '' ? fallback : raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ───────────────────────────── helpers ────────────────────────────────── */

const now = new Date();
const date = ymd(now);
const iso = now.toISOString();

function pad2(n) {
  return String(n).padStart(2, '0');
}

const runId = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(
  now.getHours()
)}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

const dumpDir = join(process.cwd(), DUMP_DIR_REL, runId);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getCell(row, idx) {
  return row && idx >= 0 && row[idx] != null ? String(row[idx]).trim() : '';
}

function makeContactId({ apollo_person_id, linkedin_url, email, organizationName, name, title }) {
  const ymdCompact = date.replace(/-/g, '');
  const base = String(
    apollo_person_id ||
      linkedin_url ||
      email ||
      `${organizationName || ''}::${name || ''}::${title || ''}`
  )
    .toLowerCase()
    .trim();
  const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 8).toUpperCase();
  return `CT-${ymdCompact}-${hash}`;
}

function ensureDumpDir() {
  if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });
}

function dumpJson(filename, payload) {
  ensureDumpDir();
  const path = join(dumpDir, filename);
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return path;
}

/** Writes CONTACTS_MASTER snapshot JSON under `data/snapshots/` (not per-run `stage3/`). */
function writeSnapshot(filename, payload) {
  const dir = join(process.cwd(), SNAPSHOTS_DIR_REL);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return path;
}

function loadPriorityCompanies() {
  const path = join(process.cwd(), 'config', 'priority-companies.yml');
  if (!existsSync(path)) return [];
  try {
    const doc = yaml.load(readFileSync(path, 'utf-8'));
    const list = Array.isArray(doc?.priority_companies) ? doc.priority_companies : [];
    return list
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!name) return null;
        const domainSingle = typeof entry.domain === 'string' ? entry.domain.trim() : '';
        let domains = [];
        if (Array.isArray(entry.domains) && entry.domains.length > 0) {
          domains = entry.domains.map((d) => String(d || '').trim()).filter(Boolean);
        } else if (domainSingle) {
          domains = [domainSingle];
        }
        return {
          name,
          name_lc: name.toLowerCase(),
          domain: domains[0] || domainSingle || '',
          domains,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error(`[stage3] Failed to parse priority-companies.yml: ${err?.message || err}`);
    return [];
  }
}

function pickPriorityEntry(priorityList, company) {
  const target = String(company || '').trim().toLowerCase();
  if (!target) return null;
  return priorityList.find((p) => p.name_lc === target) || null;
}

/** Apollo org domains for api_search: priority YAML `domains` / `domain`, else guessed slug domain. */
function resolveApolloDomainsForCompany(company, priorityEntry) {
  if (priorityEntry?.domains?.length) return priorityEntry.domains;
  const g = guessDomainFromCompany(company);
  return g ? [g] : [];
}

function pickCapForCompany(priorityEntry) {
  return priorityEntry ? PER_KIND_PRIORITY_MAX : PER_KIND_DEFAULT_MAX;
}

/**
 * `notes` lives in the last column of CONTACTS_MASTER as semicolon-delimited
 * key=value pairs. Pull `apollo_person_id` out of it (case-insensitive).
 */
function extractApolloIdFromNotes(notes) {
  const m = String(notes || '').match(/apollo_person_id\s*=\s*([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}

function parseEmailFileText(text) {
  const s = String(text || '');
  const lines = s.split(/\r?\n/);
  let subject = '';
  let bodyStartIdx = 0;
  if (lines[0] && /^Subject:\s*/i.test(lines[0])) {
    subject = lines[0].replace(/^Subject:\s*/i, '').trim();
    bodyStartIdx = lines[1] === '' ? 2 : 1;
  }
  const body = lines.slice(bodyStartIdx).join('\n').replace(/\n+$/, '');
  return { subject, body };
}

function swapSalutation(body, firstName) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const lines = String(body || '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return greeting;
  lines[i] = greeting;
  return lines.join('\n');
}

function swapInviteName(text, firstName) {
  const t = String(text || '');
  if (!t) return '';
  if (firstName) return t.replaceAll('[Name]', firstName);
  return t;
}

function dedupKey(person) {
  if (person.apollo_person_id) return `id:${person.apollo_person_id}`;
  if (person.linkedin_url) return `li:${person.linkedin_url.toLowerCase()}`;
  if (person.email) return `em:${person.email.toLowerCase()}`;
  return `nm:${(person.name || '').toLowerCase()}|${(person.title || '').toLowerCase()}`;
}

/**
 * Render a copy-paste-ready cURL string for a `/mixed_people/api_search`
 * `query` object. The URL is generated by the same builder the live client
 * uses, so the cURL is byte-identical to the actual request. The API key is
 * deliberately a placeholder — these dumps live on disk under `data/stage3/`
 * (gitignored) and we don't want to write the real secret there.
 */
function buildCurlExample(query) {
  const url = buildApolloSearchUrl('/mixed_people/api_search', query);
  return [
    'curl -sS --request POST \\',
    `  --url "${url}" \\`,
    '  --header "accept: application/json" \\',
    '  --header "content-type: application/json" \\',
    '  --header "x-api-key: <APOLLO_API_KEY>"',
  ].join('\n');
}

/* ───────────────────────────── apollo discovery ───────────────────────── */

async function paginateApiSearch({ domains, titles, seniorities, kind, cap }) {
  const collected = [];
  const seen = new Set();
  let page = 1;
  const perPage = 100; // Apollo cap.

  while (collected.length < cap && page <= 500) {
    let res;
    try {
      res = await searchPeopleApiSearch({
        domains,
        titles,
        seniorities,
        locations: PERSON_LOCATIONS,
        emailStatuses: CONTACT_EMAIL_STATUS,
        page,
        perPage,
      });
    } catch (err) {
      throw new Error(`Apollo api_search ${kind} page ${page} failed: ${err?.message || err}`);
    }

    const people = res.people || [];
    for (const p of people) {
      const key = dedupKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({ ...p, kind });
      if (collected.length >= cap) break;
    }

    if (people.length === 0) break;
    if (res.total_pages && page >= res.total_pages) break;
    if (people.length < res.per_page) break;

    page += 1;
    await sleep(SLEEP_APOLLO_MS);
  }

  return collected.slice(0, cap);
}

/* ───────────────────────────── enrichment (bulk_match) ────────────────── */

async function bulkMatchInBatches(people, jobReport) {
  // Two lookup maps because `mixed_people/api_search` returns `apollo_person_id`
  // but no LinkedIn URL — id is the only match key we can trust at input time.
  // After Apollo enriches, we also want to merge by linkedin_url for survivors
  // that had it from another source.
  const matchedByLi = new Map();
  const matchedById = new Map();
  let credits_estimated = 0;
  let attempted_by_li = 0;
  let attempted_by_id_only = 0;
  let linkedin_returned = 0;
  const batches = [];
  for (let i = 0; i < people.length; i += BULK_MATCH_BATCH) {
    batches.push(people.slice(i, i + BULK_MATCH_BATCH));
  }

  const cleanedRecords = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const details = batch
      .filter((p) => p.linkedin_url || p.apollo_person_id)
      .map((p) => {
        if (p.linkedin_url) attempted_by_li += 1;
        else if (p.apollo_person_id) attempted_by_id_only += 1;
        return {
          linkedin_url: p.linkedin_url || undefined,
          id: p.apollo_person_id || undefined,
          first_name: p.first_name || undefined,
          last_name: p.name && p.first_name ? p.name.replace(p.first_name, '').trim() : undefined,
          organization_name: p.organization?.name || undefined,
          domain: p.organization?.primary_domain || undefined,
        };
      });

    if (details.length === 0) continue;

    let res;
    try {
      res = await bulkMatchPeople({ details, revealPersonalEmails: REVEAL_PERSONAL_EMAILS });
    } catch (err) {
      jobReport.warnings.push(
        `Apollo bulk_match batch ${bi + 1}/${batches.length} failed: ${err?.message || err}`
      );
      cleanedRecords.push({
        batch_index: bi,
        attempted: details.length,
        matched: 0,
        error: err?.message || String(err),
      });
      continue;
    }

    for (const m of res.matches || []) {
      if (!m) continue;
      const li = (m.linkedin_url || '').toLowerCase();
      if (li) {
        matchedByLi.set(li, m);
        linkedin_returned += 1;
      }
      if (m.apollo_person_id) matchedById.set(m.apollo_person_id, m);
      if (m.email) credits_estimated += 1;
      cleanedRecords.push({
        apollo_person_id: m.apollo_person_id,
        linkedin_url: m.linkedin_url,
        email: m.email || null,
        email_status: m.email_status,
        email_confidence: m.email_confidence,
        matched: !!m.email || !!m.apollo_person_id,
      });
    }

    await sleep(SLEEP_APOLLO_MS);
  }

  // Apply matched data back into the input array (mutates copies, not originals).
  // Prefer the id-keyed match because all our discovery results are id-only;
  // fall back to linkedin lookup for any survivors that came in with a URL.
  // Crucially, when Apollo returns a LinkedIn URL we did not previously have,
  // we write it back into the survivor so downstream CONTACTS/CONTACTS_MASTER
  // rows get populated.
  const enriched = people.map((p) => {
    const id = p.apollo_person_id || '';
    const li = (p.linkedin_url || '').toLowerCase();
    const m = (id && matchedById.get(id)) || (li && matchedByLi.get(li)) || null;
    if (!m) return p;
    return {
      ...p,
      linkedin_url: m.linkedin_url || p.linkedin_url || '',
      email: m.email || p.email || '',
      email_status: m.email_status || p.email_status,
      email_confidence: m.email_confidence || p.email_confidence,
    };
  });

  return {
    enriched,
    matchedByLi,
    matchedById,
    credits_estimated,
    attempted_by_li,
    attempted_by_id_only,
    linkedin_returned,
    dump: cleanedRecords,
  };
}

/* ───────────────────────────── run ────────────────────────────────────── */

const report = {
  ok: false,
  run_id: runId,
  enrich_only: ENRICH_ONLY,
  per_kind_default_max: PER_KIND_DEFAULT_MAX,
  per_kind_priority_max: PER_KIND_PRIORITY_MAX,
  reveal_personal_emails: REVEAL_PERSONAL_EMAILS,
  bulk_match_batch: BULK_MATCH_BATCH,
  dump_dir: dumpDir,
  processed: 0,
  skipped_no_assets: 0,
  skipped_already_has_contacts: 0,
  contacts_created: 0,
  contacts_reused: 0,
  apollo_credits_estimated: 0,
  zero_result_jobs: [],
  errors: [],
  jobs: [],
};

try {
  const context = loadCandidateContext();
  const candidate = parseCandidateFromProfileYaml(context.profile);
  const priorityCompanies = loadPriorityCompanies();
  ensureDumpDir();

  /* ------------ read sheets ------------ */
  const shortlistRes = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'SHORTLIST!A1:K',
    })
  );
  const shortlistRows = shortlistRes.data.values || [];
  if (shortlistRows.length <= 1) {
    report.ok = true;
    report.note = 'No rows in SHORTLIST';
    report.google_api_metrics = getGoogleApiMetrics();
    dumpJson('run-summary.json', report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const slHeader = shortlistRows[0];
  const slIdx = {
    job_id: slHeader.indexOf('job_id'),
    pursue: slHeader.indexOf('pursue'),
    company: slHeader.indexOf('company'),
    role: slHeader.indexOf('role'),
  };

  const assetsRes = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'ASSETS!A1:N',
    })
  );
  const assetsRows = assetsRes.data.values || [];
  const assetsByJobId = new Map();
  if (assetsRows.length > 1) {
    const aHeader = assetsRows[0];
    const aIdx = {
      job_id: aHeader.indexOf('job_id'),
      jd_drive_link: aHeader.indexOf('jd_drive_link'),
      resume_summary: aHeader.indexOf('resume_summary'),
      email_drive_link: aHeader.indexOf('email_drive_link'),
      linkedin_invite_text: aHeader.indexOf('linkedin_invite_text'),
    };
    for (let i = 1; i < assetsRows.length; i++) {
      const r = assetsRows[i];
      const id = getCell(r, aIdx.job_id);
      if (!id) continue;
      assetsByJobId.set(id, {
        jd_drive_link: getCell(r, aIdx.jd_drive_link),
        resume_summary: getCell(r, aIdx.resume_summary),
        email_drive_link: getCell(r, aIdx.email_drive_link),
        linkedin_invite_text: getCell(r, aIdx.linkedin_invite_text),
      });
    }
  }

  const contactsRes = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'CONTACTS!A1:O',
    })
  );
  const contactsRows = contactsRes.data.values || [];
  const existingContactsByJob = new Map(); // job_id -> Set of contact_ids
  for (let i = 1; i < contactsRows.length; i++) {
    const r = contactsRows[i];
    const cid = getCell(r, 0);
    const jid = getCell(r, 1);
    if (!cid || !jid) continue;
    if (!existingContactsByJob.has(jid)) existingContactsByJob.set(jid, new Set());
    existingContactsByJob.get(jid).add(cid);
  }

  const masterRes = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'CONTACTS_MASTER!A1:L',
    })
  );
  const masterRows = masterRes.data.values || [];
  const masterByApolloId = new Map(); // apollo_person_id -> { rowIndex, contactId, master }
  const masterByLinkedIn = new Map(); // linkedin (lc) -> { rowIndex, contactId, master }
  const masterByEmail = new Map(); // email (lc) -> { rowIndex, contactId, master }
  const masterByContactId = new Map(); // contactId -> { rowIndex, master }
  for (let i = 1; i < masterRows.length; i++) {
    const r = masterRows[i];
    const cid = getCell(r, 0);
    const name = getCell(r, 3);
    const title = getCell(r, 4);
    const liRaw = getCell(r, 5);
    const emRaw = getCell(r, 6);
    const email_source = getCell(r, 7);
    const email_confidence = getCell(r, 8);
    const li = liRaw.toLowerCase();
    const em = emRaw.toLowerCase();
    const notes = getCell(r, 11);
    const apolloId = extractApolloIdFromNotes(notes);
    const rowIndex = i + 1;
    const master = {
      contact_id: cid,
      name,
      title,
      linkedin_url: liRaw,
      email: emRaw,
      email_source,
      email_confidence,
      apollo_person_id: apolloId,
    };
    if (cid) masterByContactId.set(cid, { rowIndex, master });
    if (apolloId) masterByApolloId.set(apolloId, { rowIndex, contactId: cid, master });
    if (li) masterByLinkedIn.set(li, { rowIndex, contactId: cid, master });
    if (em) masterByEmail.set(em, { rowIndex, contactId: cid, master });
  }

  /* ------------ Drive setup ------------ */
  const { rootFolder } = await getRootFolder();
  const sub = await ensureSubfolders(rootFolder.id);
  const bucketIdByName = new Map((sub.folders || []).map((f) => [f.name, f.id]));

  /* ------------ per-PURSUE iteration ------------ */
  let processedJobs = 0;
  for (let r = 1; r < shortlistRows.length; r++) {
    if (RUN_LIMIT > 0 && processedJobs >= RUN_LIMIT) break;
    const row = shortlistRows[r];
    const pursue = getCell(row, slIdx.pursue);
    if (pursue !== 'PURSUE') continue;

    const job_id = getCell(row, slIdx.job_id);
    const company = getCell(row, slIdx.company);
    const role = getCell(row, slIdx.role);
    if (!job_id || !company) continue;

    const assets = assetsByJobId.get(job_id);
    if (!assets) {
      report.skipped_no_assets++;
      continue;
    }

    const existingForJob = existingContactsByJob.get(job_id);
    if (!REGENERATE && existingForJob && existingForJob.size > 0) {
      report.skipped_already_has_contacts++;
      continue;
    }

    const priorityEntry = pickPriorityEntry(priorityCompanies, company);
    const cap = pickCapForCompany(priorityEntry);
    const domains = resolveApolloDomainsForCompany(company, priorityEntry);

    const jobReport = {
      job_id,
      company,
      role,
      domain: domains[0] || '',
      domains,
      cap_per_kind: cap,
      priority_company: !!priorityEntry,
      kind_counts: { RECRUITER: 0, HIRING_MANAGER: 0 },
      contacts_created: 0,
      contacts_reused: 0,
      apollo_credits_estimated: 0,
      zero_results: false,
      contacts: [],
      warnings: [],
      error: null,
    };

    try {
      if (!domains.length) {
        jobReport.warnings.push('No domain resolved (priority-yaml missing and guess failed); skipping.');
        report.processed++;
        processedJobs++;
        report.jobs.push(jobReport);
        continue;
      }

      /* ---- Build the exact api_search query objects we will hit. ----
         We capture these once so the cURLs we dump are byte-identical to the
         live request the script makes (one source of truth via
         `buildApiSearchQuery`). */
      const recruiterParams = buildApiSearchQuery({
        domains,
        titles: RECRUITER_TITLES,
        locations: PERSON_LOCATIONS,
        emailStatuses: CONTACT_EMAIL_STATUS,
      });
      const hmParams = buildApiSearchQuery({
        domains,
        titles: roleToHmTitleKeywords(role),
        seniorities: HM_SENIORITIES,
        locations: PERSON_LOCATIONS,
        emailStatuses: CONTACT_EMAIL_STATUS,
      });

      /* ---- Apollo discovery: recruiter pass ---- */
      const recruiters = await paginateApiSearch({
        domains,
        titles: RECRUITER_TITLES,
        seniorities: undefined,
        kind: 'RECRUITER',
        cap,
      });
      await sleep(SLEEP_APOLLO_MS);

      /* ---- Apollo discovery: hiring-manager pass (titles + seniority) ---- */
      const hms = await paginateApiSearch({
        domains,
        titles: roleToHmTitleKeywords(role),
        seniorities: HM_SENIORITIES,
        kind: 'HIRING_MANAGER',
        cap,
      });
      await sleep(SLEEP_APOLLO_MS);

      if (recruiters.length < PER_KIND_MIN) {
        jobReport.warnings.push(
          `Recruiter count (${recruiters.length}) below soft floor (${PER_KIND_MIN}).`
        );
      }
      if (hms.length < PER_KIND_MIN) {
        jobReport.warnings.push(
          `Hiring-manager count (${hms.length}) below soft floor (${PER_KIND_MIN}).`
        );
      }

      const zeroResults = recruiters.length === 0 && hms.length === 0;
      jobReport.zero_results = zeroResults;
      if (zeroResults) {
        report.zero_result_jobs.push({ job_id, company, domain: domains[0] || '', domains });
      }

      const allCandidatesRaw = [...recruiters, ...hms];

      /* ---- Dump search results (every person we discovered).
         We always include `apollo_request_params` and `curl_examples` so a
         human can replay either pass with a copy/paste — same dump shape on
         healthy and zero-result runs (no special-case branching). */
      const searchDump = allCandidatesRaw.map((p) => ({
        apollo_person_id: p.apollo_person_id,
        name: p.name,
        first_name: p.first_name,
        title: p.title,
        seniority: p.seniority,
        departments: p.departments,
        linkedin_url: p.linkedin_url,
        organization: p.organization,
        kind: p.kind,
        email_status_in_search: p.email_status,
      }));
      dumpJson(`${job_id}-search.json`, {
        job_id,
        company,
        role,
        domain: domains[0] || '',
        domains,
        cap_per_kind: cap,
        priority_company: !!priorityEntry,
        recruiter_count: recruiters.length,
        hm_count: hms.length,
        zero_results: zeroResults,
        apollo_request_params: {
          recruiter: recruiterParams,
          hiring_manager: hmParams,
        },
        curl_examples: {
          recruiter: buildCurlExample(recruiterParams),
          hiring_manager: buildCurlExample(hmParams),
        },
        people: searchDump,
      });

      /* ---- Dedup vs CONTACTS_MASTER + already-seen-this-run ---- */
      const seenInRun = new Set();
      const survivors = [];
      const skippedExisting = [];
      for (const cand of allCandidatesRaw) {
        const apolloId = cand.apollo_person_id || '';
        const liKey = (cand.linkedin_url || '').toLowerCase();
        const emKey = (cand.email || '').toLowerCase();

        let existingMaster = null;
        if (apolloId && masterByApolloId.has(apolloId)) existingMaster = masterByApolloId.get(apolloId);
        else if (liKey && masterByLinkedIn.has(liKey)) existingMaster = masterByLinkedIn.get(liKey);
        else if (emKey && masterByEmail.has(emKey)) existingMaster = masterByEmail.get(emKey);

        const runKey = dedupKey(cand);
        if (seenInRun.has(runKey)) continue;
        seenInRun.add(runKey);

        if (existingMaster && existingMaster.contactId) {
          skippedExisting.push({ cand, existingMaster });
        } else {
          survivors.push(cand);
        }
      }

      /* ---- bulk_match for net-new without email ----
         `mixed_people/api_search` always returns apollo_person_id but never
         linkedin_url (confirmed empirically via scripts/diagnostics/apollo-bulkmatch-diag.mjs).
         So the gate must accept id-only survivors; the inner bulkMatchPeople
         already handles `id`. Apollo's `bulk_match` returns linkedin_url +
         email when matched by id, which we write back into the survivor so
         CONTACTS / CONTACTS_MASTER columns get populated downstream. */
      const needEmail = survivors.filter(
        (p) => !p.email && (p.linkedin_url || p.apollo_person_id)
      );
      let enrichedSurvivors = survivors;
      let bulkDump = [];
      let creditsEstimated = 0;
      let bulkAttemptedByLi = 0;
      let bulkAttemptedByIdOnly = 0;
      let bulkLinkedinReturned = 0;
      if (needEmail.length > 0) {
        const out = await bulkMatchInBatches(needEmail, jobReport);
        // Prefer id-keyed match (every discovery result has an id); fall back
        // to linkedin for survivors that came in with a URL from elsewhere.
        enrichedSurvivors = survivors.map((p) => {
          const id = p.apollo_person_id || '';
          const li = (p.linkedin_url || '').toLowerCase();
          const m =
            (id && out.matchedById.get(id)) ||
            (li && out.matchedByLi.get(li)) ||
            null;
          if (!m) return p;
          return {
            ...p,
            linkedin_url: m.linkedin_url || p.linkedin_url || '',
            email: m.email || p.email || '',
            email_status: m.email_status || p.email_status,
            email_confidence: m.email_confidence || p.email_confidence,
          };
        });
        bulkDump = out.dump;
        creditsEstimated = out.credits_estimated;
        bulkAttemptedByLi = out.attempted_by_li;
        bulkAttemptedByIdOnly = out.attempted_by_id_only;
        bulkLinkedinReturned = out.linkedin_returned;
      }

      // Single-person fallback for survivors that bulk_match didn't fill in.
      // Accepts id-only candidates too — `enrichPerson` now forwards
      // `apolloPersonId` as `body.id` to `/people/match`.
      for (let i = 0; i < enrichedSurvivors.length; i++) {
        const p = enrichedSurvivors[i];
        if (p.email || (!p.linkedin_url && !p.apollo_person_id)) continue;
        try {
          const enriched = await enrichPerson({
            apolloPersonId: p.apollo_person_id,
            linkedinUrl: p.linkedin_url,
            name: p.name,
            organizationName: p.organization?.name,
            revealPersonalEmails: REVEAL_PERSONAL_EMAILS,
          });
          if (enriched && enriched.email) {
            enrichedSurvivors[i] = { ...p, ...enriched, kind: p.kind };
            creditsEstimated += 1;
            bulkDump.push({
              apollo_person_id: enriched.apollo_person_id,
              linkedin_url: enriched.linkedin_url,
              email: enriched.email,
              email_status: enriched.email_status,
              email_confidence: enriched.email_confidence,
              matched: true,
              source: 'people/match-fallback',
            });
          }
        } catch (e) {
          jobReport.warnings.push(
            `enrichPerson fallback failed for ${p.name || '(unknown)'}: ${e?.message || e}`
          );
        }
        await sleep(SLEEP_APOLLO_MS);
      }

      jobReport.apollo_credits_estimated = creditsEstimated;
      report.apollo_credits_estimated += creditsEstimated;

      dumpJson(`${job_id}-bulkmatch.json`, {
        job_id,
        company,
        role,
        attempted: needEmail.length,
        attempted_by_li: bulkAttemptedByLi,
        attempted_by_id_only: bulkAttemptedByIdOnly,
        linkedin_returned: bulkLinkedinReturned,
        matched_with_email: bulkDump.filter((d) => d.email).length,
        records: bulkDump,
      });

      /* ---- Stage 2 outreach reuse: load email + LI invite once per job ---- */
      const stage2Email = await loadStage2Email(assets, jobReport);
      const stage2InviteText = String(assets.linkedin_invite_text || '').trim();

      /* ---- Drive helper for per-contact email (lazy) ---- */
      const companyFolderName = slugifyFolderName(company);
      const jobFolderName = slugifyFolderName(`${date}_${job_id}`);
      const writePerContactEmail = async (filename, contents) => {
        const bucketId = bucketIdByName.get('EMAIL');
        if (!bucketId) throw new Error('Missing Drive bucket: EMAIL');
        const { folderId } = await ensureFolderPath(bucketId, [companyFolderName, jobFolderName]);
        const f = await createTextFile(folderId, filename, contents);
        return f.webViewLink;
      };

      /* ---- emit existing-master contacts straight into CONTACTS (reuse) ---- */
      const contactsRowsDump = [];

      // Per-job accumulators. Sheets writes are deferred so we make at most
      // 3 API calls per job (CONTACTS append, CONTACTS_MASTER append for
      // creates, CONTACTS_MASTER batch update for reused last-seen) instead
      // of ~2 per contact. At ~80 contacts × 40 PURSUE jobs that's
      // 6,400 → 120 sheets writes.
      const pendingContactsRows = [];
      const pendingMasterCreates = [];
      const pendingMasterUpdates = []; // { range, values }

      for (const { cand, existingMaster } of skippedExisting) {
        const contact_id = existingMaster.contactId;
        const seenForJob = existingContactsByJob.get(job_id);
        if (!REGENERATE && seenForJob && seenForJob.has(contact_id)) {
          jobReport.contacts.push({ contact_id, kind: cand.kind, status: 'skipped_existing_in_job' });
          continue;
        }
        const m = existingMaster.master || {};
        const hydrated = {
          ...cand,
          name: cand.name || m.name || '',
          first_name: cand.first_name || (m.name ? m.name.split(/\s+/)[0] : ''),
          title: cand.title || m.title || '',
          linkedin_url: cand.linkedin_url || m.linkedin_url || '',
          email: cand.email || m.email || '',
          email_source: cand.email_source || m.email_source || (cand.email || m.email ? 'apollo' : ''),
          email_confidence:
            cand.email_confidence ||
            m.email_confidence ||
            (cand.email || m.email ? 'high' : ''),
          apollo_person_id: cand.apollo_person_id || m.apollo_person_id || '',
        };
        const built = await buildAndAppendContact({
          person: hydrated,
          contact_id,
          isMasterCreate: false,
          existingMasterRowIndex: existingMaster.rowIndex,
          stage2Email,
          stage2InviteText,
          candidate,
          writePerContactEmail,
          jobReport,
          job_id,
          company,
          role,
          contactsRowsDump,
          existingContactsByJob,
          masterByApolloId,
          masterByLinkedIn,
          masterByEmail,
          masterByContactId,
          pendingContactsRows,
          pendingMasterCreates,
          pendingMasterUpdates,
        });
        if (built === 'reused') {
          report.contacts_reused++;
          jobReport.contacts_reused++;
        }
      }

      /* ---- create new contacts for survivors ---- */
      for (const person of enrichedSurvivors) {
        const contact_id = makeContactId({
          apollo_person_id: person.apollo_person_id,
          linkedin_url: person.linkedin_url,
          email: person.email,
          organizationName: person.organization?.name || company,
          name: person.name,
          title: person.title,
        });
        const seenForJob = existingContactsByJob.get(job_id);
        if (!REGENERATE && seenForJob && seenForJob.has(contact_id)) {
          jobReport.contacts.push({ contact_id, kind: person.kind, status: 'skipped_existing_in_job' });
          continue;
        }

        const isMasterCreate = !masterByContactId.has(contact_id);
        const built = await buildAndAppendContact({
          person,
          contact_id,
          isMasterCreate,
          existingMasterRowIndex: null,
          stage2Email,
          stage2InviteText,
          candidate,
          writePerContactEmail,
          jobReport,
          job_id,
          company,
          role,
          contactsRowsDump,
          existingContactsByJob,
          masterByApolloId,
          masterByLinkedIn,
          masterByEmail,
          masterByContactId,
          pendingContactsRows,
          pendingMasterCreates,
          pendingMasterUpdates,
        });
        if (built === 'created') {
          report.contacts_created++;
          jobReport.contacts_created++;
        } else if (built === 'reused') {
          report.contacts_reused++;
          jobReport.contacts_reused++;
        }
      }

      /* ---- flush per-job sheet writes in batches ---- */
      try {
        if (pendingContactsRows.length) {
          await appendRows('CONTACTS', pendingContactsRows);
        }
        if (pendingMasterCreates.length) {
          await appendRows('CONTACTS_MASTER', pendingMasterCreates);
        }
        if (pendingMasterUpdates.length) {
          await updateRanges(pendingMasterUpdates, 'RAW');
        }
      } catch (flushErr) {
        jobReport.warnings.push(
          `Batched sheet flush failed: ${flushErr?.message || flushErr}`
        );
      }

      dumpJson(`${job_id}-contacts-rows.json`, {
        job_id,
        company,
        role,
        rows: contactsRowsDump,
      });

      report.processed++;
      processedJobs++;
      report.jobs.push(jobReport);
    } catch (err) {
      jobReport.error = err?.message || String(err);
      report.errors.push({ job_id, company, role, error: jobReport.error });
      report.jobs.push(jobReport);
      processedJobs++;
    }
  }

  report.ok = report.errors.length === 0 || report.processed > 0;
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

// Snapshot CONTACTS_MASTER to disk so it can be rebuilt after cleanup.
try {
  const masterSnapRes = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'CONTACTS_MASTER!A1:L',
    })
  );
  const values = masterSnapRes.data.values || [];
  const payload = {
    fetched_at: new Date().toISOString(),
    run_id: runId,
    values,
  };
  const historyPath = writeSnapshot(`contacts-master-${runId}.json`, payload);
  const latestPath = writeSnapshot('contacts-master-latest.json', payload);
  report.contacts_master_snapshot = {
    ok: true,
    path: latestPath,
    history_path: historyPath,
    rows: Math.max(0, values.length - 1),
  };
} catch (err) {
  report.contacts_master_snapshot = { ok: false, error: err?.message || String(err) };
}

report.google_api_metrics = getGoogleApiMetrics();
dumpJson('run-summary.json', report);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

/* ───────────────────────────── inner helpers ──────────────────────────── */

/**
 * Reads Stage 2's outreach email file from Drive (using `assets.email_drive_link`)
 * and parses it back into `{ subject, body }`. Returns `null` if the link is
 * missing or the export fails — in which case Stage 3 still appends the
 * CONTACTS row but skips the per-contact Drive email file (with a warning).
 */
async function loadStage2Email(assets, jobReport) {
  const link = String(assets?.email_drive_link || '').trim();
  if (!link) {
    jobReport.warnings.push('No ASSETS.email_drive_link; per-contact emails will be skipped.');
    return null;
  }
  const fileId = parseDriveFileId(link);
  if (!fileId) {
    jobReport.warnings.push(`Could not parse Drive file id from ASSETS.email_drive_link: ${link}`);
    return null;
  }
  try {
    const text = await exportFileUtf8(fileId);
    const { subject, body } = parseEmailFileText(text);
    if (!body) {
      jobReport.warnings.push('Stage 2 email body was empty after parsing.');
      return null;
    }
    return { subject, body };
  } catch (err) {
    jobReport.warnings.push(`Failed to read Stage 2 email from Drive: ${err?.message || err}`);
    return null;
  }
}

async function buildAndAppendContact({
  person,
  contact_id,
  isMasterCreate,
  existingMasterRowIndex,
  stage2Email,
  stage2InviteText,
  candidate,
  writePerContactEmail,
  jobReport,
  job_id,
  company,
  role,
  contactsRowsDump,
  existingContactsByJob,
  masterByApolloId,
  masterByLinkedIn,
  masterByEmail,
  masterByContactId,
  pendingContactsRows,
  pendingMasterCreates,
  pendingMasterUpdates,
}) {
  const firstName = person.first_name || (person.name ? person.name.split(/\s+/)[0] : '') || '';

  /* per-contact email file (reuse Stage 2 body, swap salutation).
     We only write a Drive file when we actually have an email address for
     the contact — otherwise the file is unreachable (no inbox to send to)
     and we end up with hundreds of stale Drive files per run. LinkedIn
     invites are still emitted unconditionally below. */
  let emailLink = '';
  if (stage2Email && person.email) {
    try {
      const swappedBody = swapSalutation(stage2Email.body, firstName);
      // Re-apply the deterministic signature in case Stage 2's body was older
      // than the post-process update; this is idempotent.
      const finalBody = applyDeterministicEmailSignature(swappedBody, candidate || {});
      emailLink = await writePerContactEmail(
        `email-${job_id}-${contact_id}.txt`,
        formatEmailFile({ subject: stage2Email.subject || `Interest in ${role}`, body: finalBody })
      );
    } catch (err) {
      jobReport.warnings.push(
        `Per-contact email Drive write failed for ${person.name || '(unknown)'}: ${err?.message || err}`
      );
    }
  }

  /* per-contact LinkedIn invite (reuse Stage 2 invite, swap [Name]) */
  const inviteText = swapInviteName(stage2InviteText, firstName);

  /* CONTACTS row (15 cols) */
  const contactsRow = [
    contact_id,
    job_id,
    company,
    role,
    person.kind,
    person.name || '',
    person.title || '',
    person.linkedin_url || '',
    person.email || '',
    person.email ? person.email_source || 'apollo' : '',
    person.email ? person.email_confidence || '' : '',
    emailLink,
    inviteText,
    'NEW',
    person.apollo_person_id ? `apollo_person_id=${person.apollo_person_id}` : '',
  ];
  pendingContactsRows.push(contactsRow);
  contactsRowsDump.push({
    contact_id,
    job_id,
    company,
    role,
    contact_kind: person.kind,
    contact_name: person.name || '',
    contact_title: person.title || '',
    linkedin_url: person.linkedin_url || '',
    email: person.email || '',
    email_drive_link: emailLink,
    apollo_person_id: person.apollo_person_id || '',
  });

  /* CONTACTS_MASTER upsert (12 cols) */
  if (isMasterCreate) {
    const masterRow = [
      contact_id,
      person.organization?.name || company,
      person.kind === 'HIRING_MANAGER'
        ? (person.departments || []).join(', ')
        : 'Talent Acquisition',
      person.name || '',
      person.title || '',
      person.linkedin_url || '',
      person.email || '',
      person.email ? person.email_source || 'apollo' : '',
      person.email ? person.email_confidence || '' : '',
      iso,
      job_id,
      [
        person.apollo_person_id ? `apollo_person_id=${person.apollo_person_id}` : '',
        `kind=${person.kind}`,
      ]
        .filter(Boolean)
        .join('; '),
    ];
    pendingMasterCreates.push(masterRow);
    // Keep dedup maps consistent for further candidates in this run. The
    // batched flush comes after both loops, so subsequent candidates in the
    // same job must see this contact_id as already-claimed.
    const master = {
      contact_id,
      name: person.name || '',
      title: person.title || '',
      linkedin_url: person.linkedin_url || '',
      email: person.email || '',
      email_source: person.email ? person.email_source || 'apollo' : '',
      email_confidence: person.email ? person.email_confidence || '' : '',
      apollo_person_id: person.apollo_person_id || '',
    };
    masterByContactId.set(contact_id, { rowIndex: -1, master });
    if (person.apollo_person_id)
      masterByApolloId.set(person.apollo_person_id, { rowIndex: -1, contactId: contact_id, master });
    if (person.linkedin_url)
      masterByLinkedIn.set(person.linkedin_url.toLowerCase(), {
        rowIndex: -1,
        contactId: contact_id,
        master,
      });
    if (person.email)
      masterByEmail.set(person.email.toLowerCase(), { rowIndex: -1, contactId: contact_id, master });
  } else if (existingMasterRowIndex && existingMasterRowIndex > 0) {
    // Queue last-seen / last-job-id update; flushed via values.batchUpdate.
    pendingMasterUpdates.push({
      range: `CONTACTS_MASTER!J${existingMasterRowIndex}:K${existingMasterRowIndex}`,
      values: [[iso, job_id]],
    });
  }

  /* track for further dedup in this run */
  if (!existingContactsByJob.has(job_id)) existingContactsByJob.set(job_id, new Set());
  existingContactsByJob.get(job_id).add(contact_id);

  jobReport.kind_counts[person.kind] = (jobReport.kind_counts[person.kind] || 0) + 1;
  jobReport.contacts.push({
    contact_id,
    kind: person.kind,
    name: person.name || '',
    title: person.title || '',
    apollo_person_id: person.apollo_person_id || '',
    email: person.email || '',
    email_confidence: person.email ? person.email_confidence || '' : 'unavailable',
    email_drive_link: emailLink,
  });

  return isMasterCreate ? 'created' : 'reused';
}
