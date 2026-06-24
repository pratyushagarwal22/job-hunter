#!/usr/bin/env node
/**
 * stage3-contactmaster-outreach.mjs
 *
 * 1) Apollo discovery + bulk_match enrichment (no Claude per-contact personalization).
 * 2) Upsert discovered people into `CONTACTS_MASTER` using the NEW schema (core + outreach columns).
 * 3) In drafts-enabled mode, generate placeholder outreach drafts from disk templates (or fall back)
 *    and write email draft files under:
 *      OUTREACH/<COMPANY>/<ROLE_TYPE>/<person_email>/<timestamp>.txt
 *    Store Drive link in `CONTACTS_MASTER.email_draft_drive_link` and LI text in `linkedin_invite_text`.
 * 4) Always snapshot `CONTACTS_MASTER` to `career-ops/data/snapshots/contacts-master-*.json`
 *    so cleanup/rebuild can restore the new header/shape.
 *
 * Usage:
 *   JOBHUNT_STAGE3_OUTREACH_DRAFTS=0 npm run jobhunt:stage3   # core columns only
 *   JOBHUNT_STAGE3_OUTREACH_DRAFTS=1 npm run jobhunt:stage3   # populate outreach columns + OUTREACH drafts
 *
 * Required env:
 *   APOLLO_API_KEY
 *   GOOGLE_SHEET_ID
 *   GOOGLE_DRIVE_ROOT_FOLDER_ID
 */

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { loadDotenv, normalizeGoogleSheetId, requireEnv } from '../integrations/google/env.mjs';
import { getSheetsClient } from '../integrations/google/auth.mjs';
import { appendRows, updateRanges } from '../integrations/google/sheets.mjs';
import { withGoogleApi, getGoogleApiMetrics } from '../integrations/google/rate-limit.mjs';
import {
  getRootFolder,
  ensureSubfolders,
  ensureFolderPath,
  createTextFile,
} from '../integrations/google/drive.mjs';

import { ymd, slugifyFolderName } from './ids.mjs';
import { loadCandidateContext } from './lib/candidate-context.mjs';
import {
  applyDeterministicEmailSignature,
  parseCandidateFromProfileYaml,
  formatEmailFile,
} from './lib/claude-asset-generators.mjs';

import {
  searchPeopleApiSearch,
  bulkMatchPeople,
  guessDomainFromCompany,
  buildApiSearchQuery,
} from '../integrations/apollo/client.mjs';
import {
  RECRUITER_TITLES,
  HM_SENIORITIES,
  roleToHmTitleKeywords,
} from '../integrations/apollo/taxonomy.mjs';

import { buildDraftEmailAndLinkedIn, sanitizeEmailForFolder } from './lib/outreach-template.mjs';

await loadDotenv();

// Surface clear errors before we do any work.
requireEnv('APOLLO_API_KEY');
const sheets = await getSheetsClient();
const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));

/* ───────────────────────────── env config ─────────────────────────────── */

const DRAFTS_ENABLED = String(process.env.JOBHUNT_STAGE3_OUTREACH_DRAFTS ?? '0').trim() === '1';
const RUN_LIMIT = Number(process.env.JOBHUNT_STAGE3_LIMIT || 0);
const PROCESS_ALL_SHORTLIST_ROWS =
  String(process.env.JOBHUNT_STAGE3_PROCESS_ALL_SHORTLIST ?? '').trim() === '1';
const SMOKETEST_FAKE_CONTACTS =
  String(process.env.JOBHUNT_STAGE3_SMOKETEST_FAKE_CONTACTS ?? '').trim() === '1';

const PERSON_LOCATIONS = parseCsvEnv(
  process.env.JOBHUNT_APOLLO_PERSON_LOCATIONS,
  'United States,USA,United States of America,US'
);
const CONTACT_EMAIL_STATUS = parseCsvEnv(
  process.env.JOBHUNT_APOLLO_CONTACT_EMAIL_STATUS,
  'verified,likely to engage'
);

const BULK_MATCH_BATCH = Math.min(
  10,
  Math.max(1, Number(process.env.JOBHUNT_APOLLO_BULK_MATCH_BATCH || 10))
);

const REVEAL_PERSONAL_EMAILS =
  String(process.env.JOBHUNT_APOLLO_REVEAL_PERSONAL_EMAILS || '').trim() === '1';

const DUMP_DIR_REL = process.env.JOBHUNT_STAGE3_DUMP_DIR || 'data/stage3';
const SNAPSHOTS_DIR_REL = process.env.JOBHUNT_SNAPSHOTS_DIR || 'data/snapshots';

const SLEEP_APOLLO_MS = 1200;
const PER_KIND_DEFAULT_MAX = Math.max(
  1,
  Number(process.env.JOBHUNT_STAGE3_PER_KIND_DEFAULT_MAX || 40)
);
const PER_KIND_PRIORITY_MAX = Math.max(
  PER_KIND_DEFAULT_MAX,
  Number(process.env.JOBHUNT_STAGE3_PER_KIND_PRIORITY_MAX || 80)
);
const PER_COMPANY_TOTAL_MAX = Math.max(
  0,
  Number(process.env.JOBHUNT_STAGE3_PER_COMPANY_TOTAL_MAX || 50)
);

function parseCsvEnv(raw, fallback) {
  return String(raw == null || raw === '' ? fallback : raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ───────────────────────────── snapshot helpers ─────────────────────── */

const now = new Date();
const date = ymd(now);
const iso = now.toISOString();

function pad2(n) {
  return String(n).padStart(2, '0');
}

const runId = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(
  now.getHours()
)}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

function ensureDumpDir(dirPath) {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

function dumpJson(dirPath, filename, payload) {
  ensureDumpDir(dirPath);
  const path = join(dirPath, filename);
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return path;
}

function writeSnapshot(filename, payload) {
  const dir = join(process.cwd(), SNAPSHOTS_DIR_REL);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return path;
}

/* ───────────────────────────── core helpers ──────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getCell(row, idx) {
  return row && idx >= 0 && row[idx] != null ? String(row[idx]).trim() : '';
}

function makeContactId({ apollo_person_id, linkedin_url, email, organizationName, name, title }) {
  const ymdCompact = date.replace(/-/g, '');
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

function dedupKey(person) {
  if (person.apollo_person_id) return `id:${person.apollo_person_id}`;
  if (person.linkedin_url) return `li:${person.linkedin_url.toLowerCase()}`;
  if (person.email) return `em:${person.email.toLowerCase()}`;
  return `nm:${(person.name || '').toLowerCase()}|${(person.title || '').toLowerCase()}`;
}

function extractApolloIdFromNotes(notes) {
  const m = String(notes || '').match(/apollo_person_id\s*=\s*([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}

function inferRoleArchetype(role) {
  const r = String(role || '').toLowerCase();
  if (/\b(product manager|technical product manager|product analyst|product data|apm|product operations)\b/.test(r)) {
    return 'PRODUCT';
  }
  if (/\b(business intelligence|bi analyst|bi engineer|bi developer|power bi|tableau|looker|snowflake)\b/.test(r)) {
    return 'BI';
  }
  if (/\b(data engineer|analytics engineer|etl|databricks|airflow|pyspark|spark|dbt|bigquery|warehouse)\b/.test(r)) {
    return 'DE';
  }
  if (/\b(software engineer|software development|sde|backend|fullstack|full-stack)\b/.test(r)) {
    return 'SWE';
  }
  return 'ANALYST';
}

function inferTeamType(roleArchetype, personKind) {
  const k = String(personKind || '').toUpperCase();
  if (k === 'RECRUITER') return 'Recruiter';
  if (k === 'HIRING_MANAGER') {
    if (roleArchetype === 'PRODUCT') return 'Product';
    if (roleArchetype === 'ANALYST' || roleArchetype === 'BI') return 'Analytics';
    return 'Engineering';
  }
  if (roleArchetype === 'PRODUCT') return 'Product';
  if (roleArchetype === 'ANALYST' || roleArchetype === 'BI') return 'Analytics';
  return 'Engineering';
}

function buildFakeCandidates({ company, role }) {
  // Minimal deterministic dataset that exercises:
  // - CONTACTS_MASTER upsert
  // - role_archetype/team_type population in drafts mode
  // - OUTREACH draft file writing + Drive link persistence
  const roleArchetype = inferRoleArchetype(role);

  const base = {
    organization: { name: company, primary_domain: `${slugifyFolderName(company)}.example` },
    title: `${roleArchetype} outreach contact`,
    seniority: 'entry',
  };

  return [
    {
      ...base,
      apollo_person_id: 'FAKE-APOLLO-1',
      kind: 'RECRUITER',
      name: 'Jordan Lee',
      first_name: 'Jordan',
      linkedin_url: 'https://www.linkedin.com/in/jordanlee',
      email: 'jordan.lee@example.com',
      email_confidence: 'high',
      email_status: 'verified',
      departments: ['Talent Acquisition'],
    },
    {
      ...base,
      apollo_person_id: 'FAKE-APOLLO-2',
      kind: 'HIRING_MANAGER',
      name: 'Sam Patel',
      first_name: 'Sam',
      linkedin_url: 'https://www.linkedin.com/in/sampatel',
      email: 'sam.patel@example.com',
      email_confidence: 'high',
      email_status: 'verified',
      departments: ['Analytics'],
    },
  ];
}

async function paginateApiSearch({
  domains,
  titles,
  seniorities,
  kind,
  cap,
  seen = null,
  startPage = 1,
}) {
  const collected = [];
  const seenKeys = seen || new Set();
  let page = startPage;
  const perPage = 100;
  while (collected.length < cap && page <= 500) {
    let res;
    try {
      res = await searchPeopleApiSearch({
        domains,
        titles,
        seniorities,
        locations: PERSON_LOCATIONS,
        emailStatuses: CONTACT_EMAIL_STATUS,
        page,
        perPage,
      });
    } catch (err) {
      throw new Error(`Apollo api_search ${kind} page ${page} failed: ${err?.message || err}`);
    }

    const people = res.people || [];
    for (const p of people) {
      const key = dedupKey(p);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      collected.push({ ...p, kind });
      if (collected.length >= cap) break;
    }

    if (people.length === 0) break;
    if (res.total_pages && page >= res.total_pages) break;
    if (people.length < res.per_page) break;
    page += 1;
    await sleep(SLEEP_APOLLO_MS);
  }

  return {
    collected: collected.slice(0, cap),
    seen: seenKeys,
    nextPage: page,
  };
}

function lookupExisting(person, masterByApolloId, masterByLinkedIn, masterByEmail) {
  const apolloId = person.apollo_person_id || '';
  const liKey = (person.linkedin_url || '').toLowerCase();
  const emKey = (person.email || '').toLowerCase();
  if (apolloId && masterByApolloId.has(apolloId)) return masterByApolloId.get(apolloId);
  if (liKey && masterByLinkedIn.has(liKey)) return masterByLinkedIn.get(liKey);
  if (emKey && masterByEmail.has(emKey)) return masterByEmail.get(emKey);
  return null;
}

async function discoverContactsWithDynamicCap({ domains, role, remaining }) {
  const seen = new Set();
  const firstSplit = Math.ceil(remaining / 2);

  const recruiterPass = await paginateApiSearch({
    domains,
    titles: RECRUITER_TITLES,
    seniorities: undefined,
    kind: 'RECRUITER',
    cap: firstSplit,
    seen,
    startPage: 1,
  });
  await sleep(SLEEP_APOLLO_MS);

  let recruiters = recruiterPass.collected;
  let nextRecruiterPage = recruiterPass.nextPage;

  const hmCap = remaining - recruiters.length;
  const hmPass = await paginateApiSearch({
    domains,
    titles: roleToHmTitleKeywords(role),
    seniorities: HM_SENIORITIES,
    kind: 'HIRING_MANAGER',
    cap: hmCap,
    seen: recruiterPass.seen,
    startPage: 1,
  });
  await sleep(SLEEP_APOLLO_MS);

  let hms = hmPass.collected;
  let nextHmPage = hmPass.nextPage;
  let sharedSeen = hmPass.seen;

  let slack = remaining - recruiters.length - hms.length;
  let backfillRecruiters = 0;
  let backfillHms = 0;

  if (slack > 0 && recruiters.length >= firstSplit) {
    const extra = await paginateApiSearch({
      domains,
      titles: RECRUITER_TITLES,
      seniorities: undefined,
      kind: 'RECRUITER',
      cap: slack,
      seen: sharedSeen,
      startPage: nextRecruiterPage,
    });
    await sleep(SLEEP_APOLLO_MS);
    backfillRecruiters = extra.collected.length;
    recruiters = [...recruiters, ...extra.collected];
    sharedSeen = extra.seen;
    nextRecruiterPage = extra.nextPage;
    slack -= extra.collected.length;
  }

  if (slack > 0 && hms.length >= hmCap) {
    const extra = await paginateApiSearch({
      domains,
      titles: roleToHmTitleKeywords(role),
      seniorities: HM_SENIORITIES,
      kind: 'HIRING_MANAGER',
      cap: slack,
      seen: sharedSeen,
      startPage: nextHmPage,
    });
    await sleep(SLEEP_APOLLO_MS);
    backfillHms = extra.collected.length;
    hms = [...hms, ...extra.collected];
  }

  return {
    recruiters,
    hms,
    backfillRecruiters,
    backfillHms,
    firstSplit,
    hmCap,
  };
}

async function bulkMatchInBatches(people) {
  const batches = [];
  for (let i = 0; i < people.length; i += BULK_MATCH_BATCH) {
    batches.push(people.slice(i, i + BULK_MATCH_BATCH));
  }

  const matchedByLi = new Map();
  const matchedById = new Map();
  let creditsEstimated = 0;
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const details = batch
      .filter((p) => p.linkedin_url || p.apollo_person_id)
      .map((p) => ({
        linkedin_url: p.linkedin_url || undefined,
        id: p.apollo_person_id || undefined,
        first_name: p.first_name || undefined,
        last_name: p.name && p.first_name ? p.name.replace(p.first_name, '').trim() : undefined,
        organization_name: p.organization?.name || undefined,
        domain: p.organization?.primary_domain || undefined,
      }));

    if (details.length === 0) continue;
    const res = await bulkMatchPeople({ details, revealPersonalEmails: REVEAL_PERSONAL_EMAILS });

    for (const m of res.matches || []) {
      if (!m) continue;
      const li = (m.linkedin_url || '').toLowerCase();
      if (li) matchedByLi.set(li, m);
      if (m.apollo_person_id) matchedById.set(m.apollo_person_id, m);
      if (m.email) creditsEstimated += 1;
    }

    await sleep(SLEEP_APOLLO_MS);
  }

  // Mutate with best-effort enriched fields
  const enriched = people.map((p) => {
    const id = p.apollo_person_id || '';
    const li = (p.linkedin_url || '').toLowerCase();
    const m = (id && matchedById.get(id)) || (li && matchedByLi.get(li)) || null;
    if (!m) return p;
    return {
      ...p,
      linkedin_url: m.linkedin_url || p.linkedin_url || '',
      email: m.email || p.email || '',
      email_status: m.email_status || p.email_status,
      email_confidence: m.email_confidence || p.email_confidence,
    };
  });

  return { enriched, creditsEstimated };
}

/* ───────────────────────────── priority companies ───────────────────── */

function loadPriorityCompanies() {
  const path = join(process.cwd(), 'config', 'priority-companies.yml');
  if (!existsSync(path)) return [];
  try {
    const doc = yaml.load(readFileSync(path, 'utf-8'));
    const list = Array.isArray(doc?.priority_companies) ? doc.priority_companies : [];
    return list
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!name) return null;
        const domainSingle = typeof entry.domain === 'string' ? entry.domain.trim() : '';
        let domains = [];
        if (Array.isArray(entry.domains) && entry.domains.length > 0) {
          domains = entry.domains.map((d) => String(d || '').trim()).filter(Boolean);
        } else if (domainSingle) {
          domains = [domainSingle];
        }
        return {
          name,
          name_lc: name.toLowerCase(),
          domain: domains[0] || domainSingle || '',
          domains,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error(`[stage3] Failed to parse priority-companies.yml: ${err?.message || err}`);
    return [];
  }
}

function pickPriorityEntry(priorityList, company) {
  const target = String(company || '').trim().toLowerCase();
  if (!target) return null;
  return priorityList.find((p) => p.name_lc === target) || null;
}

function resolveApolloDomainsForCompany(company, priorityEntry) {
  if (priorityEntry?.domains?.length) return priorityEntry.domains;
  const g = guessDomainFromCompany(company);
  return g ? [g] : [];
}

function pickCapForCompany(priorityEntry) {
  return priorityEntry ? PER_KIND_PRIORITY_MAX : PER_KIND_DEFAULT_MAX;
}

/* ───────────────────────────── main ─────────────────────────────────── */

const report = {
  ok: false,
  run_id: runId,
  drafts_enabled: DRAFTS_ENABLED,
  per_company_total_max: PER_COMPANY_TOTAL_MAX || null,
  processed: 0,
  skipped_no_assets: 0,
  skipped_already_has_contacts: 0,
  contacts_created: 0,
  contacts_reused: 0,
  apollo_credits_estimated: 0,
  errors: [],
  jobs: [],
};

try {
  const context = loadCandidateContext();
  const candidate = parseCandidateFromProfileYaml(context.profile);
  const priorityCompanies = loadPriorityCompanies();

  const dumpDir = join(process.cwd(), DUMP_DIR_REL, runId);
  ensureDumpDir(dumpDir);

  /* ------------ read sheets ------------ */
  const shortlistRes = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'SHORTLIST!A1:K',
    })
  );
  const shortlistRows = shortlistRes.data.values || [];
  if (shortlistRows.length <= 1) {
    report.ok = true;
    report.note = 'No rows in SHORTLIST';
    report.google_api_metrics = getGoogleApiMetrics();
    dumpJson(dumpDir, 'run-summary.json', report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const slHeader = shortlistRows[0];
  const slIdx = {
    job_id: slHeader.indexOf('job_id'),
    pursue: slHeader.indexOf('pursue'),
    company: slHeader.indexOf('company'),
    role: slHeader.indexOf('role'),
  };

  // CONTACTS_MASTER snapshot input for dedupe + row indices.
  const masterRes = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'CONTACTS_MASTER!A1:T',
    })
  );
  const masterRows = masterRes.data.values || [];
  const masterByApolloId = new Map(); // apollo_person_id -> { rowIndex, contactId }
  const masterByLinkedIn = new Map(); // li lc -> { rowIndex, contactId }
  const masterByEmail = new Map(); // email lc -> { rowIndex, contactId }
  const masterByContactId = new Map(); // contact_id -> { rowIndex }

  for (let i = 1; i < masterRows.length; i++) {
    const r = masterRows[i];
    const cid = getCell(r, 0);
    const companyRaw = getCell(r, 1);
    const liRaw = getCell(r, 5);
    const emRaw = getCell(r, 6);
    const notes = getCell(r, 11);
    const apolloId = extractApolloIdFromNotes(notes);
    const rowIndex = i + 1;
    if (cid) masterByContactId.set(cid, { rowIndex });
    if (apolloId) masterByApolloId.set(apolloId, { rowIndex, contactId: cid });
    const li = liRaw.toLowerCase();
    const em = emRaw.toLowerCase();
    if (li) masterByLinkedIn.set(li, { rowIndex, contactId: cid });
    if (em) masterByEmail.set(em, { rowIndex, contactId: cid });
  }

  const contactsCountByCompany = new Map();
  for (let i = 1; i < masterRows.length; i++) {
    const companyKey = getCell(masterRows[i], 1).toLowerCase();
    if (companyKey) {
      contactsCountByCompany.set(companyKey, (contactsCountByCompany.get(companyKey) || 0) + 1);
    }
  }

  /* ------------ Drive setup (only when outreach drafts enabled) ------------ */
  let outBucketId = null;
  if (DRAFTS_ENABLED) {
    const { rootFolder } = await getRootFolder();
    const sub = await ensureSubfolders(rootFolder.id);
    const bucketIdByName = new Map((sub.folders || []).map((f) => [f.name, f.id]));
    outBucketId = bucketIdByName.get('OUTREACH');
    if (!outBucketId) throw new Error('Missing Drive bucket: OUTREACH');
  }

  /* ------------ per-PURSUE iteration ------------ */
  let processedJobs = 0;
  for (let r = 1; r < shortlistRows.length; r++) {
    if (RUN_LIMIT > 0 && processedJobs >= RUN_LIMIT) break;
    const row = shortlistRows[r];
    const pursue = getCell(row, slIdx.pursue);
    if (pursue !== 'PURSUE' && !PROCESS_ALL_SHORTLIST_ROWS) continue;

    const job_id = getCell(row, slIdx.job_id);
    const company = getCell(row, slIdx.company);
    const role = getCell(row, slIdx.role);
    if (!job_id || !company) continue;

    const priorityEntry = pickPriorityEntry(priorityCompanies, company);
    const cap = pickCapForCompany(priorityEntry);
    const domains = resolveApolloDomainsForCompany(company, priorityEntry);
    const existingCompanyCount = contactsCountByCompany.get(company.trim().toLowerCase()) || 0;
    const remainingQuota =
      PER_COMPANY_TOTAL_MAX > 0 ? PER_COMPANY_TOTAL_MAX - existingCompanyCount : null;

    const jobReport = {
      job_id,
      company,
      role,
      cap_per_kind: PER_COMPANY_TOTAL_MAX > 0 ? null : cap,
      per_company_total_max: PER_COMPANY_TOTAL_MAX > 0 ? PER_COMPANY_TOTAL_MAX : null,
      existing_company_count: existingCompanyCount,
      remaining_quota: remainingQuota,
      target_total: PER_COMPANY_TOTAL_MAX > 0 ? PER_COMPANY_TOTAL_MAX : null,
      recruiters_found: 0,
      hms_found: 0,
      total_found: 0,
      partial_fill: false,
      backfill_recruiters: 0,
      backfill_hms: 0,
      bulk_match_skipped_known: 0,
      skipped_reason: null,
      priority_company: !!priorityEntry,
      kind_counts: { RECRUITER: 0, HIRING_MANAGER: 0 },
      contacts_created: 0,
      contacts_reused: 0,
      apollo_credits_estimated: 0,
      zero_results: false,
      apollo_dumps: [],
      warnings: [],
      errors: [],
    };

    try {
      if (PER_COMPANY_TOTAL_MAX > 0 && remainingQuota <= 0) {
        jobReport.skipped_reason = 'company_at_quota';
        jobReport.warnings.push(
          `Company already has ${existingCompanyCount} contacts (quota ${PER_COMPANY_TOTAL_MAX}); skipping.`
        );
        report.skipped_already_has_contacts++;
        report.processed++;
        processedJobs++;
        report.jobs.push(jobReport);
        continue;
      }

      if (!domains.length) {
        jobReport.warnings.push('No domain resolved (priority-yaml missing and guess failed); skipping.');
        report.processed++;
        processedJobs++;
        report.jobs.push(jobReport);
        continue;
      }

      // Apollo discovery + enrichment OR deterministic smoketest contacts.
      let enriched = [];
      let creditsEstimated = 0;

      if (SMOKETEST_FAKE_CONTACTS) {
        enriched = buildFakeCandidates({ company, role });
        creditsEstimated = 0;
        jobReport.zero_results = false;
        jobReport.warnings.push('SMOKETEST_FAKE_CONTACTS enabled: bypassed Apollo calls.');
      } else {
        let recruiters = [];
        let hms = [];
        let backfillRecruiters = 0;
        let backfillHms = 0;

        if (PER_COMPANY_TOTAL_MAX > 0) {
          const discovery = await discoverContactsWithDynamicCap({
            domains,
            role,
            remaining: remainingQuota,
          });
          recruiters = discovery.recruiters;
          hms = discovery.hms;
          backfillRecruiters = discovery.backfillRecruiters;
          backfillHms = discovery.backfillHms;
          jobReport.backfill_recruiters = backfillRecruiters;
          jobReport.backfill_hms = backfillHms;
        } else {
          const recruiterPass = await paginateApiSearch({
            domains,
            titles: RECRUITER_TITLES,
            seniorities: undefined,
            kind: 'RECRUITER',
            cap,
          });
          await sleep(SLEEP_APOLLO_MS);
          recruiters = recruiterPass.collected;

          const hmPass = await paginateApiSearch({
            domains,
            titles: roleToHmTitleKeywords(role),
            seniorities: HM_SENIORITIES,
            kind: 'HIRING_MANAGER',
            cap,
          });
          await sleep(SLEEP_APOLLO_MS);
          hms = hmPass.collected;
        }

        jobReport.recruiters_found = recruiters.length;
        jobReport.hms_found = hms.length;
        jobReport.total_found = recruiters.length + hms.length;
        jobReport.partial_fill =
          PER_COMPANY_TOTAL_MAX > 0 && jobReport.total_found < remainingQuota;
        jobReport.kind_counts.RECRUITER = recruiters.length;
        jobReport.kind_counts.HIRING_MANAGER = hms.length;

        if (recruiters.length < 1) jobReport.warnings.push(`Recruiter count (${recruiters.length}) is zero.`);
        if (hms.length < 1) jobReport.warnings.push(`Hiring-manager count (${hms.length}) is zero.`);
        const zeroResults = recruiters.length === 0 && hms.length === 0;
        jobReport.zero_results = zeroResults;

        const allCandidatesRaw = [...recruiters, ...hms];

        // Dump discovery dump (for debugging + future replay).
        dumpJson(dumpDir, `${job_id}-search.json`, {
          job_id,
          company,
          role,
          domains,
          cap_per_kind: PER_COMPANY_TOTAL_MAX > 0 ? null : cap,
          per_company_total_max: PER_COMPANY_TOTAL_MAX > 0 ? PER_COMPANY_TOTAL_MAX : null,
          remaining_quota: remainingQuota,
          recruiter_count: recruiters.length,
          hm_count: hms.length,
          backfill_recruiters: backfillRecruiters,
          backfill_hms: backfillHms,
          zero_results: zeroResults,
          people: allCandidatesRaw.map((p) => ({
            apollo_person_id: p.apollo_person_id,
            name: p.name,
            first_name: p.first_name,
            title: p.title,
            seniority: p.seniority,
            linkedin_url: p.linkedin_url,
            email: p.email,
            organization: p.organization?.name || '',
            kind: p.kind,
            email_status_in_search: p.email_status,
          })),
        });

        // Dedup within this job.
        const seenInRun = new Set();
        const survivors = [];
        for (const cand of allCandidatesRaw) {
          const k = dedupKey(cand);
          if (seenInRun.has(k)) continue;
          seenInRun.add(k);
          survivors.push(cand);
        }

        // Enrich via bulk_match only for net-new contacts (skip known in master).
        const needsReveal = [];
        const alreadyKnown = [];
        for (const p of survivors) {
          const existing = lookupExisting(p, masterByApolloId, masterByLinkedIn, masterByEmail);
          if (existing) alreadyKnown.push(p);
          else needsReveal.push(p);
        }
        jobReport.bulk_match_skipped_known = alreadyKnown.length;

        const out = await bulkMatchInBatches(needsReveal);
        enriched = [...alreadyKnown, ...out.enriched];
        creditsEstimated = out.creditsEstimated;
        jobReport.contacts = [];
      }

      jobReport.apollo_credits_estimated = creditsEstimated;
      report.apollo_credits_estimated += creditsEstimated;

      // Upsert into CONTACTS_MASTER.
      const seenContactIds = new Set();
      const pendingMasterCreates = [];
      const pendingMasterUpdates = [];

      const nowIso = iso;

      // Column letters for the upsert ranges:
      // A contact_id, B company, C team, D name, E title, F linkedin_url, G email,
      // H email_source, I email_confidence, J last_contacted_at, K last_contacted_job_id, L notes,
      // M role_archetype, N team_type, O email_draft_drive_link, P linkedin_invite_text,
      // Q email_status, R linkedin_status, S last_email_sent_at, T last_reply_at
      const lastContactedAtRangeLetter = 'J';
      const lastContactedJobIdRangeLetter = 'K';

      const draftsRangeStart = 'M';
      const draftsRangeEnd = 'T';

      const draftNow = new Date().toISOString();

      for (const person of enriched) {
        if (seenContactIds.size > 5000) break; // sanity
        const apolloId = person.apollo_person_id || '';
        const liKey = (person.linkedin_url || '').toLowerCase();
        const emKey = (person.email || '').toLowerCase();

        let existing = lookupExisting(person, masterByApolloId, masterByLinkedIn, masterByEmail);

        const roleArchetype = inferRoleArchetype(role);
        const recipientKind = String(person.kind || '').toUpperCase();
        const teamType = inferTeamType(roleArchetype, recipientKind);

        const contact_id = makeContactId({
          apollo_person_id: person.apollo_person_id,
          linkedin_url: person.linkedin_url,
          email: person.email,
          organizationName: person.organization?.name || company,
          name: person.name,
          title: person.title,
        });

        if (seenContactIds.has(contact_id)) continue;
        seenContactIds.add(contact_id);

        // Draft generation (smoketest placeholder-first).
        let email_draft_drive_link = '';
        let linkedin_invite_text = '';
        let email_status = '';
        let linkedin_status = '';
        let last_email_sent_at = '';
        let last_reply_at = '';

        if (DRAFTS_ENABLED) {
          const personName = person.first_name || (person.name ? person.name.split(/\s+/)[0] : '') || '';

          const { email, linkedin } = buildDraftEmailAndLinkedIn({
            roleArchetype,
            recipientKind,
            company,
            personName,
          });

          const emailBodyWithSignature = applyDeterministicEmailSignature(email?.body || '', candidate);
          const finalEmail = {
            subject: email?.subject || `Interest in ${roleArchetype} — ${candidate.full_name || 'Pratyush'}`,
            body: emailBodyWithSignature,
          };

          linkedin_invite_text = String(linkedin || '').trim();
          linkedin_status = linkedin_invite_text ? 'DRAFTED' : '';
          last_reply_at = '';

          if (person.email) {
            const emailFileText = formatEmailFile(finalEmail);

            const companyFolderName = slugifyFolderName(company);
            const roleFolderName = slugifyFolderName(roleArchetype);
            const personEmailFolderName = slugifyFolderName(sanitizeEmailForFolder(person.email));

            const timestamp = draftNow.replace(/[-:.TZ]/g, '').slice(0, 14);
            const filename = `${timestamp}.txt`;

            const { folderId } = await ensureFolderPath(outBucketId, [
              companyFolderName,
              roleFolderName,
              personEmailFolderName,
            ]);

            const f = await createTextFile(folderId, filename, emailFileText);
            email_draft_drive_link = f.webViewLink;
            email_status = 'DRAFTED';
            last_email_sent_at = draftNow;
          }
        }

        const team =
          recipientKind === 'HIRING_MANAGER' ? (person.departments || []).join(', ') : 'Talent Acquisition';

        const notes = apolloId ? `apollo_person_id=${apolloId}; kind=${recipientKind}` : `kind=${recipientKind}`;

        if (existing) {
          if (existing.rowIndex > 0) {
            // Update last-contact core fields and optionally draft fields.
            pendingMasterUpdates.push({
              range: `CONTACTS_MASTER!J${existing.rowIndex}:K${existing.rowIndex}`,
              values: [[nowIso, job_id]],
            });

            if (DRAFTS_ENABLED) {
              pendingMasterUpdates.push({
                range: `CONTACTS_MASTER!${draftsRangeStart}${existing.rowIndex}:${draftsRangeEnd}${existing.rowIndex}`,
                values: [[
                  roleArchetype,
                  teamType,
                  email_draft_drive_link,
                  linkedin_invite_text,
                  email_status,
                  linkedin_status,
                  last_email_sent_at,
                  last_reply_at,
                ]],
              });
            }

            jobReport.contacts_reused = jobReport.contacts_reused + 1;
            report.contacts_reused++;
          } else {
            // Pending create from an earlier job in this run — skip duplicate row.
            jobReport.contacts_reused = jobReport.contacts_reused + 1;
            report.contacts_reused++;
          }
        } else {
          const masterRow = [
            contact_id,
            person.organization?.name || company,
            team,
            person.name || '',
            person.title || '',
            person.linkedin_url || '',
            person.email || '',
            person.email ? 'apollo' : '',
            person.email_confidence || '',
            nowIso,
            job_id,
            notes,
            DRAFTS_ENABLED ? roleArchetype : '',
            DRAFTS_ENABLED ? teamType : '',
            DRAFTS_ENABLED ? email_draft_drive_link : '',
            DRAFTS_ENABLED ? linkedin_invite_text : '',
            DRAFTS_ENABLED ? email_status : '',
            DRAFTS_ENABLED ? linkedin_status : '',
            DRAFTS_ENABLED ? last_email_sent_at : '',
            DRAFTS_ENABLED ? last_reply_at : '',
          ];

          pendingMasterCreates.push(masterRow);
          jobReport.contacts_created = jobReport.contacts_created + 1;
          report.contacts_created++;

          // Prime maps so later candidates in this run dedupe properly.
          masterByContactId.set(contact_id, { rowIndex: -1 });
          if (apolloId) masterByApolloId.set(apolloId, { rowIndex: -1, contactId: contact_id });
          if (liKey) masterByLinkedIn.set(liKey, { rowIndex: -1, contactId: contact_id });
          if (emKey) masterByEmail.set(emKey, { rowIndex: -1, contactId: contact_id });
        }
      }

      // Flush creates and updates for this job.
      try {
        if (pendingMasterCreates.length) {
          await appendRows('CONTACTS_MASTER', pendingMasterCreates);
          const companyKey = company.trim().toLowerCase();
          contactsCountByCompany.set(
            companyKey,
            (contactsCountByCompany.get(companyKey) || 0) + pendingMasterCreates.length
          );
        }
        if (pendingMasterUpdates.length) {
          await updateRanges(pendingMasterUpdates, 'RAW');
        }
      } catch (flushErr) {
        jobReport.errors.push({ error: flushErr?.message || String(flushErr) });
      }

      // Small per-job dump.
      dumpJson(dumpDir, `${job_id}-upsert-summary.json`, {
        job_id,
        role,
        company,
        drafts_enabled: DRAFTS_ENABLED,
        created: pendingMasterCreates.length,
        updated: pendingMasterUpdates.length,
        apollo_people_enriched: enriched.length,
      });

      report.processed++;
      processedJobs++;
      report.jobs.push(jobReport);
    } catch (err) {
      report.errors.push({ job_id, company, role, error: err?.message || String(err) });
      report.jobs.push({ job_id, company, role, error: err?.message || String(err) });
      report.processed++;
      processedJobs++;
    }
  }

  /* ------------ snapshot CONTACTS_MASTER ------------ */
  const snapshotRes = await withGoogleApi('sheetsRead', () =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'CONTACTS_MASTER!A1:T',
    })
  );
  const values = snapshotRes.data.values || [];
  const payload = {
    fetched_at: new Date().toISOString(),
    run_id: runId,
    values,
  };

  const historyPath = writeSnapshot(`contacts-master-${runId}.json`, payload);
  const latestPath = writeSnapshot('contacts-master-latest.json', payload);
  report.contacts_master_snapshot = {
    ok: true,
    path: latestPath,
    history_path: historyPath,
    rows: Math.max(0, values.length - 1),
  };

  report.ok = report.errors.length === 0;
  report.google_api_metrics = getGoogleApiMetrics();
  dumpJson(dumpDir, 'run-summary.json', report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors.length === 0 ? 0 : 1);
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
  report.google_api_metrics = getGoogleApiMetrics();
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

