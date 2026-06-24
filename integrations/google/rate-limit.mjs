/**
 * Google API rate limiter + retry with exponential backoff.
 *
 * Google Sheets caps reads and writes at 60/min/user/project (300/min/project).
 * Google Drive caps usage at 1M quota units/min/project. With ~3,200+ writes
 * per Stage 3 run at config/portals.yml scale, a naïve loop trips 403/429 within
 * seconds. This module funnels every Sheets/Drive call through:
 *
 *   1) A token-bucket per lane (sheetsRead / sheetsWrite / drive) that paces
 *      dispatch below the user-quota ceiling with a small burst budget.
 *   2) An exponential-backoff retry on transient errors (429, 5xx, and 403
 *      with rate/quota wording).
 *   3) Process-wide counters so the run report can show how close we got to
 *      the caps and how many retries kicked in.
 *
 * Pure JS, no deps. Imported by integrations/google/sheets.mjs and drive.mjs.
 *
 * Env tunables (all optional; defaults are conservative under the user cap):
 *   JOBHUNT_GOOGLE_SHEETS_QPS         default 0.83 (≈ 50/min, leaves 10/min headroom)
 *   JOBHUNT_GOOGLE_DRIVE_QPS          default 3.33 (≈ 200/min)
 *   JOBHUNT_GOOGLE_SHEETS_BURST       default 10
 *   JOBHUNT_GOOGLE_DRIVE_BURST        default 30
 *   JOBHUNT_GOOGLE_RETRY_MAX_ATTEMPTS default 5
 *   JOBHUNT_GOOGLE_RETRY_BASE_MS      default 1000
 *   JOBHUNT_GOOGLE_RETRY_MAX_MS       default 32000
 */

function envFloat(name, fallback) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * One bucket per lane. Refills at `qps` tokens/sec, caps at `burst` tokens.
 * `take()` blocks until at least one token is available, then debits one.
 *
 * Implementation note: we serialize takers behind a chain so two concurrent
 * callers don't both observe ≥ 1 token and both decrement (lock-free
 * implementations of token buckets need atomics; we don't have those in
 * single-threaded JS, but two awaits on the same microtask boundary can race
 * if we don't queue).
 */
function makeBucket({ qps, burst }) {
  let tokens = burst;
  let last = Date.now();
  let chain = Promise.resolve();
  return function take() {
    const next = chain.then(async () => {
      while (true) {
        const now = Date.now();
        tokens = Math.min(burst, tokens + ((now - last) / 1000) * qps);
        last = now;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        const waitMs = Math.max(1, Math.ceil(((1 - tokens) / qps) * 1000));
        await new Promise((r) => setTimeout(r, waitMs));
      }
    });
    chain = next.catch(() => {});
    return next;
  };
}

const sheetsQps = envFloat('JOBHUNT_GOOGLE_SHEETS_QPS', 0.83);
const driveQps = envFloat('JOBHUNT_GOOGLE_DRIVE_QPS', 3.33);
const sheetsBurst = envInt('JOBHUNT_GOOGLE_SHEETS_BURST', 10);
const driveBurst = envInt('JOBHUNT_GOOGLE_DRIVE_BURST', 30);

const lanes = {
  sheetsRead: makeBucket({ qps: sheetsQps, burst: sheetsBurst }),
  sheetsWrite: makeBucket({ qps: sheetsQps, burst: sheetsBurst }),
  drive: makeBucket({ qps: driveQps, burst: driveBurst }),
};

const counters = {
  sheetsRead: { calls: 0, retries: 0, last_status: null },
  sheetsWrite: { calls: 0, retries: 0, last_status: null },
  drive: { calls: 0, retries: 0, last_status: null },
};

const config = {
  qps: { sheetsRead: sheetsQps, sheetsWrite: sheetsQps, drive: driveQps },
  burst: { sheetsRead: sheetsBurst, sheetsWrite: sheetsBurst, drive: driveBurst },
};

/**
 * Run `fn()` under a token-bucket gate for `lane`, retrying on transient
 * Google API errors (429, 5xx, and 403 with rate/quota wording).
 *
 * `fn` should be a thunk that performs the actual googleapis call so this
 * wrapper can re-invoke it on retry.
 *
 * Errors that are NOT considered retryable are re-thrown immediately so the
 * caller sees them on the first attempt (e.g. 400 invalid args, 404 not
 * found). Those are programmer errors, not throughput problems.
 *
 * @template T
 * @param {'sheetsRead'|'sheetsWrite'|'drive'} lane
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withGoogleApi(lane, fn) {
  if (!lanes[lane]) throw new Error(`Unknown rate-limit lane: ${lane}`);
  const maxAttempts = envInt('JOBHUNT_GOOGLE_RETRY_MAX_ATTEMPTS', 5);
  const baseMs = envInt('JOBHUNT_GOOGLE_RETRY_BASE_MS', 1000);
  const maxMs = envInt('JOBHUNT_GOOGLE_RETRY_MAX_MS', 32000);

  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await lanes[lane]();
    counters[lane].calls += 1;
    try {
      const out = await fn();
      counters[lane].last_status = 200;
      return out;
    } catch (err) {
      const status =
        (err && (err.code || err?.response?.status || err?.status)) || null;
      const reasonRaw =
        err?.errors?.[0]?.reason ||
        err?.response?.data?.error?.errors?.[0]?.reason ||
        err?.response?.data?.error?.status ||
        '';
      const reason = String(reasonRaw || '').toLowerCase();
      const message = String(err?.message || '').toLowerCase();
      counters[lane].last_status = status;

      const retryable =
        status === 429 ||
        (typeof status === 'number' && status >= 500 && status < 600) ||
        (status === 403 &&
          (reason.includes('rate') ||
            reason.includes('quota') ||
            reason.includes('userratelimit') ||
            message.includes('quota') ||
            message.includes('rate limit')));

      if (!retryable || attempt === maxAttempts - 1) {
        lastErr = err;
        throw err;
      }
      counters[lane].retries += 1;
      const sleep =
        Math.min(maxMs, baseMs * 2 ** attempt) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, sleep));
      lastErr = err;
    }
  }
  // Unreachable in practice; the `throw err` in the loop handles exhaustion.
  throw lastErr || new Error(`Google API ${lane} retry budget exhausted`);
}

/**
 * Snapshot of per-lane counters since process start. Stages attach this to
 * their final report so the user can see throughput/retries without parsing
 * stderr.
 */
export function getGoogleApiMetrics() {
  return {
    config: JSON.parse(JSON.stringify(config)),
    counters: JSON.parse(JSON.stringify(counters)),
  };
}

/**
 * Reset counters. Tests use this to assert per-test behavior.
 */
export function _resetGoogleApiMetricsForTest() {
  for (const lane of Object.keys(counters)) {
    counters[lane].calls = 0;
    counters[lane].retries = 0;
    counters[lane].last_status = null;
  }
}
