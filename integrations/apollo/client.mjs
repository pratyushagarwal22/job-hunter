/**
 * Apollo.io REST client for Stage 3 contact discovery.
 *
 * Uses Node 18+ globalThis.fetch (no extra dependency). Auth header is X-Api-Key
 * (Apollo also accepts api_key in the body; we use the header).
 *
 * Endpoints used:
 *   POST /v1/mixed_companies/search   — find an organization by name/domain
 *   POST /v1/mixed_people/search      — list people in an org filtered by titles/seniorities
 *   POST /v1/people/match             — enrich a single person (used to reveal email)
 *
 * Each function retries once on 429 / 5xx with a 2s backoff and returns
 * a normalized shape so the rest of the pipeline never sees raw Apollo JSON.
 */

import { requireEnv } from '../google/env.mjs';

const APOLLO_BASE = 'https://api.apollo.io/api/v1';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apolloFetch(path, body) {
  const apiKey = requireEnv('APOLLO_API_KEY');
  const url = `${APOLLO_BASE}${path}`;
  const init = {
    method: 'POST',
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body || {}),
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (res.ok) return json ?? {};

      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      lastErr = new Error(
        `Apollo ${res.status} on ${path}: ${(json && json.error) || text.slice(0, 300)}`
      );
      lastErr.status = res.status;
      lastErr.retryable = retryable;
      if (!retryable) throw lastErr;
    } catch (err) {
      lastErr = err;
      if (err && err.retryable === false) throw err;
    }
    if (attempt === 0) await sleep(2000);
  }
  throw lastErr || new Error(`Apollo request failed: ${path}`);
}

function mapEmailStatusToConfidence(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'verified') return 'high';
  if (s === 'likely' || s === 'guessed' || s === 'likely_to_engage') return 'medium';
  return 'low';
}

function normalizeOrg(raw) {
  if (!raw) return null;
  return {
    id: raw.id || raw.organization_id || null,
    name: raw.name || raw.organization_name || '',
    primary_domain: raw.primary_domain || raw.website_url || raw.domain || '',
    estimated_num_employees:
      typeof raw.estimated_num_employees === 'number' ? raw.estimated_num_employees : null,
  };
}

function normalizePerson(raw) {
  if (!raw) return null;
  const departments = Array.isArray(raw.departments)
    ? raw.departments.filter(Boolean)
    : Array.isArray(raw.subdepartments)
    ? raw.subdepartments.filter(Boolean)
    : [];

  const email_status = String(raw.email_status || '').toLowerCase() || 'unavailable';
  return {
    apollo_person_id: raw.id || null,
    name:
      raw.name ||
      [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim() ||
      '',
    title: raw.title || raw.headline || '',
    seniority: String(raw.seniority || '').toLowerCase() || '',
    departments,
    linkedin_url: raw.linkedin_url || '',
    email: typeof raw.email === 'string' ? raw.email.trim() : '',
    email_status,
    email_confidence: mapEmailStatusToConfidence(email_status),
    organization: normalizeOrg(raw.organization || raw.account || null),
  };
}

/**
 * Search for an organization by display name and (optionally) primary domain.
 * Returns the highest-confidence match, or null if Apollo did not return any.
 *
 * Free Apollo plans block `/mixed_companies/search`. We surface that as a
 * structured `{ blocked: true }` return (rather than throwing) so callers can
 * fall back to people-search with org-name / domain filters.
 *
 * @param {{ name?: string, domain?: string }} args
 * @returns {Promise<null | { blocked: true, status: number, error: string } | ReturnType<typeof normalizeOrg>>}
 */
export async function searchOrganization({ name, domain }) {
  const body = {
    page: 1,
    per_page: 5,
  };
  if (name) body.q_organization_name = name;
  if (domain) body.q_organization_domains_list = [domain];

  let json;
  try {
    json = await apolloFetch('/mixed_companies/search', body);
  } catch (err) {
    if (err && (err.status === 403 || err.status === 402)) {
      return { blocked: true, status: err.status, error: err.message };
    }
    throw err;
  }
  const list =
    (json && (json.organizations || json.accounts || json.companies)) || [];
  if (!Array.isArray(list) || list.length === 0) return null;

  const target = String(name || '').trim().toLowerCase();
  const exact = list.find((o) => String(o.name || '').trim().toLowerCase() === target);
  return normalizeOrg(exact || list[0]);
}

/**
 * Search people inside an organization, filtered by titles and/or seniorities.
 * Caller paginates; we return one page at a time so Stage 3 can stop early
 * when its per-kind ceiling is reached.
 *
 * Identify the organization with EITHER `organizationId` (preferred — comes
 * from `searchOrganization`) OR `organizationDomains` / `organizationName`
 * (fallback for plans where `/mixed_companies/search` is blocked).
 *
 * @param {{
 *   organizationId?: string,
 *   organizationDomains?: string[],
 *   organizationName?: string,
 *   titles?: string[],
 *   seniorities?: string[],
 *   departments?: string[],
 *   perPage?: number,
 *   page?: number,
 * }} args
 * @returns {Promise<{ people: ReturnType<typeof normalizePerson>[], total: number, page: number, per_page: number }>}
 */
export async function searchPeople({
  organizationId,
  organizationDomains,
  organizationName,
  titles,
  seniorities,
  departments,
  perPage = 25,
  page = 1,
}) {
  const hasOrgFilter =
    !!organizationId ||
    (Array.isArray(organizationDomains) && organizationDomains.length > 0) ||
    !!organizationName;
  if (!hasOrgFilter) {
    return { people: [], total: 0, page, per_page: perPage };
  }
  const body = {
    page,
    per_page: perPage,
  };
  if (organizationId) {
    body.q_organization_ids = [organizationId];
  } else {
    if (Array.isArray(organizationDomains) && organizationDomains.length) {
      body.q_organization_domains_list = organizationDomains;
    }
    if (organizationName) {
      body.q_organization_name = organizationName;
    }
  }
  if (Array.isArray(titles) && titles.length) body.person_titles = titles;
  if (Array.isArray(seniorities) && seniorities.length) body.person_seniorities = seniorities;
  if (Array.isArray(departments) && departments.length) body.person_departments = departments;

  const json = await apolloFetch('/mixed_people/search', body);
  const list = (json && (json.people || json.contacts)) || [];
  const total =
    (json && json.pagination && (json.pagination.total_entries || json.pagination.total)) || list.length;

  return {
    people: list.map(normalizePerson).filter(Boolean),
    total,
    page,
    per_page: perPage,
  };
}

/**
 * Naive domain guess from a company display name. Used only as a fallback
 * when `/mixed_companies/search` is blocked (free plan). Returns a single
 * candidate; the caller can append more if it wants.
 *
 * "Match Group" → "matchgroup.com"
 * "Palo Alto Networks" → "paloaltonetworks.com"
 *
 * @param {string} companyName
 * @returns {string | null}
 */
export function guessDomainFromCompany(companyName) {
  const n = String(companyName || '').toLowerCase().trim();
  if (!n) return null;
  const slug = n.replace(/[^a-z0-9]/g, '');
  if (!slug) return null;
  return `${slug}.com`;
}

/**
 * Enrich a single person (used to reveal email when search did not include one).
 * Apollo charges credits for verified/guessed email reveals on this endpoint.
 *
 * @param {{ linkedinUrl?: string, name?: string, organizationName?: string }} args
 */
export async function enrichPerson({ linkedinUrl, name, organizationName }) {
  const body = { reveal_personal_emails: false };
  if (linkedinUrl) body.linkedin_url = linkedinUrl;
  if (name) body.name = name;
  if (organizationName) body.organization_name = organizationName;

  if (!linkedinUrl && !(name && organizationName)) return null;

  const json = await apolloFetch('/people/match', body);
  const raw = json && (json.person || json.matched_person || json.contact);
  return raw ? normalizePerson(raw) : null;
}
