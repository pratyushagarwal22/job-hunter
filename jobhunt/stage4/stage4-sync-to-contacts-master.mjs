#!/usr/bin/env node
/**
 * stage4-sync-to-contacts-master.mjs
 *
 * Read data/stage4/<runId>/contacts-import.json, append net-new rows to CONTACTS_MASTER,
 * write full-sheet contacts-master-latest.json (in-memory merge, single sheet read).
 *
 *   npm run jobhunt:stage4-sync
 *   npm run jobhunt:stage4-sync -- 20250623-143000
 *   node jobhunt/stage4/stage4-sync-to-contacts-master.mjs [runId]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDotenv, normalizeGoogleSheetId, requireEnv } from '../../integrations/google/env.mjs';
import { getSheetsClient } from '../../integrations/google/auth.mjs';
import { appendRows } from '../../integrations/google/sheets.mjs';
import { withGoogleApi, getGoogleApiMetrics } from '../../integrations/google/rate-limit.mjs';

import {
  buildMasterMaps,
  dumpJson,
  lookupExisting,
  makeRunId,
  mergeSnapshotValues,
  normalizeLinkedInUrl,
  padMasterRow,
  personFromMasterRow,
  readLatestSnapshotRowCount,
  writeContactsMasterSnapshot,
} from './lib/contacts-helpers.mjs';

const DUMP_DIR_REL = process.env.JOBHUNT_STAGE4_DUMP_DIR || 'data/stage4';

function resolveRunDir(runIdArg) {
  const root = join(process.cwd(), DUMP_DIR_REL);
  if (!existsSync(root)) {
    throw new Error(`No Stage 4 dump directory: ${root}. Run jobhunt:stage4-enrich first.`);
  }

  if (runIdArg) {
    const dir = join(root, runIdArg);
    if (!existsSync(dir)) throw new Error(`Run directory not found: ${dir}`);
    return { runId: runIdArg, dir };
  }

  const runIds = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter(Boolean)
    .sort()
    .reverse();

  for (const id of runIds) {
    const importPath = join(root, id, 'contacts-import.json');
    if (existsSync(importPath)) return { runId: id, dir: join(root, id) };
  }

  throw new Error(`No contacts-import.json found under ${root}`);
}

async function readContactsMasterValues(sheets, spreadsheetId) {
  const res = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'CONTACTS_MASTER!A1:T',
    })
  );
  return res.data.values || [];
}

await loadDotenv();

const runIdArg = process.argv[2] ? String(process.argv[2]).trim() : '';
const syncRunId = makeRunId(new Date());

const report = {
  ok: false,
  sync_run_id: syncRunId,
  stage4_run_id: null,
  appended: 0,
  skipped_already_in_sheet: 0,
  warnings: [],
};

try {
  const { runId, dir } = resolveRunDir(runIdArg);
  report.stage4_run_id = runId;

  const importPath = join(dir, 'contacts-import.json');
  const parsed = JSON.parse(readFileSync(importPath, 'utf-8'));
  const importValues = Array.isArray(parsed?.values) ? parsed.values : [];
  const importDataRows = importValues.length > 1 ? importValues.slice(1).map(padMasterRow) : [];

  const sheets = await getSheetsClient();
  const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));
  const existingValues = await readContactsMasterValues(sheets, spreadsheetId);
  const sheetDataRowCount = Math.max(0, existingValues.length - 1);

  const latestRowCount = readLatestSnapshotRowCount();
  if (latestRowCount != null && latestRowCount !== sheetDataRowCount) {
    report.warnings.push(
      `contacts-master-latest.json has ${latestRowCount} data rows but live sheet has ${sheetDataRowCount}; using live sheet for dedup/append.`
    );
  }

  const maps = buildMasterMaps(existingValues);
  const toAppend = [];

  for (const row of importDataRows) {
    const person = personFromMasterRow(row);
    if (lookupExisting(person, maps.masterByApolloId, maps.masterByLinkedIn, maps.masterByEmail)) {
      report.skipped_already_in_sheet += 1;
      continue;
    }
    toAppend.push(row);
    if (person.linkedin_url) {
      const li = normalizeLinkedInUrl(person.linkedin_url);
      if (li) maps.masterByLinkedIn.set(li, { rowIndex: -1, contactId: row[0] });
    }
    if (person.email) maps.masterByEmail.set(person.email.toLowerCase(), { rowIndex: -1, contactId: row[0] });
    if (person.apollo_person_id) {
      maps.masterByApolloId.set(person.apollo_person_id, { rowIndex: -1, contactId: row[0] });
    }
  }

  if (toAppend.length > 0) {
    try {
      await appendRows('CONTACTS_MASTER', toAppend);
      report.appended = toAppend.length;
    } catch (appendErr) {
      report.ok = false;
      report.error = appendErr?.message || String(appendErr);
      report.google_api_metrics = getGoogleApiMetrics();
      dumpJson(dir, 'sync-summary.json', report);
      console.error(JSON.stringify(report, null, 2));
      process.exit(1);
    }
  }

  const snapshotValues = mergeSnapshotValues(existingValues, toAppend);
  const snapshotPayload = {
    fetched_at: new Date().toISOString(),
    run_id: syncRunId,
    stage4_source_run_id: runId,
    values: snapshotValues,
  };

  const { historyPath, latestPath } = writeContactsMasterSnapshot(snapshotPayload, syncRunId);
  report.contacts_master_snapshot = {
    ok: true,
    path: latestPath,
    history_path: historyPath,
    rows: Math.max(0, snapshotValues.length - 1),
  };

  report.ok = true;
  report.google_api_metrics = getGoogleApiMetrics();
  dumpJson(dir, 'sync-summary.json', report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
  report.google_api_metrics = getGoogleApiMetrics();
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
