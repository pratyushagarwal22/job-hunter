#!/usr/bin/env node
/**
 * Migrate an old CONTACTS_MASTER snapshot (12-col) to the new schema (20-col).
 *
 * Defaults are intentionally opinionated for this repo:
 * - source: data/snapshots/contacts-master-20260505-223657.json
 * - out:    data/snapshots/contacts-master-20260505-223657.migrated.json
 * - also writes data/snapshots/contacts-master-latest.json (unless --no-update-latest)
 *
 * Usage:
 *   node scripts/migrate-contacts-master-snapshot.mjs
 *   node scripts/migrate-contacts-master-snapshot.mjs --source <path> --out <path>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);

function argValue(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

function hasFlag(flag) {
  return args.includes(flag);
}

const DEFAULT_SOURCE = 'data/snapshots/contacts-master-20260505-223657.json';
const DEFAULT_OUT = 'data/snapshots/contacts-master-20260505-223657.migrated.json';

const sourceRel = argValue('--source') || DEFAULT_SOURCE;
const outRel = argValue('--out') || DEFAULT_OUT;
const updateLatest = !hasFlag('--no-update-latest');

const sourcePath = resolve(process.cwd(), sourceRel);
const outPath = resolve(process.cwd(), outRel);
const latestPath = resolve(process.cwd(), 'data/snapshots/contacts-master-latest.json');

function ensureDirForFile(p) {
  const dir = resolve(p, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson(p) {
  const raw = readFileSync(p, 'utf-8');
  return JSON.parse(raw);
}

function writeJson(p, obj) {
  ensureDirForFile(p);
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

function looksLikeOldHeader(header) {
  if (!Array.isArray(header)) return false;
  const joined = header.join(',');
  return (
    header.includes('contact_id') &&
    header.includes('last_contacted_job_id') &&
    header[header.length - 1] === 'notes' &&
    header.length === 12
  );
}

function hasNewColumns(header) {
  return (
    Array.isArray(header) &&
    header.includes('role_archetype') &&
    header.includes('email_draft_drive_link') &&
    header.includes('last_reply_at')
  );
}

async function loadTargetHeader() {
  // Import HEADERS from jobhunt/command-center-schema.mjs (ESM).
  const schemaPath = resolve(process.cwd(), 'jobhunt/command-center-schema.mjs');
  if (!existsSync(schemaPath)) throw new Error(`Schema file not found: ${schemaPath}`);
  const mod = await import(pathToFileURL(schemaPath).href);
  const header = mod?.HEADERS?.CONTACTS_MASTER;
  if (!Array.isArray(header) || header.length < 15) {
    throw new Error('Could not load HEADERS.CONTACTS_MASTER from command-center-schema.mjs');
  }
  if (!hasNewColumns(header)) {
    throw new Error(
      `Target header does not include expected new columns. Got: ${JSON.stringify(header)}`
    );
  }
  return header;
}

function padRow(row, targetLen) {
  const r = Array.isArray(row) ? row.map((x) => (x == null ? '' : String(x))) : [];
  if (r.length > targetLen) return r.slice(0, targetLen);
  while (r.length < targetLen) r.push('');
  return r;
}

try {
  if (!existsSync(sourcePath)) {
    throw new Error(`Source snapshot not found: ${sourcePath}`);
  }

  const src = readJson(sourcePath);
  const values = Array.isArray(src?.values) ? src.values : [];
  if (values.length <= 1) throw new Error('Source snapshot had no data rows.');

  const oldHeader = values[0];
  if (!looksLikeOldHeader(oldHeader)) {
    throw new Error(
      `Source snapshot header does not look like the expected old 12-col CONTACTS_MASTER header. Got: ${JSON.stringify(
        oldHeader
      )}`
    );
  }

  const targetHeader = await loadTargetHeader();
  const targetLen = targetHeader.length;

  const migratedValues = [targetHeader];
  for (const row of values.slice(1)) {
    migratedValues.push(padRow(row, targetLen));
  }

  const out = {
    fetched_at: src.fetched_at || new Date().toISOString(),
    run_id: src.run_id || 'migrated',
    migrated_from: sourceRel,
    migrated_at: new Date().toISOString(),
    values: migratedValues,
  };

  writeJson(outPath, out);
  if (updateLatest) writeJson(latestPath, out);

  console.log(
    JSON.stringify(
      {
        ok: true,
        source: sourceRel,
        out: outRel,
        updated_latest: updateLatest,
        latest: updateLatest ? 'data/snapshots/contacts-master-latest.json' : null,
        old_cols: oldHeader.length,
        new_cols: targetLen,
        rows: migratedValues.length - 1,
      },
      null,
      2
    )
  );
  process.exit(0);
} catch (err) {
  console.error(
    JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2)
  );
  process.exit(1);
}

