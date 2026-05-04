#!/usr/bin/env node
/**
 * One short API call per task-specific model env (score, linkedin, resume, resume_summary, outreach).
 * Confirms each ANTHROPIC_MODEL_* id is accepted by the API.
 *
 *   npm run jobhunt:ai-verify-models
 */

import process from 'node:process';

import { loadDotenv, requireEnv } from '../../integrations/google/env.mjs';
import { createAnthropicClient, resolveAnthropicModel } from '../../integrations/anthropic/config.mjs';

await loadDotenv();

const tasks = /** @type {const} */ (['score', 'linkedin', 'resume', 'resume_summary', 'outreach']);
const report = { ok: true, checks: [] };

try {
  requireEnv('ANTHROPIC_API_KEY');
  const client = createAnthropicClient();

  for (const task of tasks) {
    const model = resolveAnthropicModel(task);
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply: OK' }],
      });
      const text = (msg.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      report.checks.push({ task, model, ok: true, snippet: text.slice(0, 80) });
    } catch (err) {
      report.ok = false;
      report.checks.push({
        task,
        model,
        ok: false,
        error: err?.message || String(err),
      });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
} catch (err) {
  report.ok = false;
  report.error = err?.message || String(err);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
