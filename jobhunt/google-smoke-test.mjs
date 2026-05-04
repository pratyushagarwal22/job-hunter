#!/usr/bin/env node
/**
 * google-smoke-test.mjs
 *
 * Optional **minimal** OAuth/Drive/Sheets ping (appends one INBOX row + tiny Drive file).
 * Not part of the canonical e2e — use `npm run jobhunt:seed-8` per jobhunt/RUNBOOK.md for full flow.
 *
 * Usage:
 *   node jobhunt/google-smoke-test.mjs
 */

import { loadDotenv } from '../integrations/google/env.mjs';
import { getRootFolder, ensureSubfolders, createTextFile } from '../integrations/google/drive.mjs';
import { ensureTabsExist, appendRow } from '../integrations/google/sheets.mjs';

await loadDotenv();

const startedAt = new Date();
const iso = startedAt.toISOString();

const report = {
  ok: false,
  startedAt: iso,
  drive: {},
  sheets: {},
};

try {
  // --- Drive ---
  const { rootFolder } = await getRootFolder();
  report.drive.rootFolder = rootFolder;

  const subfolders = await ensureSubfolders(rootFolder.id);
  report.drive.subfolders = {
    created: subfolders.created,
    present: subfolders.folders,
  };

  // NOTE: Service accounts typically cannot create/upload into a user's "My Drive"
  // because they have no storage quota. We keep this optional so Sheets verification
  // can still proceed.
  try {
    const smokeFile = await createTextFile(
      rootFolder.id,
      `career-ops-smoke-test-${iso}.txt`,
      `career-ops google smoke test OK @ ${iso}\n`
    );
    report.drive.smokeFile = smokeFile;
  } catch (err) {
    report.drive.smokeFile = null;
    report.drive.warning = err?.message || String(err);
  }

  // Also verify we can create files inside each required subfolder.
  const byName = new Map((subfolders.folders || []).map(f => [f.name, f.id]));
  const perFolder = {};
  for (const folderName of ['RESUME', 'COVERLETTER', 'EMAIL']) {
    const folderId = byName.get(folderName);
    if (!folderId) {
      perFolder[folderName] = { ok: false, error: 'missing folder id' };
      continue;
    }
    try {
      const f = await createTextFile(
        folderId,
        `career-ops-smoke-test-${folderName}-${iso}.txt`,
        `career-ops smoke test in ${folderName} @ ${iso}\n`
      );
      perFolder[folderName] = { ok: true, file: f };
    } catch (err) {
      perFolder[folderName] = { ok: false, error: err?.message || String(err) };
    }
  }
  report.drive.subfolderWrites = perFolder;

  // --- Sheets ---
  const ensured = await ensureTabsExist();
  report.sheets.tabsCreated = ensured.created;

  const appendRes = await appendRow('INBOX_RAW', ['SMOKE_TEST', iso, 'ok']);
  report.sheets.append = appendRes;

  report.ok = true;
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

