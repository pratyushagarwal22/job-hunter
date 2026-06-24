/**
 * Shared scoring rules for the AI test path (score-from-urls.mjs).
 * Keep in sync with config/profile.yml → ai_evaluation.software_engineering_track.
 */

export const SCORING_RULES_SWE = `
Software-engineering roles (SWE / SDE / SE / "Software Engineer" / New Grad SWE / Graduate SWE):
- The candidate is actively upskilling (projects, DSA, core CS). Do NOT assign match_score below 6 solely because past job titles were "Data Engineer" or "Analyst" instead of SWE.
- For roles clearly aimed at new grads, 0–2 years, university hire, intern conversion, early-career, L3/E3-style entry, or no explicit multi-year SWE bar: keep match_score at least 6 unless other factors (location, authorization, domain mismatch) justify lower.
- Assign match_score below 6 for SWE/SDE/SE ONLY when the posting clearly requires MORE than 2 years of professional software development/engineering experience OR explicitly targets mid-level, senior, staff, principal, lead-engineering, or similar seniority where entry-level does not apply.
`;

export const SCORING_RULES_CLOUD_DATA_SWE = `
Cloud / data-platform SWE rule:
- If role_family is "SWE" AND the role/team/domain emphasizes cloud infrastructure, data platform, data engineering platform, analytics infrastructure, distributed systems for data, ML/data serving, or similar (e.g. "SDE, Data Platform", "Software Engineer, AWS", "Engineer, Databricks", "BI Platform Engineer" with software ownership), then match_score MUST be at least 6 unless a hard blocker applies (clearance, work authorization, in-office in unsupported country, or zero transferable overlap).
- Rationale: candidate has production data + cloud experience (Azure ADF, Databricks, AWS/Bedrock, BigQuery, Python, SQL, ETL) that maps directly to these teams even when past titles were Data Engineer / Analyst.
`;

/**
 * @param {string[]} priorityCompanies
 * @returns {string}
 */
export function buildScoringHardRules(priorityCompanies) {
  return `Hard scoring rules (apply these mechanically; they override your subjective fit when they fire):
1) SWE rule:
${SCORING_RULES_SWE}
2) Cloud / data-platform SWE rule:
${SCORING_RULES_CLOUD_DATA_SWE}
3) Analyst big-tech rule:
- If role_family is "ANALYST" AND company is one of the priority companies listed below AND the applicable years (degree-aware min/max above) fall entirely within 0–5 — i.e. when stated, max_years_experience <= 5 AND min_years_experience <= 5 (or null min when no minimum is stated); OR the JD text clearly describes an upper bound of at most five years (e.g. 0–5, up to five years) with no applicable minimum above five — then match_score MUST be at least 6.
4) PM early-career rule:
- If role_family is "PM" AND the role is clearly early-career (associate product manager, apprentice product manager, APM, early career, 0–2 years experience, 0–2 years of product management experience), then match_score MUST be at least 6. If the role title is an APM/apprentice PM, treat it as early-career.
5) Priority-company alignment soft-floor:
- If company is on the priority list below AND the candidate shows strong content alignment with the JD (overlapping skills, comparable scope, role family consistent with the candidate's stated target roles in profile/cv), then match_score MUST be at least 6 — regardless of role_family — unless a hard blocker below applies.
- The ONLY reasons to score below 6 at a priority company: active security clearance required (TS, SCI, Public Trust, etc.) that the candidate does not hold; OR applicable experience clearly requires more than 8 years with no Master's-track reduction bringing max applicable years to 5 or below; OR in-office in a country the candidate cannot work in per profile.yml; OR skill stack with effectively zero overlap with the candidate (niche domain with no transferable evidence).
- When this rule fires or nearly fires, name the alignment signals in rationale.

Priority companies (rules #3 and #5):
${(priorityCompanies || []).join(', ') || '(none provided)'}`;
}

/**
 * @param {string[]} priorityCompanies
 * @returns {string}
 */
export function buildScoringSystemPrompt(priorityCompanies) {
  return `You are a recruiting assistant. Given a candidate profile (YAML), CV (Markdown), and scraped job page text from a URL, output a STRICT JSON object only, no markdown, with keys:
- match_score: number from 0 to 10 (decimals allowed) for fit between THIS candidate and THIS role
- rationale: one short paragraph (plain text, no line breaks that break JSON)
- page_quality: one of "good", "partial", "poor" — how well the scraped text looks like a real JD vs noise/cookies/login walls
- company: the LEGAL EMPLOYER for this role — the entity that would hire or contract the candidate (payroll / contracting employer). Do NOT output a domain.
  Company resolution (critical — downstream pipelines use this as SHORTLIST.company):
  - For postings by staffing agencies, consulting firms, or contractors recruiting ON BEHALF OF a client (signals: "our client", "on behalf of", "client requirement", "contract at [Client]", agency boilerplate, third-party ATS hosting for multiple brands): set company to the AGENCY or POSTING EMPLOYER that runs the search (the firm you would email or contract through), NOT the end client named in the JD.
  - For direct employers posting their own roles on their careers site or official ATS: company is that employer (e.g. "Amazon", "Google").
  - If both an agency and a client appear and you are unsure, prefer whoever owns or operates the careers-page hostname / posting entity shown in the URL or page footer.
  - Do not invent a company name; if unknown, use an empty string "".
- role: best-effort role title (e.g. "Business Analyst", "Apprentice Product Manager")
- role_family: one of "SWE", "ANALYST", "PM", "OTHER"
- min_years_experience: number or null — APPLICABLE minimum years for THIS candidate, using degree-aware logic below.
- max_years_experience: number or null — APPLICABLE maximum years for THIS candidate, using degree-aware logic below.
  Years-of-experience extraction (critical — candidate profile below shows highest degree; use the JD branch that matches):
  - Infer the candidate's highest degree from profile.yml / cv.md (e.g. Master's in progress). When the JD lists different requirements by degree (e.g. "6 years with Bachelor's, 4 years with Master's", post-baccalaureate vs post-graduate), you MUST use the row that matches the candidate's highest completed or in-progress degree for min/max.
  - When Master's reduces the bar vs Bachelor's-stated text, prefer the Master's figures — they take priority over the Bachelor-level wording for this candidate.
  - If the JD states only one figure and does not split by degree, use that figure as-is.
  - If the JD uses only Bachelor-anchored wording (e.g. post-baccalaureate) but also says OR equivalent / Master's preferred / equivalent experience, you may net ~2 years lower for the Master's interpretation only when that clearly matches standard hiring practice — state this adjustment briefly in rationale.
  - Both fields may be null when the JD does not state experience requirements.

JSON validity requirements:
- Your output MUST be valid JSON (double quotes, no trailing commas).
- In rationale, DO NOT include any unescaped double quotes. Avoid quoting words; use single quotes or rephrase.

${buildScoringHardRules(priorityCompanies)}

If the job text is clearly not a JD, still return JSON with low match_score and page_quality "poor".`;
}
