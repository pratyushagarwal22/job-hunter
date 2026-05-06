#!/usr/bin/env node
/**
 * score-from-urls.mjs — **AI test path only** (does not change jobhunt:seed-8 / stage2).
 *
 * 1. Reads job URLs from jobhunt/ai-test/urls.txt (one per line; # comments ok).
 * 2. Fetches each page with Playwright and extracts visible text.
 * 3. Calls Claude (ANTHROPIC_MODEL_SCORE) for match_score 0–10 + short rationale JSON.
 * 4. Writes jobhunt/ai-test/output/last-report.json and prints summary to stdout.
 *
 * Prereq: npx playwright install chromium
 *
 *   npm run jobhunt:ai-score-urls
 *   node jobhunt/ai-test/score-from-urls.mjs path/to/other-urls.txt
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import yaml from 'js-yaml';

import { loadDotenv } from '../../integrations/google/env.mjs';
import { createAnthropicClient, resolveAnthropicModel } from '../../integrations/anthropic/config.mjs';
import { extractJsonObject } from '../lib/claude-json.mjs';
import { fetchJobPagePlainText } from './fetch-job-page-text.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL_FILE = join(__dirname, 'urls.txt');
const OUT_DIR = join(__dirname, 'output');
const OUT_FILE = join(OUT_DIR, 'last-report.json');

function readUrlsFile(path) {
  const raw = readFileSync(path, 'utf-8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function loadProfileSnippet() {
  const p = join(process.cwd(), 'config', 'profile.yml');
  if (!existsSync(p)) {
    return '(config/profile.yml not found — add candidate context for better scores)';
  }
  const body = readFileSync(p, 'utf-8');
  return body.length > 14_000 ? body.slice(0, 14_000) + '\n…[truncated]' : body;
}

function loadCvSnippet() {
  const p = join(process.cwd(), 'cv.md');
  if (!existsSync(p)) return '(cv.md not found)';
  const body = readFileSync(p, 'utf-8');
  return body.length > 12_000 ? body.slice(0, 12_000) + '\n…[truncated]' : body;
}

const SCORING_RULES_SWE = `
Software-engineering roles (SWE / SDE / SE / “Software Engineer” / New Grad SWE / Graduate SWE):
- The candidate is actively upskilling (projects, DSA, core CS). Do NOT assign match_score below 6 solely because past job titles were “Data Engineer” or “Analyst” instead of SWE.
- For roles clearly aimed at new grads, 0–2 years, university hire, intern conversion, early-career, L3/E3-style entry, or no explicit multi-year SWE bar: keep match_score at least 6 unless other factors (location, authorization, domain mismatch) justify lower.
- Assign match_score below 6 for SWE/SDE/SE ONLY when the posting clearly requires MORE than 2 years of professional software development/engineering experience OR explicitly targets mid-level, senior, staff, principal, lead-engineering, or similar seniority where entry-level does not apply.
`;

function loadPriorityCompanyNames() {
  const path = join(process.cwd(), 'config', 'priority-companies.yml');
  if (!existsSync(path)) return [];
  try {
    const doc = yaml.load(readFileSync(path, 'utf-8'));
    const list = Array.isArray(doc?.priority_companies) ? doc.priority_companies : [];
    return list
      .map((entry) => (entry && typeof entry === 'object' ? String(entry.name || '').trim() : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeRoleFamily(x) {
  const v = String(x || '')
    .trim()
    .toUpperCase();
  return v === 'SWE' || v === 'ANALYST' || v === 'PM' || v === 'OTHER' ? v : 'OTHER';
}

function normalizeYears(x) {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function scoreOneJob(client, model, { url, pageTitle, jdText, profileYaml, cvMd, priorityCompanies }) {
  const system = `You are a recruiting assistant. Given a candidate profile (YAML), CV (Markdown), and scraped job page text from a URL, output a STRICT JSON object only, no markdown, with keys:
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

Hard scoring rules (apply these mechanically; they override your subjective fit when they fire):
1) SWE rule:
${SCORING_RULES_SWE}
2) Analyst big-tech rule:
- If role_family is "ANALYST" AND company is one of the priority companies listed below AND the applicable years (degree-aware min/max above) fall entirely within 0–5 — i.e. when stated, max_years_experience <= 5 AND min_years_experience <= 5 (or null min when no minimum is stated); OR the JD text clearly describes an upper bound of at most five years (e.g. 0–5, up to five years) with no applicable minimum above five — then match_score MUST be at least 6.
3) PM early-career rule:
- If role_family is "PM" AND the role is clearly early-career (associate product manager, apprentice product manager, APM, early career, 0–2 years experience, 0–2 years of product management experience), then match_score MUST be at least 6. If the role title is an APM/apprentice PM, treat it as early-career.
4) Priority-company alignment soft-floor:
- If company is on the priority list below AND the candidate shows strong content alignment with the JD (overlapping skills, comparable scope, role family consistent with the candidate's stated target roles in profile/cv), then match_score MUST be at least 6 — regardless of role_family — unless a hard blocker below applies.
- The ONLY reasons to score below 6 at a priority company: active security clearance required (TS, SCI, Public Trust, etc.) that the candidate does not hold; OR applicable experience clearly requires more than 8 years with no Master's-track reduction bringing max applicable years to 5 or below; OR in-office in a country the candidate cannot work in per profile.yml; OR skill stack with effectively zero overlap with the candidate (niche domain with no transferable evidence).
- When this rule fires or nearly fires, name the alignment signals in rationale.

Priority companies (rules #2 and #4):
${(priorityCompanies || []).join(', ') || '(none provided)'}

If the job text is clearly not a JD, still return JSON with low match_score and page_quality "poor".`;

  const user = `URL: ${url}
Page title: ${pageTitle}

--- candidate profile.yml ---
${profileYaml}

--- candidate cv.md ---
${cvMd}

--- scraped page text ---
${jdText}`;

  const msg = await client.messages.create({
    model,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const raw = (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed.match_score !== 'number') {
    return {
      ok: false,
      model,
      raw_response: raw.slice(0, 2000),
      error: 'Could not parse JSON with numeric match_score from model output',
    };
  }

  const company = String(parsed.company || '').trim();
  const role = String(parsed.role || '').trim();
  const role_family = normalizeRoleFamily(parsed.role_family);
  const min_years_experience = normalizeYears(parsed.min_years_experience);
  const max_years_experience = normalizeYears(parsed.max_years_experience);

  return {
    ok: true,
    model,
    match_score: parsed.match_score,
    rationale: String(parsed.rationale || '').slice(0, 2000),
    page_quality: String(parsed.page_quality || ''),
    company,
    role,
    role_family,
    min_years_experience,
    max_years_experience,
  };
}

await loadDotenv();

const urlFile = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : DEFAULT_URL_FILE;

if (!existsSync(urlFile)) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: `Missing URL file: ${urlFile}`,
        hint: `Copy jobhunt/ai-test/urls.example.txt to jobhunt/ai-test/urls.txt and add one URL per line.`,
      },
      null,
      2
    )
  );
  process.exit(1);
}

const urls = readUrlsFile(urlFile);
if (urls.length === 0) {
  console.error(JSON.stringify({ ok: false, error: 'No URLs in file' }, null, 2));
  process.exit(1);
}
if (urls.length > 15) {
  console.error(JSON.stringify({ ok: false, error: 'Max 15 URLs per run' }, null, 2));
  process.exit(1);
}

const model = resolveAnthropicModel('score');
const client = createAnthropicClient();
const profileYaml = loadProfileSnippet();
const cvMd = loadCvSnippet();
const priorityCompanies = loadPriorityCompanyNames();

const report = {
  ok: true,
  model,
  url_file: urlFile,
  started_at: new Date().toISOString(),
  results: [],
};

mkdirSync(OUT_DIR, { recursive: true });

for (let i = 0; i < urls.length; i++) {
  const url = urls[i];
  const row = { url, index: i + 1 };

  const fetched = await fetchJobPagePlainText(url);
  if (!fetched.ok) {
    row.fetch_ok = false;
    row.fetch_error = fetched.error;
    report.results.push(row);
    await new Promise((r) => setTimeout(r, 800));
    continue;
  }

  row.fetch_ok = true;
  row.page_title = fetched.title;
  row.jd_char_count = fetched.text.length;

  try {
    const scored = await scoreOneJob(client, model, {
      url,
      pageTitle: fetched.title,
      jdText: fetched.text,
      profileYaml,
      cvMd,
      priorityCompanies,
    });
    Object.assign(row, scored);
  } catch (err) {
    row.ok = false;
    row.error = err?.message || String(err);
  }

  report.results.push(row);
  await new Promise((r) => setTimeout(r, 1200));
}

report.finished_at = new Date().toISOString();
writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), 'utf-8');
const anyScored = report.results.some(
  (r) => r.ok === true && typeof r.match_score === 'number'
);
console.log(JSON.stringify({ wrote: OUT_FILE, count: report.results.length, model, anyScored }, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(anyScored ? 0 : 1);
