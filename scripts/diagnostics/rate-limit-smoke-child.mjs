/**
 * Child process for the throughput-pacing test in rate-limit-smoke.mjs.
 * Loaded fresh so the per-lane buckets pick up the env knobs we set there.
 */

import { withGoogleApi } from '../../integrations/google/rate-limit.mjs';

const N = 30;
const start = Date.now();
for (let i = 0; i < N; i++) {
  await withGoogleApi('sheetsWrite', () => Promise.resolve(i));
}
const elapsed = Date.now() - start;
console.error(JSON.stringify({ N, elapsed }));
process.exit(0);
