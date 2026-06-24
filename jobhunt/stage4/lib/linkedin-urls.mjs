import { readFileSync } from 'node:fs';

import { normalizeLinkedInUrl } from './contacts-helpers.mjs';

/**
 * Parse linkedin-profiles.txt lines into { url, notesTag } entries.
 */
export function readLinkedInProfilesFile(path) {
  const raw = readFileSync(path, 'utf-8');
  const entries = [];
  const seen = new Set();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    let urlPart = trimmed;
    let notesTag = '';
    const hashIdx = trimmed.indexOf('#');
    if (hashIdx >= 0) {
      const before = trimmed.slice(0, hashIdx).trim();
      const after = trimmed.slice(hashIdx + 1).trim();
      if (before.includes('linkedin.com')) {
        urlPart = before;
        notesTag = after;
      }
    }

    const url = normalizeLinkedInUrl(urlPart);
    if (!url || !url.includes('linkedin.com/in/')) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push({ url, notesTag, input_line: trimmed });
  }

  return entries;
}
