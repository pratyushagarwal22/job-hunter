import { google } from 'googleapis';
import { resolveCredsPath, requireEnv } from './env.mjs';
import { getDriveOAuthClient } from './oauth.mjs';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

export function getGoogleAuth() {
  const credsPath = resolveCredsPath(requireEnv('GOOGLE_APPLICATION_CREDENTIALS'));
  return new google.auth.GoogleAuth({
    keyFile: credsPath,
    scopes: SCOPES,
  });
}

export async function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: 'v4', auth });
}

export async function getDriveClient() {
  const auth = getGoogleAuth();
  return google.drive({ version: 'v3', auth });
}

export async function getDriveClientOAuth() {
  const auth = await getDriveOAuthClient();
  return google.drive({ version: 'v3', auth });
}

