/**
 * Shared scoring rules for the AI test path (score-from-urls.mjs).
 * Keep in sync with config/profile.yml → ai_evaluation.software_engineering_track.
 */

export const SCORING_RULES_SWE = `
Software-engineering roles — treat ALL of the following as SWE (role_family="SWE"):
SWE, SDE, SE, Software Developer, Software Development Engineer, New Grad SWE, Graduate SWE,
Forward Deployed Engineer (FDE), Founding Engineer, Founding Product Engineer, Product Engineer,
Applied AI Engineer, AI Software Engineer, SDET (when software-development focused).

Career pivot / deep-tech intent (critical — read before scoring):
- The candidate is ACTIVELY PIVOTING into deep-tech software engineering and applying broadly to builder roles. A data-heavy background is context, NOT a rejection reason.
- Weight heavily: shipped projects (TickerSense full-stack LLM, TripTok PySpark/ML/FastAPI/MCP/Bedrock, F1 pipeline), BTech in Computer Engineering, DSA/core-CS coursework, Amazon SDE interview experience, AI-assisted development velocity, production Python/Java/SQL/cloud/API/ETL work.
- Do NOT assign match_score below 6 solely because: past job titles were Data Engineer / Analyst; the candidate lacks one preferred language (Swift, Ruby, Rust, Go, TypeScript, Rails) when Python/cloud/API/LLM skills transfer; or subjective "insufficient SWE tenure."
- A missing preferred language is a gap to note in rationale — NOT a hard blocker and NOT "zero overlap" unless the role is exclusively in that language with no Python/API/cloud/LLM path.

SWE score floors:
- For roles clearly aimed at new grads, 0–3 years, university hire, intern conversion, early-career, L3/E3-style entry, "new grads ok", or no explicit multi-year SWE bar: keep match_score at least 6 unless hard blockers apply (clearance or unsupported work authorization).
- Assign match_score below 6 for SWE-family roles ONLY when the posting clearly requires MORE than 3 years of professional software development/engineering experience AND explicitly targets mid-level, senior, staff, principal, lead-engineering, or similar seniority where entry-level does not apply.
- High salary bands alone do NOT justify scoring below 6 if the JD has no explicit years bar or accepts new grads / equivalent experience.
- Location and work arrangement (onsite, hybrid, in-person, city, state, country) are never reasons to score below 6 (see location rule).
`;

export const SCORING_RULES_CLOUD_DATA_SWE = `
Cloud / data-platform / applied-AI SWE rule:
- If role_family is "SWE" AND the role/team/domain emphasizes cloud infrastructure, data platform, data engineering platform, analytics infrastructure, distributed systems for data, ML/data serving, applied AI, LLM agents, or similar (e.g. "SDE, Data Platform", "Software Engineer, AWS", "Engineer, Databricks", "AI Software Engineer", "Forward Deployed Engineer - Applied AI"), then match_score MUST be at least 6 unless a hard blocker applies (clearance or unsupported work authorization).
- Rationale: candidate has production data + cloud + LLM/agent experience (Azure ADF, Databricks, AWS/Bedrock, BigQuery, Python, SQL, ETL, Strands Agents, MCP) that maps directly to these teams even when past titles were Data Engineer / Analyst.
`;

export const SCORING_RULES_FDE = `
Forward Deployed Engineer (FDE) rule:
- If the role title or JD includes "Forward Deployed Engineer" or similar customer-facing applied-AI / solutions engineering with a coding bar: role_family="SWE" and match_score MUST be at least 6 unless hard blockers apply (clearance or unsupported work authorization).
- Candidate has LLM/agent projects (Claude, Bedrock, Strands, MCP), Python, and client-facing analytics/production work at Apna, Google, and Kohler — strong FDE applied-AI signal even without a traditional SWE title.
`;

export const SCORING_RULES_STARTUP_SWE = `
Startup / founding / product-engineering rule:
- If role_family is "SWE" AND (title includes Founding Engineer, Founding Product Engineer, Product Engineer, or URL is workatastartup.com / YC startup board) AND (posting says "new grads ok", "any experience", has no explicit minimum above 3 years, OR min_years_experience is null or <= 3):
  match_score MUST be at least 6 unless a hard blocker applies (clearance, unsupported work authorization, or role is primarily non-engineering — e.g. community/events/DevRel/content with no meaningful coding bar).
- Rationale: candidate is targeting early-stage deep-tech; LLM projects, full-stack prototypes, and production data systems demonstrate builder velocity and learning trajectory even without a traditional SWE title history.
`;

export const SCORING_RULES_LOCATION = `
Location / work-arrangement rule (critical — geography is never a penalty):
- Location is NEVER a reason to lower match_score or exclude a role from shortlisting — not for a different US city, not for the West Coast vs elsewhere, not for international locations, and not for onsite/in-person/hybrid requirements.
- Onsite, in-person, hybrid, and travel-heavy arrangements are fully acceptable — especially at startups, where onsite is expected and normal. Do NOT treat onsite as friction or a negative.
- The candidate is willing to relocate broadly; geography should not appear as a concern in rationale unless noting a positive fit.

Location bonuses (apply on top of skill-based score; cap final match_score at 10):
- Greater Seattle area (Seattle, Bellevue, Redmond, Kirkland, Tacoma, Everett, and nearby WA metro): add +0.25 to +0.5 to match_score and call out as a strong location fit in rationale.
- US West Coast (Washington, Oregon, California): neutral-to-positive — no penalty; may add up to +0.25 when noting geographic alignment.
- All other US locations and international locations: score on skills and role fit only — no geographic penalty.

Do NOT cite relocation, distance from Seattle, onsite requirements, or country as reasons to score below 6.
`;

/**
 * @param {string[]} priorityCompanies
 * @returns {string}
 */
export function buildScoringHardRules(priorityCompanies) {
  return `Hard scoring rules (apply these mechanically; they override your subjective fit when they fire):
1) SWE rule:
${SCORING_RULES_SWE}
2) Cloud / data-platform / applied-AI SWE rule:
${SCORING_RULES_CLOUD_DATA_SWE}
3) Forward Deployed Engineer rule:
${SCORING_RULES_FDE}
4) Startup / founding / product-engineering rule:
${SCORING_RULES_STARTUP_SWE}
5) Location / work-arrangement rule:
${SCORING_RULES_LOCATION}
6) Analyst big-tech rule:
- If role_family is "ANALYST" AND company is one of the priority companies listed below AND the applicable years (degree-aware min/max above) fall entirely within 0–5 — i.e. when stated, max_years_experience <= 5 AND min_years_experience <= 5 (or null min when no minimum is stated); OR the JD text clearly describes an upper bound of at most five years (e.g. 0–5, up to five years) with no applicable minimum above five — then match_score MUST be at least 6.
7) PM early-career rule:
- If role_family is "PM" AND the role is clearly early-career (associate product manager, apprentice product manager, APM, early career, 0–2 years experience, 0–2 years of product management experience), then match_score MUST be at least 6. If the role title is an APM/apprentice PM, treat it as early-career.
8) Priority-company alignment soft-floor:
- If company is on the priority list below AND the role title is a software-engineering-family role (SWE, SDE, Software Developer, AI Software Engineer, SDET, etc.) OR the candidate shows content alignment with the JD (overlapping skills, comparable scope, role family consistent with target roles in profile/cv), then match_score MUST be at least 6 — regardless of role_family — unless a hard blocker below applies.
- The ONLY reasons to score below 6 at a priority company: active security clearance required (TS, SCI, Public Trust, etc.) that the candidate does not hold; OR applicable experience clearly requires more than 8 years with no Master's-track reduction bringing max applicable years to 5 or below; OR the role is exclusively non-engineering (pure DevRel/content/community with no coding bar).
- "Zero overlap" does NOT apply when the candidate has Python, SQL, cloud, API, ETL, LLM/agent, or distributed-systems project evidence — these bridge to most big-tech SWE postings even when the JD prefers Swift, Java, C++, Go, or TypeScript. Lack of production experience in one preferred language is a gap, not zero overlap.
- When this rule fires or nearly fires, name the alignment signals in rationale.

Priority companies (rules #6 and #8):
${(priorityCompanies || []).join(', ') || '(none provided)'}`;
}

/**
 * @param {string[]} priorityCompanies
 * @returns {string}
 */
export function buildScoringSystemPrompt(priorityCompanies) {
  return `You are a recruiting assistant. Given a candidate profile (YAML), CV (Markdown), and scraped job page text from a URL, output a STRICT JSON object only, no markdown, with keys:

Candidate intent: The candidate is actively applying to deep-tech software engineering and builder roles (SWE, FDE, founding/product engineer, applied AI). Score on transferable technical evidence — projects shipped, languages practiced, cloud/AI systems built, learning trajectory — not only historical job titles. A data-heavy background is intentional pivot context, not a reason to exclude. Location and onsite/hybrid requirements are never penalties; greater Seattle area is a scoring bonus; US West Coast is a plus.
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
  Map Forward Deployed Engineer, Founding Engineer, Founding Product Engineer, Product Engineer (software), Software Developer, AI Software Engineer, Applied AI Engineer → "SWE".
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
