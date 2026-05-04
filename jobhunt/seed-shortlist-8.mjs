#!/usr/bin/env node
/**
 * seed-shortlist-8.mjs — **canonical Command Center + Drive e2e seed**
 *
 * 1. **INBOX_RAW**: 10 synthetic jobs, each with demo **match_score** (0–10) and JDS + CONTEXT in Drive.
 * 2. **SHORTLIST**: only rows with **match_score >= threshold** (`jobhunt/match-score-demo.mjs`, default 6.0).
 * 3. No RESUME/COVER/EMAIL or **ASSETS** rows — run `npm run jobhunt:stage2` after setting **pursue**.
 * 4. **pursue** is left blank for manual dropdown selection.
 *
 * Full manual test:
 *   npm run jobhunt:cleanup && npm run jobhunt:bootstrap && npm run jobhunt:seed-8
 *   → set SHORTLIST.pursue (e.g. PURSUE) → npm run jobhunt:stage2
 *   → change pursue / add rows → npm run jobhunt:stage2 again (idempotent for existing job_ids)
 *
 * (`jobhunt:e2e` in package.json is the same entry point.)
 */

import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { loadDotenv } from '../integrations/google/env.mjs';
import { appendRow, reapplyShortlistPursueDropdown } from '../integrations/google/sheets.mjs';
import { getRootFolder, ensureSubfolders, ensureFolderPath, createTextFile } from '../integrations/google/drive.mjs';
import { makeJobId, slugifyFolderName, ymd } from './ids.mjs';
import { E2E_PROMOTION_THRESHOLD, matchScoreForRole } from './match-score-demo.mjs';

export const DEFAULT_E2E_JOBS = [
  { company: 'ExampleCo', role: 'Data Engineer' },
  { company: 'BlueRocket', role: 'Analytics Engineer' },
  { company: 'NimbusAI', role: 'Product Data Analyst' },
  { company: 'HarborTech', role: 'BI Analyst' },
  { company: 'QuartzHealth', role: 'Data Analyst' },
  { company: 'RedwoodLabs', role: 'Business Intelligence Engineer' },
  { company: 'SkylineMarket', role: 'Product Analyst' },
  { company: 'ZenithOps', role: 'Business Analyst' },
  { company: 'AuroraStack', role: 'Analytics Manager' },
  { company: 'CobaltData', role: 'Decision Scientist' },
];

/**
 * @param {{ rowNote?: string, jobs?: typeof DEFAULT_E2E_JOBS }} [opts]
 */
export async function runSeedShortlistE2E(opts = {}) {
  await loadDotenv();

  const rowNote = opts.rowNote ?? 'e2e seed row';
  const jobs = opts.jobs ?? DEFAULT_E2E_JOBS;
  const promotionThreshold = E2E_PROMOTION_THRESHOLD;
  const source = 'E2E_SEED';

  const now = new Date();
  const date = ymd(now);

  const report = {
    ok: false,
    promotionThreshold,
    inboxAppended: 0,
    shortlistAppended: 0,
    seeded: [],
  };

  const { rootFolder } = await getRootFolder();
  const sub = await ensureSubfolders(rootFolder.id);
  const bucketIdByName = new Map((sub.folders || []).map(f => [f.name, f.id]));

  for (const j of jobs) {
    const scoreNum = matchScoreForRole(j.role);
    const match_score = String(scoreNum);

    const job = {
      source,
      company: j.company,
      role: j.role,
      location: 'N/A',
      url: `local:e2e/${encodeURIComponent(j.company)}/${encodeURIComponent(j.role)}`,
      match_score,
    };

    const job_id = makeJobId(job);
    const companyFolderName = slugifyFolderName(job.company);
    const jobFolderName = slugifyFolderName(`${date}_${job_id}`);

    const writeInBucket = async (bucketName, filename, contents) => {
      const bucketId = bucketIdByName.get(bucketName);
      if (!bucketId) throw new Error(`Missing Drive bucket: ${bucketName}`);
      const { folderId } = await ensureFolderPath(bucketId, [companyFolderName, jobFolderName]);
      const f = await createTextFile(folderId, filename, contents);
      return f.webViewLink;
    };

    const jdBody = `JD placeholder for ${job.company} — ${job.role}\nurl=${job.url}\nmatch_score=${match_score}\n`;
    const jdLink = await writeInBucket('JDS', `jd-${job_id}.txt`, jdBody);
    const ctxLink = await writeInBucket(
      'CONTEXT',
      `context-${job_id}.json`,
      JSON.stringify(
        { job_id, seeded_at: now.toISOString(), match_score: scoreNum },
        null,
        2
      ) + '\n'
    );

    const inboxNote =
      scoreNum < promotionThreshold
        ? `${rowNote} | below threshold ${promotionThreshold}`
        : rowNote;

    await appendRow('INBOX_RAW', [
      job_id,
      job.source,
      now.toISOString(),
      job.company,
      job.role,
      job.location,
      job.url,
      jdLink,
      job.match_score,
      'NEW',
      inboxNote,
    ]);
    report.inboxAppended++;

    const promoted = scoreNum >= promotionThreshold;

    if (promoted) {
      const slNote = `${rowNote} | promoted (score>=${promotionThreshold})`;
      await appendRow('SHORTLIST', [
        job_id,
        '',
        job.company,
        job.role,
        job.location,
        job.url,
        jdLink,
        job.match_score,
        'SHORTLISTED',
        'P2',
        slNote,
      ]);
      report.shortlistAppended++;
    }

    report.seeded.push({
      job_id,
      company: job.company,
      role: job.role,
      match_score,
      match_score_num: scoreNum,
      promoted,
      jdLink,
      ctxLink,
    });
  }

  await reapplyShortlistPursueDropdown();

  report.ok = true;
  return report;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const report = await runSeedShortlistE2E();
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
    process.exit(1);
  }
}
