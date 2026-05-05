#!/usr/bin/env node
/**
 * scripts/rate-limit-smoke.mjs
 *
 * Verification for `integrations/google/rate-limit.mjs`:
 *
 *   1) Throughput pacing: 30 calls at qps=1 (burst=1) should take ~30s
 *      (allowing for initial token; we expect 28-32s).
 *   2) Retry on 429: a single 429 from a fake call body should be retried
 *      and counted; second attempt succeeds.
 *   3) Retry on 5xx: same path with status=503.
 *   4) No retry on 400: status=400 should propagate immediately.
 *
 * Run from career-ops/:
 *   node scripts/rate-limit-smoke.mjs
 *
 * Exit code 0 on pass, 1 on any failure.
 */

import { withGoogleApi, getGoogleApiMetrics, _resetGoogleApiMetricsForTest } from '../../integrations/google/rate-limit.mjs';

let failures = 0;
function assert(cond, label, extra = '') {
  if (!cond) {
    failures += 1;
    console.error(`FAIL  ${label} ${extra}`);
  } else {
    console.log(`pass  ${label}`);
  }
}

/* ---- Test 1: throughput pacing at qps=1 (override via env) -------- */
process.env.JOBHUNT_GOOGLE_SHEETS_QPS = '1';
process.env.JOBHUNT_GOOGLE_SHEETS_BURST = '1';
process.env.JOBHUNT_GOOGLE_RETRY_BASE_MS = '50';
process.env.JOBHUNT_GOOGLE_RETRY_MAX_MS = '200';

// Re-import after env mutation. (`makeBucket` reads env at module load, so
// for an honest test we set env BEFORE the module loads. Since ESM caches
// modules, we use a child-process style approach: execute the test in a
// fresh worker.) Easiest: spawn a child node for the throughput case.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const childPath = join(__dirname, 'rate-limit-smoke-child.mjs');

const t0 = Date.now();
const child = spawnSync(process.execPath, [childPath], {
  env: {
    ...process.env,
    JOBHUNT_GOOGLE_SHEETS_QPS: '1',
    JOBHUNT_GOOGLE_SHEETS_BURST: '1',
  },
  encoding: 'utf-8',
});
const elapsed = Date.now() - t0;
if (child.status !== 0) {
  console.error('throughput child failed:', child.stderr);
  failures += 1;
} else {
  // 30 calls at qps=1, burst=1 → first call instant, then 29 × ~1s = ~29s
  // Allow generous tolerance to avoid flakiness on slow boxes.
  assert(
    elapsed >= 27_000 && elapsed <= 35_000,
    `throughput: 30 calls at qps=1 took ${elapsed}ms (expected ~29-32s)`
  );
}

/* ---- Test 2: retry on 429 ---------------------------------------- */
_resetGoogleApiMetricsForTest();
let attempts429 = 0;
const out429 = await withGoogleApi('sheetsWrite', async () => {
  attempts429 += 1;
  if (attempts429 === 1) {
    const e = new Error('Quota exceeded');
    e.code = 429;
    throw e;
  }
  return 'ok';
});
const m429 = getGoogleApiMetrics();
assert(out429 === 'ok', 'retry-429: returns success after one retry');
assert(attempts429 === 2, 'retry-429: fn invoked exactly twice', `(was ${attempts429})`);
assert(m429.counters.sheetsWrite.calls === 2, 'retry-429: calls counter == 2', `(was ${m429.counters.sheetsWrite.calls})`);
assert(m429.counters.sheetsWrite.retries === 1, 'retry-429: retries counter == 1', `(was ${m429.counters.sheetsWrite.retries})`);

/* ---- Test 3: retry on 503 ---------------------------------------- */
_resetGoogleApiMetricsForTest();
let attempts503 = 0;
const out503 = await withGoogleApi('drive', async () => {
  attempts503 += 1;
  if (attempts503 === 1) {
    const e = new Error('Backend error');
    e.code = 503;
    throw e;
  }
  return 'ok';
});
const m503 = getGoogleApiMetrics();
assert(out503 === 'ok', 'retry-503: returns success after one retry');
assert(m503.counters.drive.retries === 1, 'retry-503: drive retries counter == 1', `(was ${m503.counters.drive.retries})`);

/* ---- Test 4: no retry on 400 ------------------------------------- */
_resetGoogleApiMetricsForTest();
let attempts400 = 0;
let threw400 = false;
try {
  await withGoogleApi('sheetsRead', async () => {
    attempts400 += 1;
    const e = new Error('Bad request');
    e.code = 400;
    throw e;
  });
} catch (e) {
  threw400 = e?.code === 400;
}
const m400 = getGoogleApiMetrics();
assert(threw400, 'no-retry-400: error propagates immediately');
assert(attempts400 === 1, 'no-retry-400: fn invoked exactly once', `(was ${attempts400})`);
assert(m400.counters.sheetsRead.retries === 0, 'no-retry-400: retries counter == 0', `(was ${m400.counters.sheetsRead.retries})`);

/* ---- Test 5: 403 with quota wording IS retryable ----------------- */
_resetGoogleApiMetricsForTest();
let attempts403 = 0;
const out403 = await withGoogleApi('sheetsWrite', async () => {
  attempts403 += 1;
  if (attempts403 === 1) {
    const e = new Error('Quota exceeded for quota metric');
    e.code = 403;
    e.errors = [{ reason: 'rateLimitExceeded' }];
    throw e;
  }
  return 'ok';
});
const m403 = getGoogleApiMetrics();
assert(out403 === 'ok', 'retry-403-quota: succeeds after one retry');
assert(m403.counters.sheetsWrite.retries === 1, 'retry-403-quota: retries == 1');

console.log('\nresult:', failures === 0 ? 'PASS' : `${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
