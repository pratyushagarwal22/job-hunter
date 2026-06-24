#!/usr/bin/env node
/**
 * extract-companies-from-portals.mjs
 *
 * One-off helper: read config/portals.yml → tracked_companies and emit a YAML
 * file suitable for Apollo / companies reconciliation (name, careers_url,
 * optional api, inferred domains when not an ATS-hosted board).
 *
 * Default output: config/companies-from-portals.yml (does not overwrite
 * config/companies.yml unless you pass -o explicitly).
 *
 * Usage:
 *   node scripts/extract-companies-from-portals.mjs
 *   node scripts/extract-companies-from-portals.mjs -o config/companies.yml
 *   node scripts/extract-companies-from-portals.mjs --enabled-only
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const REPO = join(process.cwd());
const PORTALS = join(REPO, 'config', 'portals.yml');

/** Hostnames where registrable domain is not the employer (Apollo domain may need manual fill). */
const ATS_HOST_MARKERS = [
  'greenhouse.io',
  'lever.co',
  'myworkdayjobs.com',
  'smartrecruiters.com',
  'ashbyhq.com',
  'applytojob.com',
  'bamboohr.com',
  'icims.com',
  'taleo.net',
  'ultipro.com',
];

function parseArgs(argv) {
  let out = join(REPO, 'config', 'companies-from-portals.yml');
  let enabledOnly = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--enabled-only' || a === '-e') enabledOnly = true;
    else if (a === '-o' || a === '--out') {
      out = argv[++i];
      if (!out) throw new Error('Missing path after -o');
      if (!out.startsWith('/')) out = join(REPO, out);
    } else if (a === '-h' || a === '--help') {
      console.log(`Usage: node scripts/extract-companies-from-portals.mjs [-o path] [--enabled-only]`);
      process.exit(0);
    }
  }
  return { out, enabledOnly };
}

function isAtsHostedHost(hostname) {
  const h = hostname.replace(/^www\./, '').toLowerCase();
  return ATS_HOST_MARKERS.some((m) => h === m || h.endsWith(`.${m}`));
}

/**
 * @param {string} careersUrl
 * @returns {{ domains: string[]; domain_source: string; ats_host?: string }}
 */
function inferDomainHint(careersUrl) {
  if (!careersUrl || typeof careersUrl !== 'string') {
    return { domains: [], domain_source: 'missing_url' };
  }
  try {
    const raw = careersUrl.trim();
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (!host) return { domains: [], domain_source: 'empty_host' };

    if (isAtsHostedHost(host)) {
      return {
        domains: [],
        domain_source: 'ats_host_skipped',
        ats_host: host,
      };
    }

    const parts = host.split('.');
    if (parts.length < 2) {
      return { domains: [host], domain_source: 'hostname' };
    }
    const domain = parts.slice(-2).join('.');
    return { domains: [domain], domain_source: 'hostname_etld2_heuristic' };
  } catch {
    return { domains: [], domain_source: 'url_parse_error' };
  }
}

function main() {
  const { out, enabledOnly } = parseArgs(process.argv);

  if (!existsSync(PORTALS)) {
    console.error(`Missing ${PORTALS}`);
    process.exit(1);
  }

  const portals = yaml.load(readFileSync(PORTALS, 'utf-8'));
  const tracked = Array.isArray(portals?.tracked_companies) ? portals.tracked_companies : [];

  const companies = [];
  for (const row of tracked) {
    if (!row || typeof row !== 'object') continue;
    const name = row.name != null ? String(row.name).trim() : '';
    if (!name) continue;
    if (enabledOnly && row.enabled === false) continue;

    const careers_url = row.careers_url != null ? String(row.careers_url).trim() : '';
    const hint = inferDomainHint(careers_url);

    /** @type {Record<string, unknown>} */
    const entry = { name };
    if (careers_url) entry.careers_url = careers_url;
    if (row.api != null && String(row.api).trim()) entry.api = String(row.api).trim();
    if (row.scan_method != null && String(row.scan_method).trim()) {
      entry.scan_method = String(row.scan_method).trim();
    }
    if (row.enabled != null) entry.enabled = Boolean(row.enabled);

    if (hint.domains.length) entry.domains = hint.domains;
    if (hint.ats_host) entry.ats_careers_host = hint.ats_host;

    companies.push(entry);
  }

  const header = [
    '# Generated from config/portals.yml tracked_companies.',
    '# Review domains before Apollo; ATS-hosted career pages have empty domains (fill manually).',
    `# Source: config/portals.yml`,
    `# Generated at: ${new Date().toISOString()}`,
    `# Rows: ${companies.length}`,
    '',
  ].join('\n');

  const body =
    header +
    yaml.dump({ companies }, { lineWidth: 120, noRefs: true });

  writeFileSync(out, body, 'utf-8');
  console.log(JSON.stringify({ ok: true, portals_path: PORTALS, out, count: companies.length, enabledOnly }, null, 2));
}

main();
