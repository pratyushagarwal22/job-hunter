#!/usr/bin/env node
/**
 * stage3-outreach-contacts.mjs
 *
 * After Stage 2 has finished generating ASSETS, find recruiter / hiring-manager
 * contacts for every PURSUE row via Apollo.io, deduplicate them in CONTACTS_MASTER,
 * generate per-contact email + LinkedIn invite drafts via Claude, and write one
 * CONTACTS row per (job_id, contact).
 *
 * No mail or LinkedIn message is ever sent — drafts only.
 *
 * Usage:
 *   npm run jobhunt:stage3
 *
 * Tunables (env):
 *   APOLLO_API_KEY                        (required)
 *   ANTHROPIC_API_KEY                     (required, used by Claude generators)
 *   JOBHUNT_STAGE3_PER_KIND_MIN=2
 *   JOBHUNT_STAGE3_PER_KIND_MAX=10        (FAANG-scale orgs: doubled, see below)
 *   JOBHUNT_STAGE3_BIGCO_EMPLOYEE_THRESHOLD=5000
 *   JOBHUNT_STAGE3_LIMIT=                 cap PURSUE rows processed per run (dry-run)
 *   JOBHUNT_REGENERATE_CONTACTS=1         re-run for jobs that already have CONTACTS rows
 */

import crypto from 'node:crypto';

import { loadDotenv } from '../integrations/google/env.mjs';
import { getSheetsClient } from '../integrations/google/auth.mjs';
import { normalizeGoogleSheetId, requireEnv } from '../integrations/google/env.mjs';
import { appendRow } from '../integrations/google/sheets.mjs';
import {
  getRootFolder,
  ensureSubfolders,
  ensureFolderPath,
  createTextFile,
  parseDriveFileId,
  exportFileUtf8,
} from '../integrations/google/drive.mjs';
import { createAnthropicClient } from '../integrations/anthropic/config.mjs';
import { ymd, slugifyFolderName } from './ids.mjs';
import { loadCandidateContext } from './lib/candidate-context.mjs';
import {
  generatePersonalizedRecruiterEmail,
  generatePersonalizedLinkedInInvite,
  formatEmailFile,
} from './lib/claude-asset-generators.mjs';
import {
  searchOrganization,
  searchPeople,
  enrichPerson,
  guessDomainFromCompany,
} from '../integrations/apollo/client.mjs';
import {
  RECRUITER_TITLES,
  HM_SENIORITIES,
  roleToDepartments,
  roleToHmTitleKeywords,
} from '../integrations/apollo/taxonomy.mjs';

await loadDotenv();

const sheets = await getSheetsClient();
const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));

const PER_KIND_MIN = Math.max(1, Number(process.env.JOBHUNT_STAGE3_PER_KIND_MIN || 2));
const PER_KIND_MAX = Math.max(PER_KIND_MIN, Number(process.env.JOBHUNT_STAGE3_PER_KIND_MAX || 10));
const BIGCO_THRESHOLD = Math.max(0, Number(process.env.JOBHUNT_STAGE3_BIGCO_EMPLOYEE_THRESHOLD || 5000));
const RUN_LIMIT = Number(process.env.JOBHUNT_STAGE3_LIMIT || 0);
const REGENERATE = String(process.env.JOBHUNT_REGENERATE_CONTACTS || '').trim() === '1';

const SLEEP_APOLLO_MS = 1200;
const SLEEP_CLAUDE_MS = 1500;

const now = new Date();
const date = ymd(now);
const iso = now.toISOString();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getCell(row, idx) {
  return row && idx >= 0 && row[idx] != null ? String(row[idx]).trim() : '';
}

function makeContactId({ linkedin_url, email, organizationName, name, title }) {
  const ymdCompact = date.replace(/-/g, '');
  const base = String(
    linkedin_url ||
      email ||
      `${organizationName || ''}::${name || ''}::${title || ''}`
  )
    .toLowerCase()
    .trim();
  const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 8).toUpperCase();
  return `CT-${ymdCompact}-${hash}`;
}

const report = {
  ok: false,
  processed: 0,
  skipped_no_assets: 0,
  skipped_already_has_contacts: 0,
  contacts_created: 0,
  contacts_reused: 0,
  errors: [],
  jobs: [],
};

try {
  const context = loadCandidateContext();
  let claude = null;

  /* ------------ read sheets ------------ */
  const shortlistRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'SHORTLIST!A1:K',
  });
  const shortlistRows = shortlistRes.data.values || [];
  if (shortlistRows.length <= 1) {
    report.ok = true;
    report.note = 'No rows in SHORTLIST';
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

  const assetsRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'ASSETS!A1:N',
  });
  const assetsRows = assetsRes.data.values || [];
  const assetsByJobId = new Map();
  if (assetsRows.length > 1) {
    const aHeader = assetsRows[0];
    const aIdx = {
      job_id: aHeader.indexOf('job_id'),
      jd_drive_link: aHeader.indexOf('jd_drive_link'),
      resume_summary: aHeader.indexOf('resume_summary'),
    };
    for (let i = 1; i < assetsRows.length; i++) {
      const r = assetsRows[i];
      const id = getCell(r, aIdx.job_id);
      if (!id) continue;
      assetsByJobId.set(id, {
        jd_drive_link: getCell(r, aIdx.jd_drive_link),
        resume_summary: getCell(r, aIdx.resume_summary),
      });
    }
  }

  const contactsRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'CONTACTS!A1:O',
  });
  const contactsRows = contactsRes.data.values || [];
  const existingContactsByJob = new Map(); // job_id -> Set of contact_ids
  for (let i = 1; i < contactsRows.length; i++) {
    const r = contactsRows[i];
    const cid = getCell(r, 0);
    const jid = getCell(r, 1);
    if (!cid || !jid) continue;
    if (!existingContactsByJob.has(jid)) existingContactsByJob.set(jid, new Set());
    existingContactsByJob.get(jid).add(cid);
  }

  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'CONTACTS_MASTER!A1:L',
  });
  const masterRows = masterRes.data.values || [];
  const masterByLinkedIn = new Map(); // linkedin (lc) -> { rowIndex, contactId }
  const masterByEmail = new Map(); // email (lc) -> { rowIndex, contactId }
  const masterByContactId = new Map(); // contactId -> { rowIndex }
  for (let i = 1; i < masterRows.length; i++) {
    const r = masterRows[i];
    const cid = getCell(r, 0);
    const li = getCell(r, 5).toLowerCase();
    const em = getCell(r, 6).toLowerCase();
    const rowIndex = i + 1;
    if (cid) masterByContactId.set(cid, { rowIndex });
    if (li) masterByLinkedIn.set(li, { rowIndex, contactId: cid });
    if (em) masterByEmail.set(em, { rowIndex, contactId: cid });
  }

  /* ------------ Drive setup (lazy per-job) ------------ */
  const { rootFolder } = await getRootFolder();
  const sub = await ensureSubfolders(rootFolder.id);
  const bucketIdByName = new Map((sub.folders || []).map((f) => [f.name, f.id]));

  /* ------------ Apollo helpers ------------ */
  async function pullPeopleForKind({ kind, orgFilter, role }) {
    const isHM = kind === 'HIRING_MANAGER';
    const baseParams = { ...orgFilter, perPage: 25 };
    if (isHM) {
      baseParams.seniorities = HM_SENIORITIES;
      baseParams.titles = roleToHmTitleKeywords(role);
      baseParams.departments = roleToDepartments(role);
    } else {
      baseParams.titles = RECRUITER_TITLES;
    }

    const collected = [];
    const seenIds = new Set();
    let page = 1;
    while (true) {
      const res = await searchPeople({ ...baseParams, page });
      for (const p of res.people || []) {
        const key = p.apollo_person_id || p.linkedin_url || (p.name + '|' + p.title);
        if (key && seenIds.has(key)) continue;
        if (key) seenIds.add(key);
        collected.push({ ...p, kind });
      }
      if (!res.people.length || res.people.length < res.per_page) break;
      // Doubling for big tech: decide ceiling AFTER first page (we now know employee count).
      const empCount =
        collected[0]?.organization?.estimated_num_employees ||
        res.people[0]?.organization?.estimated_num_employees ||
        0;
      const ceiling =
        empCount >= BIGCO_THRESHOLD ? PER_KIND_MAX * 2 : PER_KIND_MAX;
      if (collected.length >= ceiling) {
        return collected.slice(0, ceiling);
      }
      page += 1;
      await sleep(SLEEP_APOLLO_MS);
    }

    const empCount = collected[0]?.organization?.estimated_num_employees || 0;
    const ceiling = empCount >= BIGCO_THRESHOLD ? PER_KIND_MAX * 2 : PER_KIND_MAX;
    return collected.slice(0, ceiling);
  }

  /* ------------ per-PURSUE iteration ------------ */
  let processedJobs = 0;
  for (let r = 1; r < shortlistRows.length; r++) {
    if (RUN_LIMIT > 0 && processedJobs >= RUN_LIMIT) break;
    const row = shortlistRows[r];
    const pursue = getCell(row, slIdx.pursue);
    if (pursue !== 'PURSUE') continue;

    const job_id = getCell(row, slIdx.job_id);
    const company = getCell(row, slIdx.company);
    const role = getCell(row, slIdx.role);
    if (!job_id || !company) continue;

    const assets = assetsByJobId.get(job_id);
    if (!assets) {
      report.skipped_no_assets++;
      continue;
    }

    const existingForJob = existingContactsByJob.get(job_id);
    if (!REGENERATE && existingForJob && existingForJob.size > 0) {
      report.skipped_already_has_contacts++;
      continue;
    }

    const jobReport = {
      job_id,
      company,
      role,
      organization: null,
      kind_counts: { RECRUITER: 0, HIRING_MANAGER: 0 },
      contacts: [],
      warnings: [],
      error: null,
    };

    try {
      if (!claude) claude = createAnthropicClient();

      /* ---- JD text from Drive ---- */
      let jdText = '';
      if (assets.jd_drive_link) {
        const fileId = parseDriveFileId(assets.jd_drive_link);
        if (fileId) {
          jdText = await exportFileUtf8(fileId);
          jdText = jdText.replace(/\r\n/g, '\n').trim();
          if (jdText.length > 32_000) jdText = jdText.slice(0, 32_000) + '\n…[truncated]';
        }
      }

      /* ---- Apollo: organization (with graceful free-plan fallback) ---- */
      const orgResult = await searchOrganization({ name: company });
      await sleep(SLEEP_APOLLO_MS);

      let orgFilter = null;
      let orgForLog = null;

      if (orgResult && orgResult.blocked) {
        // Free plan can't hit /mixed_companies/search — fall back to people-search
        // with company name + a guessed primary domain.
        const guessed = guessDomainFromCompany(company);
        orgFilter = {
          organizationName: company,
          organizationDomains: guessed ? [guessed] : undefined,
        };
        orgForLog = {
          id: null,
          name: company,
          primary_domain: guessed,
          estimated_num_employees: null,
        };
        jobReport.warnings.push(
          `Apollo /mixed_companies/search blocked (status ${orgResult.status}); using domain fallback ${guessed || '(none)'}.`
        );
      } else if (orgResult && orgResult.id) {
        orgFilter = { organizationId: orgResult.id };
        orgForLog = {
          id: orgResult.id,
          name: orgResult.name,
          primary_domain: orgResult.primary_domain,
          estimated_num_employees: orgResult.estimated_num_employees,
        };
      } else {
        jobReport.warnings.push('Apollo did not resolve an organization for this company');
        report.jobs.push(jobReport);
        report.processed++;
        processedJobs++;
        continue;
      }
      jobReport.organization = orgForLog;

      /* ---- Apollo: recruiters then HMs ---- */
      const recruiters = await pullPeopleForKind({
        kind: 'RECRUITER',
        orgFilter,
        role,
      });
      await sleep(SLEEP_APOLLO_MS);
      const hms = await pullPeopleForKind({
        kind: 'HIRING_MANAGER',
        orgFilter,
        role,
      });
      await sleep(SLEEP_APOLLO_MS);

      if (recruiters.length < PER_KIND_MIN) {
        jobReport.warnings.push(
          `Recruiter count (${recruiters.length}) below soft floor (${PER_KIND_MIN}).`
        );
      }
      if (hms.length < PER_KIND_MIN) {
        jobReport.warnings.push(
          `Hiring-manager count (${hms.length}) below soft floor (${PER_KIND_MIN}).`
        );
      }

      const allCandidates = [...recruiters, ...hms];

      /* ---- Drive folder for this company/job (lazy create) ---- */
      const companyFolderName = slugifyFolderName(company);
      const jobFolderName = slugifyFolderName(`${date}_${job_id}`);
      const writePerContactEmail = async (filename, contents) => {
        const bucketId = bucketIdByName.get('EMAIL');
        if (!bucketId) throw new Error('Missing Drive bucket: EMAIL');
        const { folderId } = await ensureFolderPath(bucketId, [
          companyFolderName,
          jobFolderName,
        ]);
        const f = await createTextFile(folderId, filename, contents);
        return f.webViewLink;
      };

      /* ---- per contact ---- */
      for (const cand of allCandidates) {
        try {
          /* email reveal if missing — Apollo credits */
          let person = cand;
          if (!person.email && person.linkedin_url) {
            try {
              const enriched = await enrichPerson({
                linkedinUrl: person.linkedin_url,
                name: person.name,
                organizationName: orgForLog.name,
              });
              if (enriched && enriched.email) person = { ...person, ...enriched };
            } catch (e) {
              jobReport.warnings.push(
                `Apollo enrich failed for ${person.name || '(unknown)'}: ${e?.message || e}`
              );
            }
            await sleep(SLEEP_APOLLO_MS);
          }

          /* dedup against CONTACTS_MASTER */
          const liKey = (person.linkedin_url || '').toLowerCase();
          const emKey = (person.email || '').toLowerCase();
          let existingMaster = null;
          if (liKey && masterByLinkedIn.has(liKey)) existingMaster = masterByLinkedIn.get(liKey);
          else if (emKey && masterByEmail.has(emKey)) existingMaster = masterByEmail.get(emKey);

          let contact_id;
          let createdMaster = false;
          if (existingMaster && existingMaster.contactId) {
            contact_id = existingMaster.contactId;
            report.contacts_reused++;
          } else {
            contact_id = makeContactId({
              linkedin_url: person.linkedin_url,
              email: person.email,
              organizationName: orgForLog.name,
              name: person.name,
              title: person.title,
            });
            // collision-safety: if the minted id already exists in master, keep it (idempotent)
            createdMaster = !masterByContactId.has(contact_id);
            report.contacts_created++;
          }

          /* skip if (job_id, contact_id) already in CONTACTS and not regenerating */
          const seenForJob = existingContactsByJob.get(job_id);
          if (!REGENERATE && seenForJob && seenForJob.has(contact_id)) {
            jobReport.contacts.push({ contact_id, kind: cand.kind, status: 'skipped_existing' });
            continue;
          }

          /* Claude: per-contact email */
          const emailOut = await generatePersonalizedRecruiterEmail(claude, {
            contact: {
              kind: cand.kind,
              name: person.name,
              title: person.title,
              linkedin_url: person.linkedin_url,
            },
            company,
            role,
            jdText,
            resumeSummary: assets.resume_summary,
            context,
          });
          await sleep(SLEEP_CLAUDE_MS);

          const emailLink = await writePerContactEmail(
            `email-${job_id}-${contact_id}.txt`,
            formatEmailFile({ subject: emailOut.subject, body: emailOut.body })
          );

          /* Claude: per-contact LinkedIn invite */
          const liOut = await generatePersonalizedLinkedInInvite(claude, {
            contact: {
              kind: cand.kind,
              name: person.name,
              title: person.title,
            },
            company,
            role,
            jdText,
            resumeSummary: assets.resume_summary,
            context,
          });
          await sleep(SLEEP_CLAUDE_MS);

          /* CONTACTS row append */
          const contactsRowValues = [
            contact_id,
            job_id,
            company,
            role,
            cand.kind,
            person.name || '',
            person.title || '',
            person.linkedin_url || '',
            person.email || '',
            person.email ? 'apollo' : '',
            person.email ? person.email_confidence || '' : '',
            emailLink,
            liOut.text,
            'NEW',
            person.linkedin_url ? `apollo_id=${person.apollo_person_id || ''}` : '',
          ];
          await appendRow('CONTACTS', contactsRowValues);

          /* CONTACTS_MASTER: append new or update last_contacted_* on existing */
          if (createdMaster) {
            const masterRowValues = [
              contact_id,
              orgForLog.name || company,
              (cand.kind === 'HIRING_MANAGER'
                ? (person.departments || []).join(', ')
                : 'Talent Acquisition'),
              person.name || '',
              person.title || '',
              person.linkedin_url || '',
              person.email || '',
              person.email ? 'apollo' : '',
              person.email ? person.email_confidence || '' : '',
              iso,
              job_id,
              `kind=${cand.kind}`,
            ];
            await appendRow('CONTACTS_MASTER', masterRowValues);
            // Track contact_id locally so further candidates in the same run dedup correctly.
            masterByContactId.set(contact_id, { rowIndex: -1 });
            if (liKey) masterByLinkedIn.set(liKey, { rowIndex: -1, contactId: contact_id });
            if (emKey) masterByEmail.set(emKey, { rowIndex: -1, contactId: contact_id });
          } else if (existingMaster && existingMaster.rowIndex > 0) {
            try {
              await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `CONTACTS_MASTER!J${existingMaster.rowIndex}:K${existingMaster.rowIndex}`,
                valueInputOption: 'RAW',
                requestBody: { values: [[iso, job_id]] },
              });
            } catch (e) {
              jobReport.warnings.push(
                `CONTACTS_MASTER update failed for ${contact_id}: ${e?.message || e}`
              );
            }
          }

          /* track for further dedup in this run */
          if (!existingContactsByJob.has(job_id)) {
            existingContactsByJob.set(job_id, new Set());
          }
          existingContactsByJob.get(job_id).add(contact_id);

          jobReport.kind_counts[cand.kind] = (jobReport.kind_counts[cand.kind] || 0) + 1;
          jobReport.contacts.push({
            contact_id,
            kind: cand.kind,
            name: person.name || '',
            title: person.title || '',
            email_confidence: person.email ? person.email_confidence || '' : 'unavailable',
            email_drive_link: emailLink,
          });
        } catch (innerErr) {
          jobReport.warnings.push(
            `Per-contact failure (${cand.name || '?'}): ${innerErr?.message || String(innerErr)}`
          );
        }
      }

      report.processed++;
      processedJobs++;
      report.jobs.push(jobReport);
    } catch (err) {
      jobReport.error = err?.message || String(err);
      report.errors.push({ job_id, company, role, error: jobReport.error });
      report.jobs.push(jobReport);
      // Count failures toward JOBHUNT_STAGE3_LIMIT so dry-runs stop after N attempts.
      processedJobs++;
    }
  }

  report.ok = report.errors.length === 0 || report.processed > 0;
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
