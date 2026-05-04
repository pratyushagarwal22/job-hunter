import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * Load local candidate materials for Claude prompts (trimmed for token limits).
 */
export function loadCandidateContext() {
  const cvPath = join(ROOT, 'cv.md');
  const profilePath = join(ROOT, 'config', 'profile.yml');
  const digestPath = join(ROOT, 'article-digest.md');
  const templatePath = join(ROOT, 'templates', 'cv-template.tex');

  const cv = existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '';
  const profile = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '';
  const digest = existsSync(digestPath) ? readFileSync(digestPath, 'utf-8') : '';
  let templateHint = '';
  if (existsSync(templatePath)) {
    const full = readFileSync(templatePath, 'utf-8');
    templateHint =
      full.length > 12000 ? full.slice(0, 12000) + '\n% …[truncated — use same overall section order and style]\n' : full;
  }

  return {
    cv: cv.length > 20000 ? cv.slice(0, 20000) + '\n…[truncated]' : cv,
    profile: profile.length > 20000 ? profile.slice(0, 20000) + '\n…[truncated]' : profile,
    digest: digest.length > 12000 ? digest.slice(0, 12000) + '\n…[truncated]' : digest,
    templateHint,
  };
}
