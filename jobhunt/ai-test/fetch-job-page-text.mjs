/**
 * Fetch human-visible text from a job posting URL (Playwright).
 * Many ATS pages work well; some sites block bots or require login — caller handles errors.
 */

import { chromium } from 'playwright';

const DEFAULT_TIMEOUT_MS = 55_000;
const DEFAULT_MAX_CHARS = 48_000;

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, maxChars?: number }} [opts]
 * @returns {Promise<{ ok: true, text: string, title: string } | { ok: false, error: string }>}
 */
export async function fetchJobPagePlainText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await new Promise((r) => setTimeout(r, 1500));

    const title = (await page.title()).trim() || '';

    const text = await page.evaluate(() => {
      document.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());
      const body = document.body;
      if (!body) return '';
      return body.innerText || '';
    });

    const collapsed = String(text).replace(/\s+/g, ' ').trim();
    const clipped =
      collapsed.length > maxChars ? collapsed.slice(0, maxChars) + '\n…[truncated]' : collapsed;

    await context.close();
    await browser.close();

    if (!clipped || clipped.length < 80) {
      return {
        ok: false,
        error:
          'Very little text extracted (page may be login-only, blocked, or empty). Try another URL or open in visible browser later.',
      };
    }

    return { ok: true, text: clipped, title };
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    return { ok: false, error: err?.message || String(err) };
  }
}
