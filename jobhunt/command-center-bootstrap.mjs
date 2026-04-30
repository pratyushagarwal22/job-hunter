#!/usr/bin/env node
/**
 * command-center-bootstrap.mjs
 *
 * Ensures:
 * - Required tabs exist
 * - Header rows are present (row 1) for each tab
 *
 * Usage:
 *   node jobhunt/command-center-bootstrap.mjs
 */

import { loadDotenv } from '../integrations/google/env.mjs';
import { ensureTabsExist, ensureHeaders, setDropdownValidation, ensureMinRows } from '../integrations/google/sheets.mjs';
import { HEADERS } from './command-center-schema.mjs';

await loadDotenv();

const report = { ok: false, tabsCreated: [], headers: [], validations: [] };

try {
  const tabs = await ensureTabsExist(Object.keys(HEADERS));
  report.tabsCreated = tabs.created;
  report.headers = await ensureHeaders(HEADERS);

  // Ensure enough rows exist for validations and future appends
  const minRows = 2000;
  report.rowSizing = {};
  for (const tabTitle of Object.keys(HEADERS)) {
    report.rowSizing[tabTitle] = await ensureMinRows(tabTitle, minRows);
  }

  // SHORTLIST.pursue dropdown values (B2:B)
  report.validations.push(await setDropdownValidation({
    tabTitle: 'SHORTLIST',
    a1Range: 'B2:B',
    options: ['UNREVIEWED', 'PURSUE', 'HOLD', 'SKIP'],
  }));

  report.ok = true;
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

