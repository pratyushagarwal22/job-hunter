import Anthropic from '@anthropic-ai/sdk';

import { requireEnv } from '../google/env.mjs';

/**
 * Per-task model resolution (optional env overrides).
 * Falls back to ANTHROPIC_MODEL, then per-task defaults.
 *
 * Env vars:
 *   ANTHROPIC_MODEL_SCORE, ANTHROPIC_MODEL_LINKEDIN,
 *   ANTHROPIC_MODEL_RESUME, ANTHROPIC_MODEL_RESUME_SUMMARY,
 *   ANTHROPIC_MODEL_OUTREACH, ANTHROPIC_MODEL_COVER_LETTER
 *
 * Tasks:
 *   - score — JD-to-profile match scoring (0–10). Override: ANTHROPIC_MODEL_SCORE, default Sonnet.
 *   - linkedin — LinkedIn connection note template. Override: ANTHROPIC_MODEL_LINKEDIN, default Haiku.
 *   - resume — full tailored resume (LaTeX JSON for PDF). Override: ANTHROPIC_MODEL_RESUME, default Opus.
 *   - resume_summary — plain-text summary for ASSETS column only. Override: ANTHROPIC_MODEL_RESUME_SUMMARY, default Sonnet.
 *   - outreach — outreach email template (JSON subject+body). Override: ANTHROPIC_MODEL_OUTREACH, default Opus.
 *   - cover_letter — team-directed cover letter (plain text). Override: ANTHROPIC_MODEL_COVER_LETTER, default Sonnet.
 */
const DEFAULT_BY_TASK = {
  score: 'claude-sonnet-4-6',
  linkedin: 'claude-haiku-4-5',
  resume: 'claude-opus-4-8',
  resume_summary: 'claude-sonnet-4-6',
  outreach: 'claude-opus-4-8',
  cover_letter: 'claude-sonnet-4-6',
};

const ENV_KEY_BY_TASK = {
  score: 'ANTHROPIC_MODEL_SCORE',
  linkedin: 'ANTHROPIC_MODEL_LINKEDIN',
  resume: 'ANTHROPIC_MODEL_RESUME',
  resume_summary: 'ANTHROPIC_MODEL_RESUME_SUMMARY',
  outreach: 'ANTHROPIC_MODEL_OUTREACH',
  cover_letter: 'ANTHROPIC_MODEL_COVER_LETTER',
};

/**
 * @param {'score' | 'linkedin' | 'resume' | 'resume_summary' | 'outreach' | 'cover_letter'} task
 */
export function resolveAnthropicModel(task) {
  const key = ENV_KEY_BY_TASK[task];
  const specific = key ? String(process.env[key] || '').trim() : '';
  const generic = String(process.env.ANTHROPIC_MODEL || '').trim();

  return (
    specific ||
    generic ||
    DEFAULT_BY_TASK[task] ||
    DEFAULT_BY_TASK.score
  );
}

export function createAnthropicClient() {
  return new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
}
