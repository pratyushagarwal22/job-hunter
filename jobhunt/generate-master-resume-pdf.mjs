#!/usr/bin/env node
/**
 * generate-master-resume-pdf.mjs
 *
 * Builds a "master" resume PDF from cv.md using templates/cv-template.tex.
 * This is a pre-scan validation step: confirm formatting + links + sections.
 *
 * Output:
 * - output/jobhunt/master-resume-<job_id>.tex
 * - output/jobhunt/master-resume-<job_id>.pdf
 * - Uploads PDF to Drive under RESUME/Master/<YYYY-MM-DD_job_id>/
 * - Appends ASSETS row with resume_drive_link
 *
 * Usage:
 *   node jobhunt/generate-master-resume-pdf.mjs
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';

import { loadDotenv } from '../integrations/google/env.mjs';
import { getRootFolder, ensureSubfolders, ensureFolderPath, uploadFileFromPath } from '../integrations/google/drive.mjs';
import { appendRow } from '../integrations/google/sheets.mjs';
import { makeJobId, slugifyFolderName, ymd } from './ids.mjs';

await loadDotenv();

const ROOT = new URL('..', import.meta.url).pathname; // career-ops/

function latexEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function stripScheme(u) {
  return String(u || '').replace(/^https?:\/\//, '');
}

function latexEscapeUrl(url) {
  // hyperref URL argument is not normal LaTeX text, but `%` and `#` still break parsing.
  return String(url || '')
    .replace(/%/g, '\\%')
    .replace(/#/g, '\\#');
}

function mdLinkToHref(md) {
  // Converts "[text](url)" into "\href{url}{text}".
  const m = String(md).match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!m) return latexEscape(md);
  const [, text, url] = m;
  return `\\href{${latexEscapeUrl(url)}}{${latexEscape(text)}}`;
}

function normalizeLine(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .trimEnd();
}

function splitSections(md) {
  const lines = md.split('\n').map(normalizeLine);
  const sections = new Map();
  let current = null;
  for (const line of lines) {
    const h = line.match(/^#\s+(.+)\s*$/);
    if (h) {
      current = h[1].trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (!current) continue;
    sections.get(current).push(line);
  }
  return sections;
}

function collectBullets(lines, startIdx) {
  const bullets = [];
  let i = startIdx;
  let current = null;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) break;

    // stop when we hit next block header (often a dashed separator)
    if (/^-{5,}/.test(l)) {
      // Many sections in cv.md include decorative dashed lines between headings and bullets.
      // Skip those until we've started a bullet; afterwards treat as a block boundary.
      if (!current) continue;
      break;
    }

    const b = l.match(/^-+\s+(.*)$/);
    if (b) {
      const content = b[1].trim();

      // Treat markdown "separator header" rows as boundaries, not bullets.
      // Examples in cv.md:
      // - "----- -----" (all dashes)
      // - "**[Project](url)** ..." (next project heading)
      // - "**Company** 2024 -- 2026" (next experience/edu heading)
      const noSpace = content.replace(/\s/g, '');
      const isAllDashes = /^-+$/.test(noSpace) && noSpace.length >= 10;
      const isNextHeading = content.includes('**[') || content.includes('**') && /\d{4}/.test(content);

      if (isAllDashes || isNextHeading) {
        if (current) bullets.push(current.trim());
        current = null;
        break;
      }

      if (current) bullets.push(current.trim());
      current = content;
      continue;
    }

    // wrapped continuation line for the previous bullet
    if (current && (/^\s{2,}\S/.test(raw) || /^[a-zA-Z0-9(]/.test(l))) {
      current += ' ' + l;
    }
  }
  if (current) bullets.push(current.trim());
  return { bullets, nextIdx: i };
}

function bulletsToItems(bullets) {
  // Match your Overleaf source: plain \item { ... } (no "Impact:" / "Result:" / "Contribution:")
  return bullets
    .filter(Boolean)
    .map(b => `\\item {${latexEscape(b)}}`)
    .join('\n');
}

function parseEducation(lines) {
  // Pattern in cv.md: block starts with line containing **School** ... dates
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const schoolMatch = l.match(/\*\*(.+?)\*\*\s+(.*\d{4}.*)$/);
    if (!schoolMatch) continue;
    const school = schoolMatch[1].trim();
    const dateRange = schoolMatch[2].trim();

    const next = (lines[i + 1] || '').trim();
    const roleMatch = next.match(/^\*(.+?)\*\s+\*(.+?)\*\s*$/);
    const degree = roleMatch?.[1]?.trim() || '';
    const location = roleMatch?.[2]?.trim() || '';

    // Collect coursework/certs bullets (with wrapped lines) until next school block or section end.
    const bullets = [];
    let current = null;
    let j = i + 2;
    for (; j < lines.length; j++) {
      const raw = lines[j];
      const t = raw.trim();
      if (!t) continue;
      if (t.startsWith('#')) break;
      if (t.match(/\*\*(.+?)\*\*\s+.*\d{4}/)) break; // next school
      if (t.startsWith('<!--')) continue; // ignore html artifacts

      const b = t.match(/^-+\s+(.*)$/);
      if (b) {
        if (current) bullets.push(current.trim());
        current = b[1].trim();
        continue;
      }

      // wrapped continuation line
      if (current && (/^\s{2,}\S/.test(raw) || /^[a-zA-Z0-9(]/.test(t))) {
        current += ' ' + t;
      }
    }
    if (current) bullets.push(current.trim());

    const coursework = bullets.find(b => b.toLowerCase().startsWith('relevant coursework:'));
    const certs = bullets.find(b => b.toLowerCase().startsWith('certifications:'));

    out.push(
      [
        '\\resumeSubheading',
        `  {${latexEscape(school)}}{${latexEscape(dateRange)}}`,
        `  {${latexEscape(degree)}}{${latexEscape(location)}}`,
        coursework ? `  \\resumeEducationCoursework{${latexEscape(coursework)}}` : null,
        certs ? `  \\resumeEducationCertifications{${latexEscape(certs)}}` : null,
      ].filter(Boolean).join('\n')
    );

    i = j - 1;
  }
  return out.join('\n\n');
}

function parseSkills(lines) {
  // Skills are one big bullet with categories separated by "\" line breaks (markdown).
  // Normalize to a single line first so wrapped lines don't drop categories.
  const joined = lines
    .map(l => l.replace(/^\s+/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const chunks = joined
    .split('\\')
    .map(s => s.replace(/^-+\s+/, '').trim())
    .filter(Boolean);

  const rows = chunks.map((c, idx) => {
    const m = c.match(/^\*\*(.+?)\*\*:\s*(.+)$/);
    if (!m) return null;
    const [, cat, items] = m;
    const suffix = idx === chunks.length - 1 ? '' : ' \\\\';
    return `\\textbf{${latexEscape(cat)}}{: ${latexEscape(items)}}${suffix}`;
  }).filter(Boolean);

  return [
    '\\item{',
    ...rows.map(r => `  ${r}`),
    '}',
  ].join('\n');
}

function parseExperience(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const companyMatch = l.match(/\*\*(.+?)\*\*\s+(.*\d{4}.*)$/);
    if (!companyMatch) continue;
    const company = companyMatch[1].trim();
    const dateRange = companyMatch[2].trim();

    const next = (lines[i + 1] || '').trim();
    const roleMatch = next.match(/^\*(.+?)\*\s+\*(.+?)\*\s*$/);
    const title = roleMatch?.[1]?.trim() || '';
    const location = roleMatch?.[2]?.trim() || '';

    const { bullets, nextIdx } = collectBullets(lines, i + 2);
    const items = bulletsToItems(bullets);

    const itemBlock = items
      ? [
          '  \\resumeItemListStart',
          items.split('\n').map(x => `        ${x}`).join('\n'),
          '  \\resumeItemListEnd',
        ].join('\n')
      : null;

    out.push(
      [
        '\\resumeSubheading',
        `  {${latexEscape(company)}}{${latexEscape(dateRange)}}`,
        `  {${latexEscape(title)}}{${latexEscape(location)}}`,
        itemBlock,
      ].join('\n')
    );

    i = nextIdx - 1;
  }
  return out.join('\n\n');
}

function parseProjects(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.includes('**[') || !l.includes('](')) continue;

    // Try to extract: **[Name](url)** $|$ *Tags* [*[GitHub]*](url)
    const m = l.match(/\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s+\$\|\$\s+\*([^*]+)\*\s+\[\*\\?\[GitHub\\?\]\*\]\(([^)]+)\)/);
    if (!m) continue;
    const [, name, primaryUrl, tags, githubUrl] = m;

    const { bullets, nextIdx } = collectBullets(lines, i + 1);
    const items = bulletsToItems(bullets);

    const itemBlock = items
      ? [
          '  \\resumeItemListStart',
          items.split('\n').map(x => `        ${x}`).join('\n'),
          '  \\resumeItemListEnd',
        ].join('\n')
      : null;

    out.push(
      [
        '\\resumeProjectHeadingLinks',
        `  {${latexEscapeUrl(primaryUrl)}}`,
        `  {${latexEscape(name)}}`,
        `  {${latexEscape(tags.trim())}}`,
        `  {${latexEscapeUrl(githubUrl)}}`,
        itemBlock,
      ].join('\n')
    );

    i = nextIdx - 1;
  }
  return out.join('\n\n');
}

function parseResearch(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const m = l.match(/\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s+\*([^*]+)\*/);
    if (!m) continue;
    const [, title, url, venue] = m;
    const { bullets, nextIdx } = collectBullets(lines, i + 1);
    const items = bulletsToItems(bullets);

    const itemBlock = items
      ? [
          '  \\resumeItemListStart',
          items.split('\n').map(x => `            ${x}`).join('\n'),
          '  \\resumeItemListEnd',
        ].join('\n')
      : null;

    out.push(
      [
        '\\resumeResearchHeading',
        `  {${mdLinkToHref(`[${title}](${url})`)}}`,
        `  {${latexEscape(venue.trim())}}`,
        itemBlock,
      ].join('\n')
    );
    i = nextIdx - 1;
  }

  if (!out.length) return '';
  return [
    '%-----------RESEARCH-----------------',
    '\\section{Research}',
    '  \\resumeSubHeadingListStart',
    out.map(b => `    ${b.replaceAll('\n', '\n    ')}`).join('\n\n'),
    '  \\resumeSubHeadingListEnd',
  ].join('\n');
}

function parseExtracurricular(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const orgMatch = l.match(/\*\*(.+?)\*\*\s+(.*\d{4}.*)$/);
    if (!orgMatch) continue;
    const org = orgMatch[1].trim();
    const dateRange = orgMatch[2].trim();

    const next = (lines[i + 1] || '').trim();
    const roleMatch = next.match(/^\*(.+?)\*\s*$/);
    const title = roleMatch?.[1]?.trim() || '';

    const { bullets, nextIdx } = collectBullets(lines, i + 2);
    const items = bulletsToItems(bullets);

    const itemBlock = items
      ? [
          '  \\resumeItemListStart',
          items.split('\n').map(x => `        ${x}`).join('\n'),
          '  \\resumeItemListEnd',
        ].join('\n')
      : null;

    out.push(
      [
        '\\resumeSubheading',
        `  {${latexEscape(org)}}{${latexEscape(dateRange)}}`,
        `  {${latexEscape(title)}}{}`,
        itemBlock,
      ].join('\n')
    );

    i = nextIdx - 1;
  }

  if (!out.length) return '';
  return [
    '%-----------EXTRACURRICULAR-----------------',
    '\\section{Extracurricular}',
    '  \\resumeSubHeadingListStart',
    out.map(b => `    ${b.replaceAll('\n', '\n    ')}`).join('\n\n'),
    '  \\resumeSubHeadingListEnd',
  ].join('\n');
}

// --- Load inputs ---
const cvPath = join(ROOT, 'cv.md');
const cvRaw = await readFile(cvPath, 'utf-8');
const sections = splitSections(cvRaw);

const profilePath = join(ROOT, 'config', 'profile.yml');
const profileRaw = await readFile(profilePath, 'utf-8');
const profile = yaml.load(profileRaw);
const c = profile?.candidate || {};

// --- Build placeholders ---
const now = new Date();
const date = ymd(now);
const context = {
  source: 'MASTER',
  company: 'Master',
  role: 'Master Resume',
  url: 'local:master-resume',
};
const job_id = makeJobId(context);

const name = c.full_name || 'Your Name';
const email = c.email || 'you@example.com';
const linkedinUrl = c.linkedin || 'https://linkedin.com/in/username';
const phone = c.phone || '';
const location = c.location || '';

const phoneDisplay = latexEscape(phone);

const summaryLines = (sections.get('Summary') || []).filter(l => l.trim());
const summaryText = summaryLines
  .map(l => l.replace(/^-+\s+/, '').trim())
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();

const education = parseEducation(sections.get('Education') || []);
const skills = parseSkills(sections.get('Technical Skills') || []);
const experience = parseExperience(sections.get('Experience') || []);
const projects = parseProjects(sections.get('Projects') || []);
const researchSection = parseResearch(sections.get('Research') || []);
const extracurricularSection = parseExtracurricular(sections.get('Extracurricular') || []);

// Fill LaTeX template
const tplPath = join(ROOT, 'templates', 'cv-template.tex');
const tpl = await readFile(tplPath, 'utf-8');

const filled = tpl
  .replaceAll('{{NAME}}', latexEscape(name))
  .replaceAll('{{EMAIL_URL}}', email)
  .replaceAll('{{EMAIL_DISPLAY}}', latexEscape(email))
  .replaceAll('{{LINKEDIN_URL}}', latexEscapeUrl(linkedinUrl))
  .replaceAll('{{LINKEDIN_DISPLAY}}', latexEscape(stripScheme(linkedinUrl)))
  .replaceAll('{{PHONE_DISPLAY}}', phoneDisplay)
  .replaceAll('{{SUMMARY}}', latexEscape(summaryText))
  .replaceAll('{{EDUCATION}}', education)
  .replaceAll('{{SKILLS}}', skills)
  .replaceAll('{{EXPERIENCE}}', experience)
  .replaceAll('{{PROJECTS}}', projects)
  .replaceAll('{{RESEARCH_SECTION}}', researchSection)
  .replaceAll('{{EXTRACURRICULAR_SECTION}}', extracurricularSection);

const outDir = join(ROOT, 'output', 'jobhunt');
await mkdir(outDir, { recursive: true });
const texOut = join(outDir, `master-resume-${job_id}.tex`);
const pdfOut = join(outDir, `master-resume-${job_id}.pdf`);

await writeFile(texOut, filled, 'utf-8');

// Compile using existing validator/compiler
execFileSync('node', [join(ROOT, 'generate-latex.mjs'), texOut, pdfOut], {
  stdio: 'pipe',
  timeout: 180_000,
});

// Upload PDF into nested Drive folder: RESUME/Master/<Date_job_id>/
const { rootFolder } = await getRootFolder();
const sub = await ensureSubfolders(rootFolder.id);
const bucketIdByName = new Map((sub.folders || []).map(f => [f.name, f.id]));
const resumeBucketId = bucketIdByName.get('RESUME');
if (!resumeBucketId) throw new Error('Missing RESUME folder under JOBHUNT');

const companyFolderName = slugifyFolderName(context.company);
const roleFolderName = slugifyFolderName(`${date}_${job_id}`);
const { folderId: targetFolderId } = await ensureFolderPath(resumeBucketId, [companyFolderName, roleFolderName]);

const uploaded = await uploadFileFromPath({
  parentId: targetFolderId,
  filename: `master-resume-${job_id}.pdf`,
  mimeType: 'application/pdf',
  filePath: pdfOut,
});

await appendRow('ASSETS', [
  job_id,
  context.company,
  context.role,
  'MASTER_RESUME_READY',
  uploaded.webViewLink,
  '',
  '',
  '',
  '',
  now.toISOString(),
  'master resume from cv.md',
]);

console.log(JSON.stringify({
  ok: true,
  job_id,
  tex: texOut,
  pdf: pdfOut,
  drive: uploaded.webViewLink,
}, null, 2));

