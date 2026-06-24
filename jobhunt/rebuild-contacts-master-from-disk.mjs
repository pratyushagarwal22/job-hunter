#!/usr/bin/env node
/**
 * rebuild-contacts-master-from-disk.mjs
 *
 * Rebuilds the CONTACTS_MASTER sheet from the latest disk snapshot, resolved in order:
 *   1) data/snapshots/contacts-master-latest.json
 *   2) Lexicographically newest data/snapshots/contacts-master-<runId>.json (excluding latest)
 *   3) Legacy: newest data/stage3/<runId>/contacts-master-snapshot.json that exists on disk
 *
 * Intended use:
 *   npm run jobhunt:cleanup && npm run jobhunt:bootstrap
 *   node jobhunt/rebuild-contacts-master-from-disk.mjs
 *
 * Notes:
 * - Snapshot files are local and typically gitignored.
 * - CONTACTS_MASTER.last_contacted_* values are treated as metadata; Stage 3
 *   will overwrite them on reuse.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDotenv } from '../integrations/google/env.mjs';
import { clearTabExceptHeader, appendRows, ensureHeaderRow } from '../integrations/google/sheets.mjs';
import { getGoogleApiMetrics } from '../integrations/google/rate-limit.mjs';

await loadDotenv();

const DUMP_DIR_REL = process.env.JOBHUNT_STAGE3_DUMP_DIR || 'data/stage3';
const SNAPSHOTS_DIR_REL = process.env.JOBHUNT_SNAPSHOTS_DIR || 'data/snapshots';
const dumpRoot = join(process.cwd(), DUMP_DIR_REL);
const snapshotsRoot = join(process.cwd(), SNAPSHOTS_DIR_REL);
const SNAPSHOT_FILENAME = 'contacts-master-snapshot.json';
const LATEST_SNAPSHOT = 'contacts-master-latest.json';

const report = {
  ok: false,
  snapshots_root: snapshotsRoot,
  dump_root: dumpRoot,
  snapshot_source: null,
  snapshot_path: null,
  rows_appended: 0,
  sheets: {},
};

function pickLatestLegacySnapshotPath(rootDir) {
  if (!existsSync(rootDir)) return null;
  const runIds = readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter(Boolean)
    .sort()
    .reverse();
  for (const id of runIds) {
    const p = join(rootDir, id, SNAPSHOT_FILENAME);
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveSnapshotPath() {
  const latestPath = join(snapshotsRoot, LATEST_SNAPSHOT);
  if (existsSync(latestPath)) {
    return { snapshot_path: latestPath, snapshot_source: 'latest' };
  }

  if (existsSync(snapshotsRoot)) {
    const historyNames = readdirSync(snapshotsRoot, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => d.name)
      .filter((n) => n.startsWith('contacts-master-') && n !== LATEST_SNAPSHOT)
      .sort()
      .reverse();
    if (historyNames.length > 0) {
      return {
        snapshot_path: join(snapshotsRoot, historyNames[0]),
        snapshot_source: 'history',
      };
    }
  }

  const legacyPath = pickLatestLegacySnapshotPath(dumpRoot);
  if (legacyPath) {
    return { snapshot_path: legacyPath, snapshot_source: 'legacy-stage3' };
  }

  throw new Error(
    `No contacts-master snapshot found under ${snapshotsRoot} or legacy ${dumpRoot}/*/${SNAPSHOT_FILENAME}`
  );
}

try {
  const { snapshot_path: snapshotPath, snapshot_source: snapshotSource } = resolveSnapshotPath();
  report.snapshot_source = snapshotSource;
  report.snapshot_path = snapshotPath;

  const raw = readFileSync(snapshotPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const values = Array.isArray(parsed?.values) ? parsed.values : [];
  if (values.length <= 1) throw new Error(`Snapshot had no data rows: ${snapshotPath}`);

  const header = values[0];
  const rows = values.slice(1);
  report.snapshot_header = header;
  report.snapshot_rows = rows.length;

  // Restore the snapshot schema explicitly (prevents old-format headers
  // from persisting if someone ran rebuild without bootstrap).
  report.sheets.headerUpdated = await ensureHeaderRow('CONTACTS_MASTER', header);

  report.sheets.cleared = await clearTabExceptHeader('CONTACTS_MASTER');
  await appendRows('CONTACTS_MASTER', rows);
  report.rows_appended = rows.length;

  report.ok = true;
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

report.google_api_metrics = getGoogleApiMetrics();
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
