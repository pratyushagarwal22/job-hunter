/**
 * Shared Claude-output JSON extractor.
 *
 * Claude's "STRICT JSON only" outputs can still arrive wrapped in a markdown
 * fence, with leading/trailing prose, or with a stray `}` later in the
 * response. The original copy of this helper used `indexOf('{')` ...
 * `lastIndexOf('}')` which silently mis-slices any of those cases — that's
 * the bug that produced `ok:false` for the Palo Alto AI Financial Analyst
 * row even though the inner JSON was valid.
 *
 * This module replaces those two duplicated copies (one in
 * `jobhunt/ai-test/score-from-urls.mjs`, one in
 * `jobhunt/lib/claude-asset-generators.mjs`) with a single brace-balanced,
 * string-aware scanner. Stage 1 (future portals.yml ingestion) reuses it.
 *
 * Tolerated input shapes (parser succeeds):
 *   - bare object: `{ "x": 1 }`
 *   - fenced object: ```json\n{...}\n```
 *   - object surrounded by prose: `Sure! {"x": 1} hope this helps.`
 *   - object containing `}` inside a string value
 *   - object containing escaped quotes: `{"q": "say \"hi\""}`
 *
 * Not tolerated (parser returns null, caller should surface ok:false):
 *   - truncated mid-string output (no balanced closing brace)
 *   - genuinely malformed JSON (unquoted keys, trailing commas before `}`)
 */

/**
 * Strip a single leading ``` / ```json / ```text / ```plaintext fence and a
 * matching trailing fence. Idempotent on unfenced input. Whitespace-trim only.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function stripMarkdownCodeFence(s) {
  let t = String(s || '').trim();
  if (t.startsWith('```')) {
    t = t
      .replace(/^```(?:json|plaintext|text)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
  }
  return t;
}

/**
 * Walk the (fence-stripped) string and return the first brace-balanced,
 * `JSON.parse`-able object. Returns null only when no balanced+parseable
 * object exists.
 *
 * Algorithm:
 *   for each `{` in the input:
 *     scan forward, tracking depth; ignore braces inside string literals
 *     (handling \" / \\ escapes). When depth returns to 0, attempt
 *     JSON.parse on that slice. If it parses, done. If not, advance to the
 *     next `{` and try again.
 *
 * Worst-case is O(n) per starting `{`, but in practice the first balanced
 * candidate parses, so this is effectively linear in the size of the JSON
 * payload itself.
 *
 * @template T
 * @param {unknown} text
 * @returns {T | null}
 */
export function extractJsonObject(text) {
  const s = stripMarkdownCodeFence(text);
  const n = s.length;

  for (let start = 0; start < n; start++) {
    if (s[start] !== '{') continue;

    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let i = start; i < n; i++) {
      const ch = s[i];

      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\') {
          esc = true;
          continue;
        }
        if (ch === '"') inStr = false;
        continue;
      }

      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === '{') {
        depth++;
        continue;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = s.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            // This `{...}` slice was balanced but not parseable. Bail to the
            // outer loop so we try the next `{` (e.g. a second JSON block
            // later in the response).
          }
          break;
        }
      }
    }
  }
  return null;
}
