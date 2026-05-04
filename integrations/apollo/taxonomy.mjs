/**
 * Pure data + small helpers used by Stage 3 to translate a SHORTLIST role
 * into Apollo /mixed_people/search filter parameters. Kept separate from
 * client.mjs so it can be unit-tested without hitting the network.
 */

/** Title fragments Apollo treats as recruiter / talent acquisition. */
export const RECRUITER_TITLES = [
  'recruiter',
  'senior recruiter',
  'lead recruiter',
  'talent acquisition',
  'talent partner',
  'talent sourcer',
  'sourcer',
  'university recruiter',
  'campus recruiter',
  'tech recruiter',
  'technical recruiter',
];

/** Apollo seniority slugs we treat as "hiring manager" tier. */
export const HM_SENIORITIES = ['manager', 'director', 'head', 'vp'];

/**
 * Role-to-department + role-to-title-keyword maps.
 *
 * Each entry has:
 *   match: array of substrings (case-insensitive) that, if present in the
 *          SHORTLIST.role string, select this entry.
 *   departments: Apollo `person_departments` slugs to bias the HM search.
 *   hmTitleKeywords: extra title fragments to OR into person_titles when
 *          searching for HMs (e.g. "data engineering manager" needs both
 *          "manager" seniority AND "data" / "engineering" in the title).
 */
const ROLE_RULES = [
  {
    match: ['data engineer', 'data engineering', 'data platform'],
    departments: ['engineering', 'data', 'information_technology'],
    hmTitleKeywords: ['data engineering', 'data platform', 'data infrastructure', 'engineering'],
  },
  {
    match: ['analytics engineer', 'analytics engineering'],
    departments: ['engineering', 'analytics', 'data'],
    hmTitleKeywords: ['analytics engineering', 'analytics', 'data engineering'],
  },
  {
    match: ['bi engineer', 'business intelligence', 'bi developer', 'bi analyst'],
    departments: ['analytics', 'business_intelligence', 'data'],
    hmTitleKeywords: ['business intelligence', 'analytics', 'reporting'],
  },
  {
    match: ['data analyst', 'analytics analyst', 'reporting analyst', 'insights analyst'],
    departments: ['analytics', 'data', 'business_intelligence'],
    hmTitleKeywords: ['analytics', 'data', 'business intelligence'],
  },
  {
    match: ['product analyst', 'product data'],
    departments: ['product_management', 'analytics', 'data'],
    hmTitleKeywords: ['product analytics', 'product', 'analytics'],
  },
  {
    match: ['data scientist', 'decision scientist', 'quantitative analyst'],
    departments: ['data_science_machine_learning', 'analytics', 'engineering'],
    hmTitleKeywords: ['data science', 'analytics', 'machine learning'],
  },
  {
    match: ['ml engineer', 'machine learning', 'ai engineer', 'applied ai', 'mlops'],
    departments: ['engineering', 'data_science_machine_learning'],
    hmTitleKeywords: ['machine learning', 'ai', 'data science', 'engineering'],
  },
  {
    match: ['product manager', 'apm', 'associate product manager', 'technical product manager'],
    departments: ['product_management'],
    hmTitleKeywords: ['product', 'product management'],
  },
  {
    match: ['software engineer', 'software developer', 'sde', 'backend engineer', 'full stack'],
    departments: ['engineering', 'information_technology'],
    hmTitleKeywords: ['engineering', 'software', 'platform'],
  },
  {
    match: ['business analyst', 'operations analyst', 'finance analyst', 'marketing analyst'],
    departments: ['operations', 'finance', 'marketing'],
    hmTitleKeywords: ['analytics', 'operations', 'finance', 'marketing'],
  },
];

/** Normalize a free-form role string for matching. */
function normalizeRole(role) {
  return String(role || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Pick the first ROLE_RULES entry whose `match` keywords appear in the role
 * string. Falls back to a generic analytics/engineering bias.
 */
function pickRule(role) {
  const r = normalizeRole(role);
  if (!r) return null;
  for (const rule of ROLE_RULES) {
    if (rule.match.some((m) => r.includes(m))) return rule;
  }
  return null;
}

/**
 * Given a SHORTLIST role, return Apollo `person_departments` slugs to use
 * as a soft hint when searching for hiring managers.
 *
 * @param {string} role
 * @returns {string[]}
 */
export function roleToDepartments(role) {
  const rule = pickRule(role);
  if (rule) return [...rule.departments];
  // Generic fallback — covers most analytics-adjacent postings.
  return ['analytics', 'data', 'engineering'];
}

/**
 * Title fragments to OR into person_titles when searching for HMs. Combined
 * with HM_SENIORITIES this isolates "X Manager / Director / Head of X".
 *
 * @param {string} role
 * @returns {string[]}
 */
export function roleToHmTitleKeywords(role) {
  const rule = pickRule(role);
  if (rule) return [...rule.hmTitleKeywords];
  return ['analytics', 'data', 'engineering'];
}
