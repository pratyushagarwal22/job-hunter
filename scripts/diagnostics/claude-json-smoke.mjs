#!/usr/bin/env node
/**
 * scripts/diagnostics/claude-json-smoke.mjs
 *
 * Verification for `jobhunt/lib/claude-json.mjs`. Runs a handful of fixtures
 * representative of real Claude outputs and asserts the parser returns the
 * expected shape. Pure JS, no env, no network, runs in <1s.
 *
 * Run from career-ops/:
 *   node scripts/diagnostics/claude-json-smoke.mjs
 *
 * Exit code 0 on pass, 1 on any failure.
 */

import { extractJsonObject, stripMarkdownCodeFence } from '../../jobhunt/lib/claude-json.mjs';

let failures = 0;
function pass(label) {
  console.log(`pass  ${label}`);
}
function fail(label, extra = '') {
  failures += 1;
  console.error(`FAIL  ${label}${extra ? `  — ${extra}` : ''}`);
}
function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(label);
  else fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTruthy(actual, label) {
  if (actual) pass(label);
  else fail(label, `expected truthy, got ${JSON.stringify(actual)}`);
}

/* ---- Fixture 1: bare object, no fence, no surrounding text -------- */
{
  const out = extractJsonObject('{"match_score": 7.5, "page_quality": "good"}');
  assertEqual(out, { match_score: 7.5, page_quality: 'good' }, 'bare object');
}

/* ---- Fixture 2: fenced ```json block (the Palo Alto shape) -------- */
{
  const fenced = [
    '```json',
    '{',
    '  "match_score": 6.5,',
    '  "rationale": "This is an entry-level AI Financial Analyst role; visa sponsorship requirement (\\"No\\") prevent a higher score.",',
    '  "page_quality": "good"',
    '}',
    '```',
  ].join('\n');
  const out = extractJsonObject(fenced);
  assertTruthy(out && typeof out === 'object', 'fenced block parses');
  if (out) {
    assertEqual(out.match_score, 6.5, 'fenced match_score');
    assertEqual(out.page_quality, 'good', 'fenced page_quality');
    assertTruthy(
      typeof out.rationale === 'string' && out.rationale.includes('"No"'),
      'fenced rationale preserves escaped quotes',
    );
  }
}

/* ---- Fixture 3: object followed by trailing prose ----------------- */
{
  const trailing =
    '{"match_score": 4, "page_quality": "weak"}\n\nNote: scored low because the JD was sparse.';
  const out = extractJsonObject(trailing);
  assertEqual(out, { match_score: 4, page_quality: 'weak' }, 'trailing prose stripped');
}

/* ---- Fixture 4: closing brace inside a string value --------------- */
{
  // The rationale value contains a literal `}` — old lastIndexOf('}')
  // sliced *past* the actual JSON object and broke parsing. New parser
  // tracks string boundaries and gets it right.
  const tricky =
    '{"match_score": 8, "rationale": "Strong fit. JD mentions IaC: \\"Terraform } CDK\\".", "page_quality": "good"}';
  const out = extractJsonObject(tricky);
  assertEqual(out?.match_score, 8, 'brace-in-string match_score');
  assertEqual(out?.page_quality, 'good', 'brace-in-string page_quality');
  assertTruthy(
    typeof out?.rationale === 'string' && out.rationale.includes('Terraform } CDK'),
    'brace-in-string rationale preserved verbatim',
  );
}

/* ---- Fixture 5: nested object inside a fenced block --------------- */
{
  // Exercises depth tracking — outer `{` should not close on the inner `}`.
  const nested = '```json\n{"a": {"b": 1, "c": {"d": "x"}}, "e": 2}\n```';
  const out = extractJsonObject(nested);
  assertEqual(out, { a: { b: 1, c: { d: 'x' } }, e: 2 }, 'nested depth tracking');
}

/* ---- Fixture 6: leading prose then fenced JSON (double-source) ---- */
{
  // Some Claude outputs prepend a sentence before the fence. We strip a
  // leading fence only when the *trimmed* input starts with ```; here it
  // doesn't, but the brace-balanced scanner still finds the inner object.
  const messy =
    'Sure! Here is the score:\n```json\n{"match_score": 5, "page_quality": "ok"}\n```\nLet me know if you need adjustments.';
  const out = extractJsonObject(messy);
  assertEqual(out, { match_score: 5, page_quality: 'ok' }, 'fenced-with-prose still parses');
}

/* ---- Fixture 7: stripMarkdownCodeFence is idempotent on plain ----- */
{
  assertEqual(
    stripMarkdownCodeFence('  {"x": 1}  '),
    '{"x": 1}',
    'stripMarkdownCodeFence trims whitespace on unfenced',
  );
  assertEqual(
    stripMarkdownCodeFence('```json\n{"x": 1}\n```'),
    '{"x": 1}',
    'stripMarkdownCodeFence removes ```json fence',
  );
  assertEqual(
    stripMarkdownCodeFence('```\n{"x": 1}\n```'),
    '{"x": 1}',
    'stripMarkdownCodeFence removes bare ``` fence',
  );
}

/* ---- Fixture 8: truncated input → null (caller surfaces ok:false) - */
{
  // Mid-string truncation has no balanced closing brace; parser returns
  // null and the caller is expected to mark the row failed.
  const truncated = '{"match_score": 6, "rationale": "This is incomplete';
  const out = extractJsonObject(truncated);
  assertEqual(out, null, 'truncated mid-string returns null');
}

/* ---- Fixture 9: non-JSON noise → null ----------------------------- */
{
  const out = extractJsonObject('I cannot complete this request.');
  assertEqual(out, null, 'non-JSON noise returns null');
}

/* ---- Fixture 10: empty / nullish input → null --------------------- */
{
  assertEqual(extractJsonObject(''), null, 'empty string returns null');
  assertEqual(extractJsonObject(null), null, 'null input returns null');
  assertEqual(extractJsonObject(undefined), null, 'undefined input returns null');
}

if (failures > 0) {
  console.error(`\n${failures} fixture(s) failed.`);
  process.exit(1);
}
console.log('\nAll fixtures passed.');
