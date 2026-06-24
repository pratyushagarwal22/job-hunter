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
import { buildScoringSystemPrompt } from '../lib/scoring-prompt.mjs';
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
  const system = buildScoringSystemPrompt(priorityCompanies);

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
if (urls.length > 50) {
  console.error(JSON.stringify({ ok: false, error: 'Max 50 URLs per run' }, null, 2));
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
