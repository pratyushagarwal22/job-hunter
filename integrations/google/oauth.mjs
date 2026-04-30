import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { google } from 'googleapis';
import { requireEnv, resolveEnvPath } from './env.mjs';

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

function parseOAuthClientJson(json) {
  // Google downloads either "installed" (desktop) or "web" (web app) formats.
  const cfg = json.installed || json.web;
  if (!cfg) throw new Error('Invalid OAuth client JSON (expected installed or web)');
  const { client_id, client_secret, redirect_uris } = cfg;
  if (!client_id || !client_secret || !redirect_uris?.length) {
    throw new Error('OAuth client JSON missing client_id/client_secret/redirect_uris');
  }
  return { client_id, client_secret, redirect_uris };
}

export async function loadOAuthClient() {
  const clientPath = resolveEnvPath('GOOGLE_OAUTH_CLIENT_PATH');
  const raw = await readFile(clientPath, 'utf-8');
  const json = JSON.parse(raw);
  const { client_id, client_secret, redirect_uris } = parseOAuthClientJson(json);

  // Prefer an out-of-band compatible redirect if present, else first.
  const redirectUri =
    redirect_uris.find(u => u.includes('urn:ietf:wg:oauth:2.0:oob')) ||
    redirect_uris.find(u => u.startsWith('http://localhost')) ||
    redirect_uris[0];

  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

export async function readOAuthTokenIfPresent() {
  const abs = resolve(requireEnv('GOOGLE_OAUTH_TOKEN_PATH'));
  try {
    const raw = await readFile(abs, 'utf-8');
    return { path: abs, token: JSON.parse(raw) };
  } catch {
    return { path: abs, token: null };
  }
}

export async function saveOAuthToken(token) {
  const abs = resolve(requireEnv('GOOGLE_OAUTH_TOKEN_PATH'));
  await writeFile(abs, JSON.stringify(token, null, 2), 'utf-8');
  return abs;
}

export async function getDriveOAuthClient() {
  const oAuth2Client = await loadOAuthClient();
  const { token } = await readOAuthTokenIfPresent();
  if (!token) {
    throw new Error('Missing OAuth token. Run: node jobhunt/google-oauth-init.mjs');
  }
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

export async function getDriveOAuthUrl() {
  const oAuth2Client = await loadOAuthClient();
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: DRIVE_SCOPES,
  });
  return { oAuth2Client, url };
}

