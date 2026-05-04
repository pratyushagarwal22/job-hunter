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
import { ensureTabsExist, ensureHeaders, ensureMinRows, reapplyShortlistPursueDropdown } from '../integrations/google/sheets.mjs';
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

  // Ensure SHORTLIST is large enough so an open-ended validation range works well.
  // (Google Sheets needs the grid to already have rows for the dropdown UI to behave consistently.)
  report.rowSizing.SHORTLIST = await ensureMinRows('SHORTLIST', 50000);

  report.validations.push(await reapplyShortlistPursueDropdown());

  report.ok = true;
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

