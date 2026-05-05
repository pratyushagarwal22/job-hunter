#!/usr/bin/env node
/**
 * inspect-shortlist-validation.mjs
 *
 * Prints whether SHORTLIST!B2:B10 cells have a dataValidation rule.
 *
 * Usage:
 *   node jobhunt/inspect-shortlist-validation.mjs
 */

import { loadDotenv } from '../integrations/google/env.mjs';
import { getSheetsClient } from '../integrations/google/auth.mjs';
import { normalizeGoogleSheetId, requireEnv } from '../integrations/google/env.mjs';
import { withGoogleApi } from '../integrations/google/rate-limit.mjs';

await loadDotenv();

const sheets = await getSheetsClient();
const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));

const res = await withGoogleApi('sheetsRead', () =>
  sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: true,
    ranges: ['SHORTLIST!B2:B10'],
    fields: 'sheets(properties.title,data.rowData.values.dataValidation)',
  })
);

const sheet = (res.data.sheets || []).find(s => s.properties?.title === 'SHORTLIST');
const rowData = sheet?.data?.[0]?.rowData || [];

const out = rowData.map((r, i) => {
  const dv = r?.values?.[0]?.dataValidation || null;
  const type = dv?.condition?.type || null;
  const values = (dv?.condition?.values || []).map(v => v.userEnteredValue).filter(Boolean);
  return { cell: `B${i + 2}`, hasValidation: Boolean(dv), type, values };
});

console.log(JSON.stringify({ ok: true, range: 'SHORTLIST!B2:B10', cells: out }, null, 2));

