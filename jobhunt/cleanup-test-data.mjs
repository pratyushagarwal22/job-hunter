#!/usr/bin/env node
/**
 * cleanup-test-data.mjs
 *
 * Resets the Command Center to a "fresh start" by:
 * - Deleting all data rows (keeps header row) in each tab
 * - Re-applying SHORTLIST `pursue` dropdown on B2:B (cleanup does not fix misaligned rules by itself)
 * - Deleting Drive smoke-test files and placeholder test artifacts we created
 *
 * Usage:
 *   node jobhunt/cleanup-test-data.mjs
 */

import { loadDotenv } from '../integrations/google/env.mjs';
import { clearTabExceptHeader, reapplyShortlistPursueDropdown } from '../integrations/google/sheets.mjs';
import { getRootFolder, ensureSubfolders, deleteRecursively } from '../integrations/google/drive.mjs';
import { getGoogleApiMetrics } from '../integrations/google/rate-limit.mjs';

await loadDotenv();

const report = { ok: false, sheets: {}, drive: {} };

try {
  const tabs = [
    'INBOX_RAW',
    'SHORTLIST',
    'ASSETS',
    'OUTREACH',
    'PIPELINE_STATUS',
    'CONTACTS_MASTER',
  ];

  const cleared = {};
  for (const t of tabs) {
    cleared[t] = await clearTabExceptHeader(t);
  }
  report.sheets.cleared = cleared;
  report.sheets.shortlistValidation = await reapplyShortlistPursueDropdown();

  const { rootFolder } = await getRootFolder();
  const sub = await ensureSubfolders(rootFolder.id);
  const bucketIdByName = new Map((sub.folders || []).map(f => [f.name, f.id]));

  // Full reset: delete EVERYTHING inside buckets, keep the bucket folders themselves.
  const buckets = ['RESUME', 'COVERLETTER', 'EMAIL', 'JDS', 'CONTEXT', 'OUTREACH'];
  report.drive.bucketResets = {};
  for (const b of buckets) {
    const id = bucketIdByName.get(b);
    if (!id) {
      report.drive.bucketResets[b] = { ok: false, error: 'missing bucket' };
      continue;
    }
    const r = await deleteRecursively(id);
    report.drive.bucketResets[b] = { ok: true, ...r };
  }

  report.ok = true;
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

report.google_api_metrics = getGoogleApiMetrics();
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

