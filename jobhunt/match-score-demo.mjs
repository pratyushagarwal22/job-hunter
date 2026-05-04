/**
 * Deterministic 0–10 demo scores by role for **jobhunt:seed-8** (e2e promotion gate).
 * Tune `E2E_PROMOTION_THRESHOLD` when the real scorer ships.
 */

export const E2E_PROMOTION_THRESHOLD = 6.0;

/** @type {Map<string, number>} */
export const ROLE_SCORE_BY_ROLE = new Map([
  ['Data Engineer', 8.2],
  ['Analytics Engineer', 7.4],
  ['Product Data Analyst', 6.2],
  ['BI Analyst', 5.4],
  ['Data Analyst', 4.7],
  ['Business Intelligence Engineer', 7.8],
  ['Product Analyst', 5.9],
  ['Business Analyst', 3.6],
  ['Analytics Manager', 6.8],
  ['Decision Scientist', 5.2],
]);

/**
 * @param {string} role
 * @returns {number}
 */
export function matchScoreForRole(role) {
  return ROLE_SCORE_BY_ROLE.get(role) ?? 5.0;
}
