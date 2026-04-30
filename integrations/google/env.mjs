import { existsSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Bootstrap: load .env before anything else
// ---------------------------------------------------------------------------
export async function loadDotenv() {
  try {
    const { config } = await import('dotenv');
    config();
  } catch {
    // dotenv is optional — fall back to process.env if not installed
  }
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(v).trim();
}

export function normalizeGoogleSheetId(raw) {
  const v = String(raw || '').trim();
  if (!v) return v;

  // Accept full URLs and extract /d/<id>
  const m = v.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m?.[1]) return m[1];

  // Sometimes user pastes "<id>/edit?..."; keep only the leading id
  return v.split('/')[0];
}

export function resolveCredsPath(p) {
  const abs = resolve(p);
  if (!existsSync(abs)) {
    throw new Error(`Credentials file not found at: ${abs}`);
  }
  return abs;
}

export function resolveEnvPath(envName) {
  const p = requireEnv(envName);
  const abs = resolve(p);
  if (!existsSync(abs)) {
    throw new Error(`${envName} not found at: ${abs}`);
  }
  return abs;
}

