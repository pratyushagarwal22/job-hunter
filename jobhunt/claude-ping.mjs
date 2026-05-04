#!/usr/bin/env node
/**
 * claude-ping.mjs
 *
 * One tiny Messages API call to verify ANTHROPIC_API_KEY and network.
 * Does not touch Sheets or Drive.
 *
 *   npm run jobhunt:claude-ping
 *   # same as:
 *   node jobhunt/claude-ping.mjs
 */

import Anthropic from '@anthropic-ai/sdk';
import process from 'node:process';

import { loadDotenv, requireEnv } from '../integrations/google/env.mjs';

await loadDotenv();

const report = { ok: false, model: null, snippet: null };

try {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  // Default: current Haiku alias (cheap ping). Override with ANTHROPIC_MODEL, e.g. claude-sonnet-4-20250514
  const model =
    process.env.ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5';

  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model,
    max_tokens: 32,
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly the two characters OK and nothing else.',
      },
    ],
  });

  const text = (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  report.model = model;
  report.snippet = text.slice(0, 120);
  report.ok = true;
} catch (err) {
  report.error = err?.message || String(err);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
