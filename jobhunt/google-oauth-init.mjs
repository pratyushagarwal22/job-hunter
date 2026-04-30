#!/usr/bin/env node
/**
 * google-oauth-init.mjs
 *
 * One-time OAuth setup for Google Drive uploads (personal Gmail).
 *
 * Flow:
 * - Prints a Google consent URL
 * - You open it, approve access, copy the "code"
 * - Paste code into this CLI
 * - Saves tokens to GOOGLE_OAUTH_TOKEN_PATH (gitignored)
 *
 * Usage:
 *   node jobhunt/google-oauth-init.mjs
 */

import readline from 'readline';
import { loadDotenv } from '../integrations/google/env.mjs';
import { getDriveOAuthUrl, saveOAuthToken } from '../integrations/google/oauth.mjs';

await loadDotenv();

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

const { oAuth2Client, url } = await getDriveOAuthUrl();

console.log('\nOpen this URL in your browser and approve access:\n');
console.log(url);
console.log('\nAfter approving, copy the code and paste it here.\n');

const code = (await ask('Authorization code: ')).trim();
if (!code) {
  console.error('No code provided.');
  process.exit(1);
}

try {
  const { tokens } = await oAuth2Client.getToken(code);
  const savedPath = await saveOAuthToken(tokens);
  console.log(`\nSaved OAuth token to: ${savedPath}\n`);
  console.log('Next: run `node jobhunt/google-smoke-test.mjs` to verify Drive + Sheets.\n');
  process.exit(0);
} catch (err) {
  console.error(`Failed to exchange code for token: ${err?.message || String(err)}`);
  process.exit(1);
}

