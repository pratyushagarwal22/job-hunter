#!/usr/bin/env node
/**
 * cleanup-test-data.mjs
 *
 * Resets the Command Center to a "fresh start" by:
 * - Deleting all data rows (keeps header row) in each tab
 * - Deleting Drive smoke-test files and placeholder test artifacts we created
 *
 * Usage:
 *   node jobhunt/cleanup-test-data.mjs
 */

import { loadDotenv } from '../integrations/google/env.mjs';
import { clearTabExceptHeader } from '../integrations/google/sheets.mjs';
import { getRootFolder, ensureSubfolders, listFilesByNamePrefix, deleteFile } from '../integrations/google/drive.mjs';

await loadDotenv();

const report = { ok: false, sheets: {}, drive: {} };

try {
  const tabs = [
    'INBOX_RAW',
    'SHORTLIST',
    'CONTACTS',
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

  const { rootFolder } = await getRootFolder();
  const sub = await ensureSubfolders(rootFolder.id);
  const bucketIdByName = new Map((sub.folders || []).map(f => [f.name, f.id]));

  const deleted = [];
  const prefixes = [
    'career-ops-smoke-test-',
    'resume-JH-',
    'coverletter-JH-',
    'email-JH-',
  ];

  const parentsToScan = [
    rootFolder.id,
    bucketIdByName.get('RESUME'),
    bucketIdByName.get('COVERLETTER'),
    bucketIdByName.get('EMAIL'),
  ].filter(Boolean);

  for (const parentId of parentsToScan) {
    for (const prefix of prefixes) {
      const files = await listFilesByNamePrefix(parentId, prefix);
      for (const f of files) {
        await deleteFile(f.id);
        deleted.push({ id: f.id, name: f.name });
      }
    }
  }

  report.drive.deletedFiles = deleted;
  report.ok = true;
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

