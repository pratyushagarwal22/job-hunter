import Anthropic from '@anthropic-ai/sdk';

import { requireEnv } from '../google/env.mjs';

/**
 * Per-task model resolution (optional env overrides).
 * Falls back to ANTHROPIC_MODEL, then per-task defaults.
 *
 * Env vars:
 *   ANTHROPIC_MODEL_SCORE, ANTHROPIC_MODEL_LINKEDIN,
 *   ANTHROPIC_MODEL_RESUME, ANTHROPIC_MODEL_RESUME_SUMMARY, ANTHROPIC_MODEL_OUTREACH
 *
 * Tasks:
 *   - resume — full tailored resume (LaTeX JSON for PDF: education, skills, experience, projects, optional research/extracurricular). Same model as cover letter. Override: ANTHROPIC_MODEL_RESUME, then ANTHROPIC_MODEL, default Sonnet.
 *   - resume_summary — plain-text summary for ASSETS column only (from Claude resume JSON + JD). Override: ANTHROPIC_MODEL_RESUME_SUMMARY, then ANTHROPIC_MODEL (not ANTHROPIC_MODEL_RESUME), default Haiku.
 */
const DEFAULT_BY_TASK = {
  score: 'claude-haiku-4-5',
  linkedin: 'claude-haiku-4-5',
  resume: 'claude-sonnet-4-20250514',
  resume_summary: 'claude-haiku-4-5',
  outreach: 'claude-sonnet-4-20250514',
};

const ENV_KEY_BY_TASK = {
  score: 'ANTHROPIC_MODEL_SCORE',
  linkedin: 'ANTHROPIC_MODEL_LINKEDIN',
  resume: 'ANTHROPIC_MODEL_RESUME',
  resume_summary: 'ANTHROPIC_MODEL_RESUME_SUMMARY',
  outreach: 'ANTHROPIC_MODEL_OUTREACH',
};

/**
 * @param {'score' | 'linkedin' | 'resume' | 'resume_summary' | 'outreach'} task
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
