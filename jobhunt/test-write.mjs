#!/usr/bin/env node
/**
 * test-write.mjs
 *
 * Creates a single synthetic job row with a stable `job_id`, then:
 * - writes to SHORTLIST + ASSETS + PIPELINE_STATUS
 * - creates nested Drive folders under each artifact bucket:
 *     RESUME/<Company>/<RoleDate_JOBID>/
 *     COVERLETTER/<Company>/<RoleDate_JOBID>/
 *     EMAIL/<Company>/<RoleDate_JOBID>/
 * - creates placeholder artifact files in each folder
 * - writes the Drive links back into ASSETS
 *
 * Usage:
 *   node jobhunt/command-center-bootstrap.mjs
 *   node jobhunt/test-write.mjs
 */

import { loadDotenv } from '../integrations/google/env.mjs';
import { appendRow } from '../integrations/google/sheets.mjs';
import { getRootFolder, ensureSubfolders, ensureFolderPath, createTextFile } from '../integrations/google/drive.mjs';
import { makeJobId, slugifyFolderName, ymd } from './ids.mjs';

await loadDotenv();

const now = new Date();
const date = ymd(now);

// Synthetic example (safe to delete later)
const job = {
  source: 'TEST',
  seen_at: now.toISOString(),
  company: 'ExampleCo',
  role: 'Data Engineer',
  location: 'Remote (US)',
  url: 'https://example.com/jobs/123',
  match_score: 4.6,
};

const job_id = makeJobId(job);

const report = { ok: false, job_id, drive: {}, sheets: {} };

try {
  // --- Drive: ensure bucket subfolders exist ---
  const { rootFolder } = await getRootFolder();
  const sub = await ensureSubfolders(rootFolder.id);
  const bucketIdByName = new Map((sub.folders || []).map(f => [f.name, f.id]));

  const companyFolderName = slugifyFolderName(job.company);
  const roleFolderName = slugifyFolderName(`${date}_${job_id}`);

  const makeArtifact = async (bucketName, filename, contents) => {
    const bucketId = bucketIdByName.get(bucketName);
    if (!bucketId) throw new Error(`Missing Drive bucket folder: ${bucketName}`);

    const { folderId } = await ensureFolderPath(bucketId, [companyFolderName, roleFolderName]);
    const f = await createTextFile(folderId, filename, contents);
    return { folderId, file: f };
  };

  const resume = await makeArtifact(
    'RESUME',
    `resume-${job_id}.txt`,
    `Placeholder resume for ${job.company} — ${job.role}\njob_id=${job_id}\n`
  );
  const cover = await makeArtifact(
    'COVERLETTER',
    `coverletter-${job_id}.txt`,
    `Placeholder cover letter for ${job.company} — ${job.role}\njob_id=${job_id}\n`
  );
  const email = await makeArtifact(
    'EMAIL',
    `email-${job_id}.txt`,
    `Placeholder outreach email for ${job.company} — ${job.role}\njob_id=${job_id}\n`
  );

  report.drive = {
    rootFolder,
    artifactLinks: {
      resume: resume.file.webViewLink,
      coverletter: cover.file.webViewLink,
      email: email.file.webViewLink,
    },
  };

  // --- Sheets: append rows ---
  const shortlistRow = [
    job_id,
    'FALSE', // pursue (checkbox can be changed manually)
    job.company,
    job.role,
    job.location,
    job.url,
    String(job.match_score),
    'SHORTLISTED',
    'P2',
    'synthetic test row',
  ];

  const assetsRow = [
    job_id,
    job.company,
    job.role,
    'ASSETS_READY',
    resume.file.webViewLink,
    cover.file.webViewLink,
    email.file.webViewLink,
    '',
    '',
    now.toISOString(),
    '',
  ];

  const pipelineRow = [
    job_id,
    job.company,
    job.role,
    'SHORTLISTED',
    now.toISOString(),
    'Review + set Pursue',
    '',
  ];

  report.sheets.shortlistAppend = await appendRow('SHORTLIST', shortlistRow);
  report.sheets.assetsAppend = await appendRow('ASSETS', assetsRow);
  report.sheets.pipelineAppend = await appendRow('PIPELINE_STATUS', pipelineRow);

  report.ok = true;
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

