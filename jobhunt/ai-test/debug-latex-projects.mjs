#!/usr/bin/env node
/**
 * debug-latex-projects.mjs
 *
 * Prints a quick report for the latest ASSETS rows:
 * - Whether resume .tex contains GitHub links in Projects headings
 * - Whether there are likely overfull/overflow lines in the Projects section
 *
 * Usage:
 *   node jobhunt/ai-test/debug-latex-projects.mjs [N]
 */

import process from 'node:process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDotenv, requireEnv } from '../../integrations/google/env.mjs';
import { getSheetsClient } from '../../integrations/google/auth.mjs';
import { normalizeGoogleSheetId } from '../../integrations/google/env.mjs';
import { parseDriveFileId, exportFileUtf8 } from '../../integrations/google/drive.mjs';
import { withGoogleApi } from '../../integrations/google/rate-limit.mjs';

await loadDotenv();

const N = Math.max(1, Math.min(25, Number(process.argv[2] || 10)));
const sheets = await getSheetsClient();
const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));

const res = await withGoogleApi('sheetsRead', () =>
  sheets.spreadsheets.values.get({ spreadsheetId, range: 'ASSETS!A1:N2000' })
);
const rows = res.data.values || [];
if (rows.length <= 1) {
  console.log(JSON.stringify({ ok: true, note: 'No ASSETS rows' }, null, 2));
  process.exit(0);
}

const header = rows[0];
const idx = {
  job_id: header.indexOf('job_id'),
  company: header.indexOf('company'),
  role: header.indexOf('role'),
  resume: header.indexOf('resume_drive_link'),
  context: header.indexOf('context_drive_link'),
};

function getCell(row, i) {
  return row && i >= 0 && row[i] != null ? String(row[i]).trim() : '';
}

function extractProjectsSection(tex) {
  const start = tex.indexOf('\\section{Projects}');
  if (start === -1) return null;
  const rest = tex.slice(start);
  const after = rest.slice('\\section{Projects}'.length);
  const nextOffset = after.search(/\\section\{/);
  const end = nextOffset === -1 ? tex.length : start + '\\section{Projects}'.length + nextOffset;
  return tex.slice(start, end);
}

function guessOverflowLines(section) {
  const lines = section.split('\n');
  const long = [];
  for (const l of lines) {
    const raw = l.trim();
    if (!raw) continue;
    // heuristic: very long line with LaTeX content often indicates unbreakable hbox risk
    if (raw.length >= 170) long.push(raw.slice(0, 220));
  }
  return long.slice(0, 5);
}

const tail = rows.slice(-N);
const report = { ok: true, rows: [] };

for (const row of tail) {
  const job_id = getCell(row, idx.job_id);
  const company = getCell(row, idx.company);
  const role = getCell(row, idx.role);
  const ctxLink = getCell(row, idx.context);
  const resumeLink = getCell(row, idx.resume);

  const out = { job_id, company, role, resumeLink, ctxLink, ok: false };
  try {
    const ctxId = parseDriveFileId(ctxLink);
    if (!ctxId) throw new Error('Could not parse context file id');
    const ctxRaw = await exportFileUtf8(ctxId);
    const ctx = JSON.parse(ctxRaw);
    const tex = ctx?.generated_assets?.resume || ctx?.generated_assets?.resume_tex || '';
    if (!tex) throw new Error('No generated_assets.resume (or legacy resume_tex) in context pack');

    const projects = extractProjectsSection(tex);
    out.hasProjects = Boolean(projects);
    out.hasGitHub = projects ? /\[GitHub\]/.test(projects) : false;
    out.hasProjectHeadingLinksMacro = projects ? /\\resumeProjectHeadingLinks\{/.test(projects) : false;
    out.overflowHints = projects ? guessOverflowLines(projects) : [];
    out.ok = true;
  } catch (err) {
    out.error = err?.message || String(err);
  }
  report.rows.push(out);
}

// write a temp file so user can share quickly if needed
const dir = mkdtempSync(join(tmpdir(), 'career-ops-debug-'));
const outPath = join(dir, 'debug-assets-projects.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

console.log(JSON.stringify({ ok: true, wrote: outPath, report }, null, 2));
