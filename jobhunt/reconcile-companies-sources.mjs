#!/usr/bin/env node
/**
 * reconcile-companies-sources.mjs
 *
 * Read-only diagnostic:
 * - Extract company names from config/portals.yml (tracked_companies)
 * - Extract company names from config/companies.yml
 * - Extract company names from data/snapshots/contacts-master-latest.json
 *
 * Then print "A not in B" diffs so you can spot missing/unsynchronized companies.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function loadYaml(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  return yaml.load(raw);
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

const REPO_ROOT = join(process.cwd(), '..');

// When run from `career-ops/`, this is simply `./...`.
const base = process.cwd();

const portalsPath = join(base, 'config', 'portals.yml');
const portalsRaw = loadYaml(portalsPath);
if (!portalsRaw) throw new Error(`Missing or unreadable config/portals.yml: ${portalsPath}`);

const tracked = Array.isArray(portalsRaw?.tracked_companies) ? portalsRaw.tracked_companies : [];
const portalsCompanies = new Set(tracked.map((c) => normalizeName(c?.name)).filter(Boolean));

const companiesPath = join(base, 'config', 'companies.yml');
const companiesRaw = loadYaml(companiesPath);
if (!companiesRaw) throw new Error(`Missing or unreadable config/companies.yml: ${companiesPath}`);

const configured = Array.isArray(companiesRaw?.companies) ? companiesRaw.companies : [];
const configCompanies = new Set(configured.map((c) => normalizeName(c?.name)).filter(Boolean));

const snapshotPath = join(base, 'data', 'snapshots', 'contacts-master-latest.json');
const snapshot = loadJson(snapshotPath);
if (!snapshot?.values?.length) throw new Error(`Missing contacts snapshot: ${snapshotPath}`);

const header = snapshot.values[0] || [];
const companyIdx = header.indexOf('company');
if (companyIdx < 0) throw new Error('Snapshot header missing "company" column');

const snapshotCompanies = new Set(
  snapshot.values.slice(1).map((row) => normalizeName(row?.[companyIdx])).filter(Boolean)
);

function diff(aSet, bSet) {
  const out = [];
  for (const a of aSet) if (!bSet.has(a)) out.push(a);
  return out.sort();
}

const report = {
  portals_companies_count: portalsCompanies.size,
  config_companies_count: configCompanies.size,
  snapshot_companies_count: snapshotCompanies.size,
  portals_not_in_config: diff(portalsCompanies, configCompanies),
  config_not_in_portals: diff(configCompanies, portalsCompanies),
  snapshot_not_in_config: diff(snapshotCompanies, configCompanies),
};

console.log(JSON.stringify(report, null, 2));

