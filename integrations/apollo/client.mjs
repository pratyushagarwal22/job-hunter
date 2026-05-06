/**
 * Apollo.io REST client for Stage 3 contact discovery / enrichment.
 *
 * Uses Node 18+ globalThis.fetch (no extra dependency). Auth header is X-Api-Key
 * (Apollo also accepts api_key in the body; we use the header).
 *
 * Endpoints used:
 *   POST /v1/mixed_people/api_search  — discovery by titles/seniorities/domain (0 credits)
 *   POST /v1/people/bulk_match        — reveal email for up to 10 people in one call
 *   POST /v1/people/match             — single-person enrichment fallback (1 credit)
 *   POST /v1/mixed_companies/search   — legacy org lookup (kept for callers that still use it)
 *   POST /v1/mixed_people/search      — legacy people search (kept for callers that still use it)
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
      'accept': 'application/json',
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

/**
 * Pure URL builder for Apollo POST-with-query-params endpoints. No network,
 * no API key, no env. The single source of truth used by both the live client
 * (`apolloFetchPostQuery`) and the Stage 3 cURL/replay dump path. Keeping
 * these in lockstep guarantees the cURL we hand to a human is byte-identical
 * to the URL the script actually hits.
 *
 * Array values are appended as repeated keys (e.g. `person_titles[]=recruiter`).
 *
 * @param {string} path  Apollo path beginning with `/` (e.g. `/mixed_people/api_search`)
 * @param {Record<string, string|number|Array<string|number>>} query
 * @returns {string} fully-qualified Apollo URL with encoded query params
 */
export function buildApolloSearchUrl(path = '/mixed_people/api_search', query) {
  const url = new URL(`${APOLLO_BASE}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item == null || item === '') continue;
        url.searchParams.append(k, String(item));
      }
    } else if (v != null && v !== '') {
      url.searchParams.append(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Pure query-object builder for `/v1/mixed_people/api_search`. Returns the
 * exact `query` shape that `apolloFetchPostQuery` will hand to the URL
 * builder, including the bracketed array keys that Apollo expects. Pure
 * function — no network, no env access.
 *
 * Caps `per_page` at 100 and `page` at 500 (Apollo's documented ceilings).
 *
 * @param {{
 *   domain?: string,
 *   titles?: string[],
 *   seniorities?: string[],
 *   locations?: string[],
 *   emailStatuses?: string[],
 *   page?: number,
 *   perPage?: number,
 * }} args
 * @returns {Record<string, string|number|Array<string|number>>}
 */
export function buildApiSearchQuery({
  domain,
  domains,
  titles,
  seniorities,
  locations,
  emailStatuses,
  page = 1,
  perPage = 100,
} = {}) {
  const safePerPage = Math.min(Math.max(parseInt(perPage, 10) || 100, 1), 100);
  const safePage = Math.min(Math.max(parseInt(page, 10) || 1, 1), 500);

  const query = {
    page: safePage,
    per_page: safePerPage,
  };
  if (Array.isArray(titles) && titles.length) query['person_titles[]'] = titles;
  if (Array.isArray(seniorities) && seniorities.length) query['person_seniorities[]'] = seniorities;
  if (Array.isArray(locations) && locations.length) query['person_locations[]'] = locations;
  if (Array.isArray(emailStatuses) && emailStatuses.length) query['contact_email_status[]'] = emailStatuses;

  const domainList =
    Array.isArray(domains) && domains.length > 0
      ? domains.map((d) => String(d || '').trim()).filter(Boolean)
      : domain
        ? [String(domain).trim()].filter(Boolean)
        : [];
  if (domainList.length) query['q_organization_domains_list[]'] = domainList;

  return query;
}

/**
 * Same retry behavior as `apolloFetch` but the request payload is appended as
 * URL search params (Apollo's `/mixed_people/api_search` documents query-string
 * style filters; matching that here keeps parity with Postman calls people use
 * to validate their key).
 *
 * URL encoding is delegated to `buildApolloSearchUrl` so dump-emitted cURLs
 * and live requests share one code path.
 */
async function apolloFetchPostQuery(path, query) {
  const apiKey = requireEnv('APOLLO_API_KEY');
  const urlStr = buildApolloSearchUrl(path, query);

  const init = {
    method: 'POST',
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json',
      'accept': 'application/json',
      'X-Api-Key': apiKey,
    },
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(urlStr, init);
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

function deriveFirstName(raw) {
  if (raw?.first_name && typeof raw.first_name === 'string') return raw.first_name.trim();
  if (raw?.name && typeof raw.name === 'string') {
    const parts = raw.name.trim().split(/\s+/);
    if (parts.length) return parts[0];
  }
  return '';
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
    first_name: deriveFirstName(raw),
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
 * `mixed_people/api_search` never returns emails (those come from bulk_match)
 * so we explicitly null them out and let bulk_match overwrite later. Otherwise
 * the shape mirrors `normalizePerson`.
 */
function normalizeApiSearchPerson(raw) {
  const base = normalizePerson(raw);
  if (!base) return null;
  return {
    ...base,
    email: null,
    email_confidence: null,
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
 * `mixed_people/api_search` returns `apollo_person_id` but no LinkedIn URL or
 * email. `/people/match` accepts `id` as a match key and returns both fields,
 * so we surface `apolloPersonId` here as a first-class arg. When provided, it
 * is the strongest match key and we don't require LinkedIn or name+org.
 *
 * @param {{
 *   apolloPersonId?: string,
 *   linkedinUrl?: string,
 *   name?: string,
 *   organizationName?: string,
 *   revealPersonalEmails?: boolean,
 * }} args
 */
export async function enrichPerson({
  apolloPersonId,
  linkedinUrl,
  name,
  organizationName,
  revealPersonalEmails = false,
}) {
  const body = { reveal_personal_emails: !!revealPersonalEmails };
  if (apolloPersonId) body.id = apolloPersonId;
  if (linkedinUrl) body.linkedin_url = linkedinUrl;
  if (name) body.name = name;
  if (organizationName) body.organization_name = organizationName;

  if (!apolloPersonId && !linkedinUrl && !(name && organizationName)) return null;

  const json = await apolloFetch('/people/match', body);
  const raw = json && (json.person || json.matched_person || json.contact);
  return raw ? normalizePerson(raw) : null;
}

/**
 * `/v1/mixed_people/api_search` — discovery endpoint, requires the master API
 * key, and (per Apollo's pricing) does not consume credits. Per Apollo, the
 * effective ceiling is `per_page` ≤ 100 and `page` ≤ 500. Pagination is the
 * caller's job: stop when you've reached your per-kind cap or `pagination.total_pages`.
 *
 * `domain` or `domains` is fed to `q_organization_domains_list[]`. Use `domains`
 * for multiple org domains (e.g. youtube.com + google.com). If both are passed,
 * `domains` wins. Pass empty/undefined to search Apollo-wide (rarely useful).
 *
 * @param {{
 *   domain?: string,
 *   domains?: string[],
 *   titles?: string[],
 *   seniorities?: string[],
 *   locations?: string[],
 *   emailStatuses?: string[],
 *   page?: number,
 *   perPage?: number,
 * }} args
 * @returns {Promise<{
 *   people: ReturnType<typeof normalizeApiSearchPerson>[],
 *   total: number,
 *   total_pages: number,
 *   page: number,
 *   per_page: number,
 *   raw: any,
 * }>}
 */
export async function searchPeopleApiSearch({
  domain,
  domains,
  titles,
  seniorities,
  locations,
  emailStatuses,
  page = 1,
  perPage = 100,
}) {
  const query = buildApiSearchQuery({
    domain,
    domains,
    titles,
    seniorities,
    locations,
    emailStatuses,
    page,
    perPage,
  });
  const safePerPage = query.per_page;
  const safePage = query.page;

  const json = await apolloFetchPostQuery('/mixed_people/api_search', query);
  const list = (json && (json.people || json.contacts)) || [];
  const pag = (json && json.pagination) || {};
  const total = pag.total_entries || pag.total || list.length;
  const totalPages =
    pag.total_pages ||
    (safePerPage > 0 ? Math.max(1, Math.ceil(total / safePerPage)) : 1);

  return {
    people: list.map(normalizeApiSearchPerson).filter(Boolean),
    total,
    total_pages: totalPages,
    page: pag.page || safePage,
    per_page: pag.per_page || safePerPage,
    raw: json,
  };
}

/**
 * `/v1/people/bulk_match` — reveals up to 10 emails in one call. Per Apollo,
 * personal emails are gated behind `reveal_personal_emails` (extra credits +
 * GDPR compliance). We default it OFF; flip via env in Stage 3.
 *
 * Each `details[i]` should ideally include `linkedin_url` (most reliable for
 * us — comes straight from `mixed_people/api_search`). Apollo will also accept
 * `id`, `name`+`organization_name`, or `email` as match keys.
 *
 * @param {{ details: Array<{ linkedin_url?: string, id?: string, name?: string, first_name?: string, last_name?: string, organization_name?: string, domain?: string, email?: string }>, revealPersonalEmails?: boolean }} args
 * @returns {Promise<{
 *   matches: ReturnType<typeof normalizePerson>[],
 *   status_code: number | null,
 *   missing: number,
 *   raw: any,
 * }>}
 */
export async function bulkMatchPeople({ details, revealPersonalEmails = false }) {
  if (!Array.isArray(details) || details.length === 0) {
    return { matches: [], status_code: null, missing: 0, raw: null };
  }

  const trimmed = details.slice(0, 10).map((d) => {
    const entry = {};
    if (d.linkedin_url) entry.linkedin_url = d.linkedin_url;
    if (d.id) entry.id = d.id;
    if (d.email) entry.email = d.email;
    if (d.name) entry.name = d.name;
    if (d.first_name) entry.first_name = d.first_name;
    if (d.last_name) entry.last_name = d.last_name;
    if (d.organization_name) entry.organization_name = d.organization_name;
    if (d.domain) entry.domain = d.domain;
    return entry;
  });

  const body = {
    reveal_personal_emails: !!revealPersonalEmails,
    details: trimmed,
  };

  const json = await apolloFetch('/people/bulk_match', body);
  const matchesRaw =
    (json && (json.matches || json.matched_people || json.people)) || [];
  const matches = matchesRaw.map(normalizePerson).filter(Boolean);

  return {
    matches,
    status_code: json && json.status_code != null ? json.status_code : null,
    missing: Math.max(0, trimmed.length - matches.length),
    raw: json,
  };
}
