#!/usr/bin/env node
/**
 * stage4-enrich-from-linkedin-profiles.mjs
 *
 * Read jobhunt/stage4/linkedin-profiles.txt, skip URLs already on CONTACTS_MASTER,
 * Apollo-enrich net-new only, write data/stage4/<runId>/ run dumps.
 * Does not write to the sheet or contacts-master-latest.json.
 *
 *   npm run jobhunt:stage4-enrich
 *   node jobhunt/stage4/stage4-enrich-from-linkedin-profiles.mjs [path/to/profiles.txt]
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDotenv, normalizeGoogleSheetId, requireEnv } from '../../integrations/google/env.mjs';
import { getSheetsClient } from '../../integrations/google/auth.mjs';
import { withGoogleApi, getGoogleApiMetrics } from '../../integrations/google/rate-limit.mjs';
import { bulkMatchPeople, enrichPerson } from '../../integrations/apollo/client.mjs';
import { ymd } from '../ids.mjs';

import {
  CONTACTS_MASTER_HEADER,
  buildMasterMaps,
  dumpJson,
  isLinkedInUrlOnSheet,
  makeContactId,
  makeRunId,
  normalizeLinkedInUrl,
  personToMasterRow,
} from './lib/contacts-helpers.mjs';
import { readLinkedInProfilesFile } from './lib/linkedin-urls.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILES_FILE = join(__dirname, 'linkedin-profiles.txt');
const DUMP_DIR_REL = process.env.JOBHUNT_STAGE4_DUMP_DIR || 'data/stage4';
const SLEEP_APOLLO_MS = 1200;
const MAX_URLS = Math.max(1, Number(process.env.JOBHUNT_STAGE4_MAX_URLS || 100));
const BULK_MATCH_BATCH = Math.min(
  10,
  Math.max(1, Number(process.env.JOBHUNT_APOLLO_BULK_MATCH_BATCH || 10))
);
const REVEAL_PERSONAL_EMAILS =
  String(process.env.JOBHUNT_APOLLO_REVEAL_PERSONAL_EMAILS || '').trim() === '1';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function bulkMatchLinkedInUrls(entries) {
  const matchedByUrl = new Map();
  let creditsEstimated = 0;

  for (let i = 0; i < entries.length; i += BULK_MATCH_BATCH) {
    const batch = entries.slice(i, i + BULK_MATCH_BATCH);
    const details = batch.map((e) => ({ linkedin_url: e.url }));
    const res = await bulkMatchPeople({ details, revealPersonalEmails: REVEAL_PERSONAL_EMAILS });

    for (const m of res.matches || []) {
      if (!m) continue;
      const key = normalizeLinkedInUrl(m.linkedin_url);
      if (key) matchedByUrl.set(key, m);
      if (m.email) creditsEstimated += 1;
    }

    await sleep(SLEEP_APOLLO_MS);
  }

  const results = [];
  for (const entry of entries) {
    const key = normalizeLinkedInUrl(entry.url);
    let person = matchedByUrl.get(key) || null;

    if (!person) {
      try {
        person = await enrichPerson({
          linkedinUrl: entry.url,
          revealPersonalEmails: REVEAL_PERSONAL_EMAILS,
        });
        await sleep(SLEEP_APOLLO_MS);
        if (person?.email) creditsEstimated += 1;
      } catch {
        person = null;
      }
    }

    results.push({
      entry,
      matched: !!person,
      person: person
        ? {
            ...person,
            linkedin_url: person.linkedin_url || entry.url,
          }
        : null,
    });
  }

  return { results, creditsEstimated };
}

await loadDotenv();
requireEnv('APOLLO_API_KEY');

const profilesPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : DEFAULT_PROFILES_FILE;

if (!existsSync(profilesPath)) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: `Missing profiles file: ${profilesPath}`,
        hint: 'cp jobhunt/stage4/linkedin-profiles.example.txt jobhunt/stage4/linkedin-profiles.txt',
      },
      null,
      2
    )
  );
  process.exit(1);
}

const entries = readLinkedInProfilesFile(profilesPath);
if (entries.length === 0) {
  console.error(JSON.stringify({ ok: false, error: 'No LinkedIn URLs in file' }, null, 2));
  process.exit(1);
}
if (entries.length > MAX_URLS) {
  console.error(
    JSON.stringify({ ok: false, error: `Max ${MAX_URLS} URLs per run (${entries.length} found)` }, null, 2)
  );
  process.exit(1);
}

const now = new Date();
const runId = makeRunId(now);
const dateStr = ymd(now);
const dumpDir = join(process.cwd(), DUMP_DIR_REL, runId);

const report = {
  ok: false,
  run_id: runId,
  input_file: profilesPath,
  urls_requested: entries.length,
  skipped_existing: 0,
  urls_enriched: 0,
  urls_matched: 0,
  urls_failed: 0,
  apollo_credits_estimated: 0,
  skipped_urls: [],
  failed_urls: [],
};

try {
  const sheets = await getSheetsClient();
  const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));
  const masterRows = await readContactsMasterValues(sheets, spreadsheetId);
  const maps = buildMasterMaps(masterRows);

  const needsEnrich = [];
  for (const entry of entries) {
    if (isLinkedInUrlOnSheet(entry.url, maps.masterByLinkedIn)) {
      report.skipped_existing += 1;
      report.skipped_urls.push({ url: entry.url, reason: 'already_on_sheet' });
    } else {
      needsEnrich.push(entry);
    }
  }

  report.urls_enriched = needsEnrich.length;

  const netNewRows = [];
  let creditsEstimated = 0;

  if (needsEnrich.length > 0) {
    const { results, creditsEstimated: credits } = await bulkMatchLinkedInUrls(needsEnrich);
    creditsEstimated = credits;

    for (const { entry, matched, person } of results) {
      if (!matched || !person) {
        report.urls_failed += 1;
        report.failed_urls.push({ url: entry.url, reason: 'apollo_no_match' });
        continue;
      }
      report.urls_matched += 1;

      const contactId = makeContactId(
        {
          apollo_person_id: person.apollo_person_id,
          linkedin_url: person.linkedin_url || entry.url,
          email: person.email,
          organizationName: person.organization?.name,
          name: person.name,
          title: person.title,
        },
        dateStr
      );

      netNewRows.push(
        personToMasterRow(
          { ...person, linkedin_url: person.linkedin_url || entry.url },
          { contactId, notesTag: entry.notesTag }
        )
      );
    }
  }

  report.apollo_credits_estimated = creditsEstimated;

  const importPayload = {
    fetched_at: now.toISOString(),
    run_id: runId,
    source: 'stage4',
    values: [[...CONTACTS_MASTER_HEADER], ...netNewRows],
  };

  const importPath = dumpJson(dumpDir, 'contacts-import.json', importPayload);
  report.import_snapshot = importPath;

  report.ok = true;
  report.google_api_metrics = getGoogleApiMetrics();
  dumpJson(dumpDir, 'run-summary.json', report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
  report.google_api_metrics = getGoogleApiMetrics();
  dumpJson(dumpDir, 'run-summary.json', report);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
