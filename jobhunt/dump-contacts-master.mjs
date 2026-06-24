#!/usr/bin/env node
/**
 * dump-contacts-master.mjs
 *
 * Read CONTACTS_MASTER from the live sheet and write local JSON backups.
 * No Apollo credits — Google Sheets API only.
 *
 * Usage:
 *   npm run jobhunt:dump-contacts-master
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDotenv, normalizeGoogleSheetId, requireEnv } from '../integrations/google/env.mjs';
import { getSheetsClient } from '../integrations/google/auth.mjs';
import { withGoogleApi, getGoogleApiMetrics } from '../integrations/google/rate-limit.mjs';

await loadDotenv();

const SNAPSHOTS_DIR_REL = process.env.JOBHUNT_SNAPSHOTS_DIR || 'data/snapshots';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function getCell(row, idx) {
  return row && idx >= 0 && row[idx] != null ? String(row[idx]).trim() : '';
}

function writeJson(path, payload) {
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

const now = new Date();
const runId = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(
  now.getHours()
)}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

const report = {
  ok: false,
  run_id: runId,
  fetched_at: now.toISOString(),
  rows: 0,
  with_email: 0,
  paths: {},
};

try {
  requireEnv('GOOGLE_SHEET_ID');
  const sheets = await getSheetsClient();
  const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));

  const res = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'CONTACTS_MASTER!A1:T',
    })
  );

  const values = res.data.values || [];
  if (values.length <= 1) {
    report.ok = true;
    report.note = 'CONTACTS_MASTER has header only or is empty';
    report.google_api_metrics = getGoogleApiMetrics();
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const header = values[0];
  const idx = {
    contact_id: header.indexOf('contact_id'),
    company: header.indexOf('company'),
    name: header.indexOf('name'),
    title: header.indexOf('title'),
    linkedin_url: header.indexOf('linkedin_url'),
    email: header.indexOf('email'),
    notes: header.indexOf('notes'),
  };

  const dataRows = values.slice(1);
  const contacts = dataRows.map((row) => ({
    contact_id: getCell(row, idx.contact_id),
    company: getCell(row, idx.company),
    name: getCell(row, idx.name),
    title: getCell(row, idx.title),
    email: getCell(row, idx.email),
    linkedin_url: getCell(row, idx.linkedin_url),
    notes: getCell(row, idx.notes),
  }));

  const withEmail = contacts.filter((c) => c.email).length;

  const snapshotsDir = join(process.cwd(), SNAPSHOTS_DIR_REL);
  if (!existsSync(snapshotsDir)) mkdirSync(snapshotsDir, { recursive: true });

  const fullPayload = {
    fetched_at: report.fetched_at,
    run_id: runId,
    values,
  };

  const historyPath = join(snapshotsDir, `contacts-master-${runId}.json`);
  const latestPath = join(snapshotsDir, 'contacts-master-latest.json');
  const emailsPath = join(snapshotsDir, `contacts-emails-${runId}.json`);

  writeJson(historyPath, fullPayload);
  writeJson(latestPath, fullPayload);
  writeJson(emailsPath, {
    fetched_at: report.fetched_at,
    run_id: runId,
    total: contacts.length,
    with_email: withEmail,
    contacts,
  });

  report.ok = true;
  report.rows = contacts.length;
  report.with_email = withEmail;
  report.paths = {
    history: historyPath,
    latest: latestPath,
    emails: emailsPath,
  };
  report.google_api_metrics = getGoogleApiMetrics();
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
} catch (err) {
  report.error = err?.message || String(err);
  report.google_api_metrics = getGoogleApiMetrics();
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
