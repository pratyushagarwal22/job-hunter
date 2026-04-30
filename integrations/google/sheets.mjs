import { normalizeGoogleSheetId, requireEnv } from './env.mjs';
import { getSheetsClient } from './auth.mjs';

export const REQUIRED_TABS = [
  'INBOX_RAW',
  'SHORTLIST',
  'CONTACTS',
  'ASSETS',
  'OUTREACH',
  'PIPELINE_STATUS',
];

export async function getSheetIdByTitle(title) {
  const { spreadsheet } = await getSpreadsheet();
  for (const s of spreadsheet.sheets || []) {
    if (s.properties?.title === title) return s.properties.sheetId;
  }
  return null;
}

export async function getSpreadsheet() {
  const sheets = await getSheetsClient();
  const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  return { sheets, spreadsheetId, spreadsheet: res.data };
}

export function listTabTitles(spreadsheet) {
  return (spreadsheet.sheets || [])
    .map(s => s.properties?.title)
    .filter(Boolean);
}

export async function ensureTabsExist(titles = REQUIRED_TABS) {
  const { sheets, spreadsheetId, spreadsheet } = await getSpreadsheet();
  const existing = new Set(listTabTitles(spreadsheet));
  const missing = titles.filter(t => !existing.has(t));
  if (missing.length === 0) return { spreadsheetId, created: [] };

  const requests = missing.map(title => ({
    addSheet: { properties: { title } },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  return { spreadsheetId, created: missing };
}

export async function appendRow(tabTitle, values) {
  const sheets = await getSheetsClient();
  const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));

  const range = `${tabTitle}!A1`;
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });

  return res.data;
}

export async function ensureHeaderRow(tabTitle, headers) {
  const sheets = await getSheetsClient();
  const spreadsheetId = normalizeGoogleSheetId(requireEnv('GOOGLE_SHEET_ID'));

  const range = `${tabTitle}!A1:ZZ1`;
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const row = (existing.data.values && existing.data.values[0]) ? existing.data.values[0] : [];

  const same =
    row.length >= headers.length &&
    headers.every((h, i) => (row[i] || '').trim() === h);

  if (same) return { updated: false };

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabTitle}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  });

  return { updated: true };
}

export async function ensureHeaders(headerMap) {
  const ensured = [];
  for (const [tabTitle, headers] of Object.entries(headerMap)) {
    const res = await ensureHeaderRow(tabTitle, headers);
    ensured.push({ tabTitle, ...res });
  }
  return ensured;
}

export async function setDropdownValidation({ tabTitle, a1Range, options }) {
  const { sheets, spreadsheetId } = await getSpreadsheet();
  const sheetId = await getSheetIdByTitle(tabTitle);
  if (sheetId == null) throw new Error(`Sheet not found: ${tabTitle}`);

  // Convert A1 like "B2:B" or "B2:B1000" to GridRange.
  const m = a1Range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)?$/);
  if (!m) throw new Error(`Invalid A1 range for validation: ${a1Range}`);
  const [, colA, rowA, colB, rowB] = m;

  const colToIndex = (col) => {
    let n = 0;
    for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1; // 0-based
  };

  const startColumnIndex = colToIndex(colA);
  const endColumnIndex = colToIndex(colB) + 1;
  const startRowIndex = Number(rowA) - 1;
  const endRowIndex = rowB ? Number(rowB) : undefined; // undefined = open-ended

  const requests = [
    {
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex,
          endRowIndex,
          startColumnIndex,
          endColumnIndex,
        },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: options.map(o => ({ userEnteredValue: o })),
          },
          showCustomUi: true,
          strict: true,
        },
      },
    },
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  return { ok: true };
}

export async function clearTabExceptHeader(tabTitle) {
  const { sheets, spreadsheetId } = await getSpreadsheet();

  // Clear all values from row 2 onward, keep header row intact.
  // This avoids shrinking the sheet grid (which breaks validations like B2:B).
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tabTitle}!A2:ZZ`,
  });

  return { cleared: true };
}

export async function ensureMinRows(tabTitle, minRows) {
  const { sheets, spreadsheetId, spreadsheet } = await getSpreadsheet();
  const sheet = (spreadsheet.sheets || []).find(s => s.properties?.title === tabTitle);
  if (!sheet) throw new Error(`Sheet not found: ${tabTitle}`);

  const sheetId = sheet.properties.sheetId;
  const current = sheet.properties.gridProperties?.rowCount || 0;
  if (current >= minRows) return { updated: false, rowCount: current };

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { rowCount: minRows },
            },
            fields: 'gridProperties.rowCount',
          },
        },
      ],
    },
  });

  return { updated: true, rowCount: minRows };
}

