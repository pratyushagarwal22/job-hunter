#!/usr/bin/env node
/**
 * sync-report-to-command-center.mjs
 *
 * Reads jobhunt/ai-test/output/last-report.json (from npm run jobhunt:ai-score-urls),
 * re-fetches each job URL for a fresh JD text file, uploads JDS + CONTEXT to Drive,
 * appends INBOX_RAW for every successfully scored row, and SHORTLIST when
 * match_score >= E2E_PROMOTION_THRESHOLD (same 6.0 default as seed-8).
 *
 * Does not modify seed-8 / stage2 scripts. Idempotency: skips URLs already present
 * in INBOX_RAW (column `url` match) to avoid duplicate rows on re-run.
 *
 *   npm run jobhunt:ai-sync-sheets
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { loadDotenv } from '../../integrations/google/env.mjs';
import { appendRow, reapplyShortlistPursueDropdown } from '../../integrations/google/sheets.mjs';
import { getSheetsClient } from '../../integrations/google/auth.mjs';
import { normalizeGoogleSheetId, requireEnv } from '../../integrations/google/env.mjs';
import { getRootFolder, ensureSubfolders, ensureFolderPath, createTextFile } from '../../integrations/google/drive.mjs';
import { makeJobId, slugifyFolderName, ymd } from '../ids.mjs';
import { E2E_PROMOTION_THRESHOLD } from '../match-score-demo.mjs';
import { fetchJobPagePlainText } from './fetch-job-page-text.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPORT = join(__dirname, 'output', 'last-report.json');

function parseCompanyRole(pageTitle, url) {
  const t = (pageTitle || '').trim();
  let m = t.match(/^(.+?)\s+at\s+(.+)$/i);
  if (m) return { role: m[1].trim(), company: m[2].trim() };
  // Pipe-delimited titles (common on enterprise sites):
  // "Role | Team/Org | Company Careers" → role = first segment, company = last segment
  if (t.includes('|')) {
    const parts = t.split('|').map((p) => p.trim()).filter(Boolean);
    const role = parts[0] || t;
    const last = parts[parts.length - 1] || '';
    const company = last.replace(/\s*Careers?\s*$/i, '').trim() || last || t;
    return { role, company };
  }
  m = t.match(/^(.+?)\s*-\s*(.+)$/);
  if (m) return { role: m[2].trim(), company: m[1].trim() };
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return { role: t || 'Unknown role', company: host };
  } catch {
    return { role: t || 'Unknown role', company: 'Unknown company' };
  }
}

async function loadExistingInboxUrls() {
  const sheets = await getSheetsClient();
  const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'INBOX_RAW!A1:G5000',
  });
  const rows = res.data.values || [];
  const urls = new Set();
  for (let i = 1; i < rows.length; i++) {
    const u = rows[i] && rows[i][6] ? String(rows[i][6]).trim() : '';
    if (u) urls.add(u);
  }
  return urls;
}

await loadDotenv();

const reportPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : DEFAULT_REPORT;
if (!existsSync(reportPath)) {
  console.error(JSON.stringify({ ok: false, error: `Missing report: ${reportPath}` }, null, 2));
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
const threshold = E2E_PROMOTION_THRESHOLD;
const now = new Date();
const date = ymd(now);
const iso = now.toISOString();

const out = {
  ok: true,
  threshold,
  reportPath,
  inbox_appended: 0,
  shortlist_appended: 0,
  skipped_duplicate_url: 0,
  skipped_not_scored: 0,
  errors: [],
};

const existingUrls = await loadExistingInboxUrls();

const { rootFolder } = await getRootFolder();
const sub = await ensureSubfolders(rootFolder.id);
const bucketIdByName = new Map((sub.folders || []).map((f) => [f.name, f.id]));

for (const row of report.results || []) {
  const url = row.url;
  if (!url) continue;
  if (!row.fetch_ok || row.ok !== true || typeof row.match_score !== 'number') {
    out.skipped_not_scored++;
    continue;
  }
  if (existingUrls.has(url)) {
    out.skipped_duplicate_url++;
    continue;
  }

  const { company, role } = parseCompanyRole(row.page_title, url);
  const job = {
    source: 'AI_URL_REPORT',
    company,
    role,
    location: 'N/A',
    url,
    match_score: String(row.match_score),
  };
  const job_id = makeJobId(job);
  const companyFolderName = slugifyFolderName(company);
  const jobFolderName = slugifyFolderName(`${date}_${job_id}`);

  const writeInBucket = async (bucketName, filename, contents) => {
    const bucketId = bucketIdByName.get(bucketName);
    if (!bucketId) throw new Error(`Missing Drive bucket: ${bucketName}`);
    const { folderId } = await ensureFolderPath(bucketId, [companyFolderName, jobFolderName]);
    const f = await createTextFile(folderId, filename, contents);
    return f.webViewLink;
  };

  try {
    const fetched = await fetchJobPagePlainText(url);
    if (!fetched.ok) {
      out.errors.push({ url, step: 'fetch', error: fetched.error });
      continue;
    }

    const jdBody = `JD captured for Command Center sync\nurl=${url}\npage_title=${row.page_title || ''}\nmatch_score=${row.match_score}\n\n---\n\n${fetched.text}`;
    const jdLink = await writeInBucket('JDS', `jd-${job_id}.txt`, jdBody);
    const ctxLink = await writeInBucket(
      'CONTEXT',
      `context-${job_id}.json`,
      JSON.stringify(
        {
          job_id,
          url,
          match_score: row.match_score,
          rationale: (row.rationale || '').slice(0, 4000),
          page_quality: row.page_quality || '',
          synced_at: iso,
        },
        null,
        2
      ) + '\n'
    );

    const notes = String(row.rationale || '').replace(/\s+/g, ' ').trim().slice(0, 480);

    await appendRow('INBOX_RAW', [
      job_id,
      job.source,
      iso,
      company,
      role,
      'N/A',
      url,
      jdLink,
      String(row.match_score),
      'NEW',
      notes,
    ]);
    out.inbox_appended++;
    existingUrls.add(url);

    if (row.match_score >= threshold) {
      await appendRow('SHORTLIST', [
        job_id,
        '',
        company,
        role,
        'N/A',
        url,
        jdLink,
        String(row.match_score),
        'SHORTLISTED',
        'P2',
        `AI sync | promoted (score>=${threshold})`,
      ]);
      out.shortlist_appended++;
    }

    await new Promise((r) => setTimeout(r, 600));
  } catch (err) {
    out.errors.push({ url, step: 'sync', error: err?.message || String(err) });
  }
}

await reapplyShortlistPursueDropdown();

console.log(JSON.stringify(out, null, 2));
process.exit(out.errors.length > 0 ? 1 : 0);
