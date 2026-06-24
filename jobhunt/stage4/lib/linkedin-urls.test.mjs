/**
 * Lightweight URL parser tests (no network). Run: node jobhunt/stage4/lib/linkedin-urls.test.mjs
 */

import assert from 'node:assert/strict';

import { normalizeLinkedInUrl } from './contacts-helpers.mjs';
import { readLinkedInProfilesFile } from './linkedin-urls.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

assert.equal(
  normalizeLinkedInUrl('https://www.linkedin.com/in/Jane-Doe/'),
  'https://linkedin.com/in/jane-doe'
);
assert.equal(
  normalizeLinkedInUrl('linkedin.com/in/foo  # RECRUITER'),
  'https://linkedin.com/in/foo'
);

const tmp = join(tmpdir(), `stage4-urls-test-${Date.now()}.txt`);
writeFileSync(
  tmp,
  `# comment\nhttps://www.linkedin.com/in/a/\nhttps://linkedin.com/in/a/\nhttps://linkedin.com/in/b  # tag\n`,
  'utf-8'
);
const entries = readLinkedInProfilesFile(tmp);
unlinkSync(tmp);
assert.equal(entries.length, 2);
assert.equal(entries[1].notesTag, 'tag');

console.log(JSON.stringify({ ok: true, tests: 'linkedin-urls' }));
