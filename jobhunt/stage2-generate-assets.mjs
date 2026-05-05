#!/usr/bin/env node
/**
 * stage2-generate-assets.mjs
 *
 * Reads SHORTLIST and generates assets ONLY for rows with pursue == "PURSUE".
 * Loads cv.md + profile.yml + article-digest.md; Claude fills templates/cv-template.tex
 * using jobhunt/lib/resume-canonical.json for fixed titles and URLs.
 * Resume PDF has no summary; plain-text summary is written to ASSETS.resume_summary (see generateResumeSummaryForSheet).
 *
 * Usage:
 *   npm run jobhunt:stage2
 *
 * Regenerate existing ASSETS rows:
 *   JOBHUNT_REGENERATE_ASSETS=1 npm run jobhunt:stage2
 */

import { loadDotenv } from '../integrations/google/env.mjs';
import { getSheetsClient } from '../integrations/google/auth.mjs';
import { normalizeGoogleSheetId, requireEnv } from '../integrations/google/env.mjs';
import { appendRow } from '../integrations/google/sheets.mjs';
import { withGoogleApi, getGoogleApiMetrics } from '../integrations/google/rate-limit.mjs';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getRootFolder,
  ensureSubfolders,
  ensureFolderPath,
  createTextFile,
  parseDriveFileId,
  exportFileUtf8,
  uploadFileFromPath,
} from '../integrations/google/drive.mjs';
import { createAnthropicClient } from '../integrations/anthropic/config.mjs';
import { slugifyFolderName, ymd } from './ids.mjs';
import { loadCandidateContext } from './lib/candidate-context.mjs';
import {
  generateResumeTex,
  generateResumeSummaryForSheet,
  generateCoverLetter,
  generateOutreachEmail,
  generateLinkedInInvite,
  formatEmailFile,
} from './lib/claude-asset-generators.mjs';

await loadDotenv();

const sheets = await getSheetsClient();
const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));

const now = new Date();
const date = ymd(now);

function getCell(row, idx) {
  return row && idx >= 0 && row[idx] != null ? String(row[idx]).trim() : '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tryCompileLatexToPdf(texSource) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-resume-'));
  const texPath = join(dir, 'resume.tex');
  const pdfPath = join(dir, 'resume.pdf');
  writeFileSync(texPath, texSource, 'utf-8');

  let compileReport = null;
  try {
    const stdout = execFileSync('node', ['generate-latex.mjs', texPath, pdfPath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      compileReport = JSON.parse(String(stdout || '').trim());
    } catch {
      compileReport = { ok: false, error: 'Could not parse generate-latex JSON', raw: String(stdout || '').slice(0, 1000) };
    }
  } catch (err) {
    const out = err?.stdout ? String(err.stdout) : '';
    try {
      compileReport = JSON.parse(out.trim());
    } catch {
      compileReport = { ok: false, error: err?.message || String(err), raw: out.slice(0, 1200) };
    }
    return { ok: false, dir, compileReport };
  }

  if (!existsSync(pdfPath)) return { ok: false, dir, compileReport };
  if (compileReport && compileReport.compiled === false) return { ok: false, dir, compileReport };
  return { ok: true, dir, pdfPath, compileReport };
}

function latexErrorContext(texPath, compileReport) {
  try {
    const err = String(compileReport?.compileError || '');
    const m = err.match(/:(\d+):/);
    const line = m ? Number(m[1]) : null;
    if (!line || Number.isNaN(line)) return null;
    const src = readFileSync(texPath, 'utf-8').split('\n');
    const start = Math.max(1, line - 4);
    const end = Math.min(src.length, line + 4);
    const snippet = [];
    for (let i = start; i <= end; i++) snippet.push(`${i}|${src[i - 1]}`);
    return { line, start, end, snippet: snippet.join('\n') };
  } catch {
    return null;
  }
}

const report = {
  ok: false,
  processed: 0,
  skipped: 0,
  alreadyHadAssets: 0,
  assetsCreated: [],
  errors: [],
};

try {
  const context = loadCandidateContext();
  let client = null;

  const REGENERATE = String(process.env.JOBHUNT_REGENERATE_ASSETS || '').trim() === '1';

  const existingAssets = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({ spreadsheetId, range: 'ASSETS!A1:A' })
  );
  const existingAssetRows = existingAssets.data.values || [];
  const existingJobIdToRow = new Map();
  for (let i = 1; i < existingAssetRows.length; i++) {
    const id = existingAssetRows[i] && existingAssetRows[i][0] ? String(existingAssetRows[i][0]).trim() : '';
    if (!id) continue;
    existingJobIdToRow.set(id, i + 1);
  }
  const existingJobIds = new Set(existingJobIdToRow.keys());

  const res = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({ spreadsheetId, range: 'SHORTLIST!A1:K' })
  );
  const rows = res.data.values || [];
  if (rows.length <= 1) {
    report.ok = true;
    report.note = 'No rows in SHORTLIST';
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const header = rows[0];
  const idx = {
    job_id: header.indexOf('job_id'),
    pursue: header.indexOf('pursue'),
    company: header.indexOf('company'),
    role: header.indexOf('role'),
    jd_drive_link: header.indexOf('jd_drive_link'),
    match_score: header.indexOf('match_score'),
  };

  const { rootFolder } = await getRootFolder();
  const sub = await ensureSubfolders(rootFolder.id);
  const bucketIdByName = new Map((sub.folders || []).map((f) => [f.name, f.id]));

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const pursue = getCell(row, idx.pursue);
    if (pursue !== 'PURSUE') {
      report.skipped++;
      continue;
    }

    const job_id = getCell(row, idx.job_id);
    if (!REGENERATE && existingJobIds.has(job_id)) {
      report.alreadyHadAssets++;
      continue;
    }

    const company = getCell(row, idx.company);
    const role = getCell(row, idx.role);
    const jdLink = getCell(row, idx.jd_drive_link);
    const matchScore = getCell(row, idx.match_score);

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
      if (!client) client = createAnthropicClient();

      const fileId = parseDriveFileId(jdLink);
      if (!fileId) {
        throw new Error(`Could not parse Drive file id from jd_drive_link: ${jdLink}`);
      }
      let jdText = await exportFileUtf8(fileId);
      jdText = jdText.replace(/\r\n/g, '\n').trim();
      if (jdText.length > 32_000) jdText = jdText.slice(0, 32_000) + '\n…[truncated]';

      const resumeOut = await generateResumeTex(client, { company, role, jdText, context });
      await sleep(1500);

      const resumeSummaryOut = await generateResumeSummaryForSheet(client, {
        jdText,
        resumeJson: resumeOut.resumeJson,
      });
      await sleep(1200);

      const coverOut = await generateCoverLetter(client, { company, role, jdText, context });
      await sleep(1500);

      const emailOut = await generateOutreachEmail(client, { company, role, jdText, context });
      await sleep(1200);

      const liOut = await generateLinkedInInvite(client, { company, role, jdText, context });
      await sleep(800);

      const compiled = tryCompileLatexToPdf(resumeOut.tex);
      if (!compiled.ok) {
        const resumeTexLink = await writeInBucket('RESUME', `resume-${job_id}.tex`, resumeOut.tex);
        const texPath = join(compiled.dir, 'resume.tex');
        const ctx = latexErrorContext(texPath, compiled.compileReport);
        const err = new Error(`LaTeX compilation failed for ${job_id}. .tex uploaded: ${resumeTexLink}`);
        err.compileReport = compiled.compileReport;
        err.latex_error_context = ctx;
        throw err;
      }

      const resumeTexLink = await writeInBucket('RESUME', `resume-${job_id}.tex`, resumeOut.tex);
      const bucketId = bucketIdByName.get('RESUME');
      const { folderId } = await ensureFolderPath(bucketId, [companyFolderName, jobFolderName]);
      const up = await uploadFileFromPath({
        parentId: folderId,
        filename: `resume-${job_id}.pdf`,
        mimeType: 'application/pdf',
        filePath: compiled.pdfPath,
      });
      const resumePdfLink = up.webViewLink;
      const resumeLink = resumePdfLink;

      const coverLink = await writeInBucket('COVERLETTER', `coverletter-${job_id}.txt`, coverOut.text);
      const emailLink = await writeInBucket(
        'EMAIL',
        `email-${job_id}.txt`,
        formatEmailFile({ subject: emailOut.subject, body: emailOut.body })
      );

      const contextPack = {
        job_id,
        company,
        role,
        match_score: matchScore || null,
        jd_drive_link: jdLink,
        generated_at: now.toISOString(),
        jd_excerpt: jdText.slice(0, 2500),
        models: {
          resume: resumeOut.model,
          cover_letter: coverOut.model,
          outreach: emailOut.model,
          linkedin: liOut.model,
        },
        resume_summary: {
          model: resumeSummaryOut.model,
          text: resumeSummaryOut.text,
        },
        links: {
          resume_latex: resumeTexLink,
          resume_pdf: resumePdfLink || null,
          cover_letter: coverLink,
          outreach_email: emailLink,
        },
        generated_assets: {
          resume: resumeOut.tex,
          cover_letter_text: coverOut.text,
          outreach_email: {
            subject: emailOut.subject,
            body: emailOut.body,
            file_rendered: formatEmailFile({ subject: emailOut.subject, body: emailOut.body }),
          },
          linkedin_invite_text: liOut.text,
        },
        latex_compile: compiled.compileReport || null,
        latex_error_context: null,
      };
      const ctxLink = await writeInBucket(
        'CONTEXT',
        `context-${job_id}.json`,
        JSON.stringify(contextPack, null, 2) + '\n'
      );

      const assetsRowValues = [
        job_id,
        company,
        role,
        'ASSETS_READY',
        resumeLink,
        coverLink,
        emailLink,
        jdLink,
        ctxLink,
        resumeSummaryOut.text,
        liOut.text,
        String(liOut.text.length),
        now.toISOString(),
        resumePdfLink
          ? 'Claude-generated resume (PDF + .tex), cover letter, outreach email; review before sending'
          : 'Claude-generated resume (PDF + .tex), cover letter, outreach email; review before sending',
      ];

      const existingRow = existingJobIdToRow.get(job_id);
      if (existingRow) {
        await withGoogleApi('sheetsWrite', () =>
          sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `ASSETS!A${existingRow}:N${existingRow}`,
            valueInputOption: 'RAW',
            requestBody: { values: [assetsRowValues] },
          })
        );
      } else {
        await appendRow('ASSETS', assetsRowValues);
      }

      await appendRow('PIPELINE_STATUS', [
        job_id,
        company,
        role,
        'ASSETS_PENDING_REVIEW',
        now.toISOString(),
        'Review generated assets',
        '',
      ]);

      report.processed++;
      report.assetsCreated.push({
        job_id,
        resumeLink,
        coverLink,
        emailLink,
        models: {
          resume: resumeOut.model,
          resume_summary: resumeSummaryOut.model,
          cover_letter: coverOut.model,
          outreach: emailOut.model,
          linkedin: liOut.model,
        },
        resume_summary: resumeSummaryOut.text,
      });
      existingJobIds.add(job_id);
    } catch (err) {
      report.errors.push({ job_id, company, role, error: err?.message || String(err) });
    }
  }

  report.ok = report.errors.length === 0 || report.processed > 0;
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

report.google_api_metrics = getGoogleApiMetrics();
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
