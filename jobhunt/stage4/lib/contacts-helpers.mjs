/**
 * Stage 4–only CONTACTS_MASTER helpers (patterns copied from stage3; stage3 is not imported).
 */

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { HEADERS } from '../../command-center-schema.mjs';
import { ymd } from '../../ids.mjs';

export const CONTACTS_MASTER_HEADER = HEADERS.CONTACTS_MASTER;
export const CONTACTS_MASTER_COL_COUNT = CONTACTS_MASTER_HEADER.length;

const SNAPSHOTS_DIR_REL = process.env.JOBHUNT_SNAPSHOTS_DIR || 'data/snapshots';

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function makeRunId(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(
    d.getHours()
  )}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function getCell(row, idx) {
  return row && idx >= 0 && row[idx] != null ? String(row[idx]).trim() : '';
}

export function normalizeLinkedInUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const hashIdx = s.indexOf('#');
  if (hashIdx >= 0) s = s.slice(0, hashIdx).trim();
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!host.includes('linkedin.com')) return s.toLowerCase();
    let path = u.pathname.replace(/\/+$/, '');
    return `https://${host}${path}`.toLowerCase();
  } catch {
    return s.toLowerCase().replace(/\/+$/, '');
  }
}

export function makeContactId({ apollo_person_id, linkedin_url, email, organizationName, name, title }, dateStr) {
  const ymdCompact = (dateStr || ymd()).replace(/-/g, '');
  const base = String(
    apollo_person_id ||
      linkedin_url ||
      email ||
      `${organizationName || ''}::${name || ''}::${title || ''}`
  )
    .toLowerCase()
    .trim();
  const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 8).toUpperCase();
  return `CT-${ymdCompact}-${hash}`;
}

export function dedupKey(person) {
  if (person.apollo_person_id) return `id:${person.apollo_person_id}`;
  const li = normalizeLinkedInUrl(person.linkedin_url);
  if (li) return `li:${li}`;
  if (person.email) return `em:${person.email.toLowerCase()}`;
  return `nm:${(person.name || '').toLowerCase()}|${(person.title || '').toLowerCase()}`;
}

export function extractApolloIdFromNotes(notes) {
  const m = String(notes || '').match(/apollo_person_id\s*=\s*([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}

export function buildMasterMaps(masterRows) {
  const masterByApolloId = new Map();
  const masterByLinkedIn = new Map();
  const masterByEmail = new Map();
  const masterByContactId = new Map();

  for (let i = 1; i < masterRows.length; i++) {
    const r = masterRows[i];
    const cid = getCell(r, 0);
    const liRaw = getCell(r, 5);
    const emRaw = getCell(r, 6);
    const notes = getCell(r, 11);
    const apolloId = extractApolloIdFromNotes(notes);
    const rowIndex = i + 1;
    const entry = { rowIndex, contactId: cid };
    if (cid) masterByContactId.set(cid, entry);
    if (apolloId) masterByApolloId.set(apolloId, entry);
    const li = normalizeLinkedInUrl(liRaw);
    const em = emRaw.toLowerCase();
    if (li) masterByLinkedIn.set(li, entry);
    if (em) masterByEmail.set(em, entry);
  }

  return { masterByApolloId, masterByLinkedIn, masterByEmail, masterByContactId };
}

export function lookupExisting(person, masterByApolloId, masterByLinkedIn, masterByEmail) {
  const apolloId = person.apollo_person_id || '';
  const liKey = normalizeLinkedInUrl(person.linkedin_url);
  const emKey = (person.email || '').toLowerCase();
  if (apolloId && masterByApolloId.has(apolloId)) return masterByApolloId.get(apolloId);
  if (liKey && masterByLinkedIn.has(liKey)) return masterByLinkedIn.get(liKey);
  if (emKey && masterByEmail.has(emKey)) return masterByEmail.get(emKey);
  return null;
}

export function isLinkedInUrlOnSheet(url, masterByLinkedIn) {
  const key = normalizeLinkedInUrl(url);
  return !!(key && masterByLinkedIn.has(key));
}

export function personFromMasterRow(row) {
  if (!row || !row.length) return null;
  const notes = getCell(row, 11);
  return {
    apollo_person_id: extractApolloIdFromNotes(notes),
    linkedin_url: getCell(row, 5),
    email: getCell(row, 6),
    name: getCell(row, 3),
    title: getCell(row, 4),
  };
}

export function personToMasterRow(person, { contactId, notesTag = '' } = {}) {
  const apolloId = person.apollo_person_id || '';
  const company = person.organization?.name || '';
  const team = Array.isArray(person.departments) ? person.departments.filter(Boolean).join(', ') : '';
  let notes = apolloId ? `apollo_person_id=${apolloId}; source=stage4` : 'source=stage4';
  if (notesTag) notes = `${notes}; ${notesTag}`;

  const row = new Array(CONTACTS_MASTER_COL_COUNT).fill('');
  row[0] = contactId;
  row[1] = company;
  row[2] = team;
  row[3] = person.name || '';
  row[4] = person.title || '';
  row[5] = person.linkedin_url || '';
  row[6] = person.email || '';
  row[7] = person.email ? 'apollo' : '';
  row[8] = person.email_confidence || '';
  // last_contacted_at, last_contacted_job_id, notes
  row[11] = notes;
  // outreach columns 12-19 left blank
  return row;
}

export function padMasterRow(row) {
  const out = [...row];
  while (out.length < CONTACTS_MASTER_COL_COUNT) out.push('');
  return out.slice(0, CONTACTS_MASTER_COL_COUNT);
}

export function mergeSnapshotValues(existingValues, appendedRows) {
  const header =
    existingValues.length > 0 ? existingValues[0] : [...CONTACTS_MASTER_HEADER];
  const dataRows = existingValues.length > 1 ? existingValues.slice(1) : [];
  const merged = appendedRows.map((r) => padMasterRow(r));
  return [header, ...dataRows, ...merged];
}

export function writeContactsMasterSnapshot(payload, runId) {
  const dir = join(process.cwd(), SNAPSHOTS_DIR_REL);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(payload, null, 2) + '\n';
  const historyPath = join(dir, `contacts-master-${runId}.json`);
  const latestPath = join(dir, 'contacts-master-latest.json');
  writeFileSync(historyPath, body, 'utf-8');
  writeFileSync(latestPath, body, 'utf-8');
  return { historyPath, latestPath };
}

export function readLatestSnapshotRowCount() {
  const latestPath = join(process.cwd(), SNAPSHOTS_DIR_REL, 'contacts-master-latest.json');
  if (!existsSync(latestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(latestPath, 'utf-8'));
    const values = Array.isArray(parsed?.values) ? parsed.values : [];
    return Math.max(0, values.length - 1);
  } catch {
    return null;
  }
}

export function ensureDumpDir(dirPath) {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

export function dumpJson(dirPath, filename, payload) {
  ensureDumpDir(dirPath);
  const path = join(dirPath, filename);
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return path;
}
