import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const ROOT = process.cwd();

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

function latexEscapeUrl(url) {
  return String(url || '').replace(/%/g, '\\%').replace(/#/g, '\\#');
}

function stripScheme(u) {
  return String(u || '').replace(/^https?:\/\//, '');
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
    if (/^-{5,}/.test(l)) {
      if (!current) continue;
      break;
    }
    const b = l.match(/^-+\s+(.*)$/);
    if (b) {
      if (current) bullets.push(current.trim());
      current = b[1].trim();
      continue;
    }
    if (current && (/^\s{2,}\S/.test(raw) || /^[a-zA-Z0-9(]/.test(l))) {
      current += ' ' + l;
    }
  }
  if (current) bullets.push(current.trim());
  return { bullets, nextIdx: i };
}

function bulletsToItems(bullets) {
  return bullets
    .filter(Boolean)
    .map((b) => `\\item {${latexEscape(b)}}`)
    .join('\n');
}

/**
 * Coursework / certs lines from cv.md may use "Label: body", "Label body" (no colon), or body only.
 * When label is missing or there is no ":", use defaultLabel (e.g. Relevant Coursework / Certifications).
 */
function splitEducationLabelBody(line, defaultLabel) {
  const s = String(line || '').trim();
  if (!s) return null;
  const colon = s.match(/^([^:]+):\s*(.*)$/s);
  if (colon) {
    const label = colon[1].trim();
    const body = colon[2].trim();
    if (!body) return null;
    return { label, body };
  }
  const esc = defaultLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}\\s*`, 'i');
  const m = re.exec(s);
  if (m) {
    const body = s.slice(m[0].length).trim();
    if (!body) return null;
    return { label: defaultLabel, body };
  }
  return { label: defaultLabel, body: s };
}

function parseEducation(lines) {
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

    const bullets = [];
    let current = null;
    let j = i + 2;
    for (; j < lines.length; j++) {
      const raw = lines[j];
      const t = raw.trim();
      if (!t) continue;
      if (t.startsWith('#')) break;
      if (t.match(/\*\*(.+?)\*\*\s+.*\d{4}/)) break;
      if (t.startsWith('<!--')) continue;
      const b = t.match(/^-+\s+(.*)$/);
      if (b) {
        if (current) bullets.push(current.trim());
        current = b[1].trim();
        continue;
      }
      if (current && (/^\s{2,}\S/.test(raw) || /^[a-zA-Z0-9(]/.test(t))) {
        current += ' ' + t;
      }
    }
    if (current) bullets.push(current.trim());

    const coursework = bullets.find((b) => /^relevant coursework\b/i.test(b.trim()));
    const certs = bullets.find((b) => /^certifications\b/i.test(b.trim()));

    out.push(
      [
        '\\resumeSubheading',
        `  {${latexEscape(school)}}{${latexEscape(dateRange)}}`,
        `  {${latexEscape(degree)}}{${latexEscape(location)}}`,
        coursework
          ? (() => {
              const p = splitEducationLabelBody(coursework, 'Relevant Coursework');
              if (!p?.body) return null;
              return `  \\resumeEducationCoursework{${latexEscape(p.label)}}{${latexEscape(p.body)}}`;
            })()
          : null,
        certs
          ? (() => {
              const p = splitEducationLabelBody(certs, 'Certifications');
              if (!p?.body) return null;
              return `  \\resumeEducationCertifications{${latexEscape(p.label)}}{${latexEscape(p.body)}}`;
            })()
          : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
    i = j - 1;
  }
  return out.join('\n\n');
}

function parseSkills(lines) {
  const joined = lines
    .map((l) => l.replace(/^\s+/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chunks = joined
    .split('\\')
    .map((s) => s.replace(/^-+\s+/, '').trim())
    .filter(Boolean);
  const rows = chunks
    .map((c, idx) => {
      const m = c.match(/^\*\*(.+?)\*\*:\s*(.+)$/);
      if (!m) return null;
      const [, cat, items] = m;
      const suffix = idx === chunks.length - 1 ? '' : ' \\\\';
      return `\\textbf{${latexEscape(cat)}}{: ${latexEscape(items)}}${suffix}`;
    })
    .filter(Boolean);
  return ['\\item{', ...rows.map((r) => `  ${r}`), '}'].join('\n');
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
          items
            .split('\n')
            .map((x) => `        ${x}`)
            .join('\n'),
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
    const m = l.match(
      /\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s+\$\|\$\s+\*([^*]+)\*\s+\[\*\\?\[GitHub\\?\]\*\]\(([^)]+)\)/
    );
    if (!m) continue;
    const [, name, primaryUrl, tags, githubUrl] = m;
    const { bullets, nextIdx } = collectBullets(lines, i + 1);
    const items = bulletsToItems(bullets);
    const itemBlock = items
      ? [
          '  \\resumeItemListStart',
          items
            .split('\n')
            .map((x) => `        ${x}`)
            .join('\n'),
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

function enforceNoHyphenation(tex) {
  if (tex.includes('\\usepackage[none]{hyphenat}')) return tex;
  const anchor = '\\usepackage{microtype}';
  const inject =
    `${anchor}\n` +
    `\\usepackage[none]{hyphenat}\n` +
    `\\hyphenpenalty=10000\n\\exhyphenpenalty=10000\n\\sloppy\n\\emergencystretch=3em`;
  if (tex.includes(anchor)) return tex.replace(anchor, inject);
  return tex;
}

function ensureProjectHeadingMacrosWrap(tex) {
  if (tex.includes('% career-ops:project-macro-wrap')) return tex;
  const inject = [
    '',
    '% career-ops:project-macro-wrap',
    '\\renewcommand{\\resumeProjectHeading}[2]{',
    '  \\vspace{0pt}\\item',
    '    \\begin{tabular*}{\\textwidth}{l@{\\extracolsep{\\fill}}r}',
    '      \\textbf{#1}{ $|$ \\parbox[t]{0.82\\textwidth}{\\textit{#2}}} & \\\\',
    '    \\end{tabular*}\\vspace{-6pt}',
    '}',
    '',
    '\\renewcommand{\\resumeProjectHeadingLinks}[4]{',
    '  \\vspace{0pt}\\item',
    '    \\begin{tabular*}{\\textwidth}{l@{\\extracolsep{\\fill}}r}',
    '      \\textbf{\\href{#1}{#2}}{ $|$ \\parbox[t]{0.78\\textwidth}{\\textit{#3}}} & \\href{#4}{\\textit{[GitHub]}} \\\\',
    '    \\end{tabular*}\\vspace{-6pt}',
    '}',
    '',
  ].join('\n');
  const marker = '\\begin{document}';
  if (!tex.includes(marker)) return tex;
  return tex.replace(marker, `${inject}\n${marker}`);
}

export function loadCvSections() {
  const cvRaw = readFileSync(join(ROOT, 'cv.md'), 'utf-8');
  return splitSections(cvRaw);
}

export function buildEducationFromCv(sections) {
  return parseEducation(sections.get('Education') || []);
}

export function buildSkillsFromCv(sections) {
  return parseSkills(sections.get('Technical Skills') || []);
}

export function buildExperienceFromCv(sections) {
  return parseExperience(sections.get('Experience') || []);
}

export function buildProjectsFromCv(sections) {
  return parseProjects(sections.get('Projects') || []);
}

export function renderResumeTemplate({
  summary,
  education,
  skills,
  experience,
  projects,
  researchSection = '',
  extracurricularSection = '',
}) {
  const profileRaw = readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8');
  const profile = yaml.load(profileRaw);
  const c = profile?.candidate || {};

  const tpl = readFileSync(join(ROOT, 'templates', 'cv-template.tex'), 'utf-8');

  let filled = tpl
    .replaceAll('{{NAME}}', latexEscape(c.full_name || 'Your Name'))
    .replaceAll('{{EMAIL_URL}}', String(c.email || 'you@example.com'))
    .replaceAll('{{EMAIL_DISPLAY}}', latexEscape(c.email || 'you@example.com'))
    .replaceAll('{{LINKEDIN_URL}}', latexEscapeUrl(c.linkedin || 'https://linkedin.com/in/username'))
    .replaceAll('{{LINKEDIN_DISPLAY}}', latexEscape(stripScheme(c.linkedin || 'https://linkedin.com/in/username')))
    .replaceAll('{{PHONE_DISPLAY}}', latexEscape(c.phone || ''))
    .replaceAll('{{SUMMARY}}', latexEscape(summary || ''))
    .replaceAll('{{EDUCATION}}', education || '')
    .replaceAll('{{SKILLS}}', skills || '')
    .replaceAll('{{EXPERIENCE}}', experience || '')
    .replaceAll('{{PROJECTS}}', projects || '')
    .replaceAll('{{RESEARCH_SECTION}}', researchSection || '')
    .replaceAll('{{EXTRACURRICULAR_SECTION}}', extracurricularSection || '');

  filled = enforceNoHyphenation(filled);
  filled = ensureProjectHeadingMacrosWrap(filled);
  return filled;
}

export function buildResumeTexFromCv({ summaryOverride } = {}) {
  const cvRaw = readFileSync(join(ROOT, 'cv.md'), 'utf-8');
  const sections = splitSections(cvRaw);

  const profileRaw = readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8');
  const profile = yaml.load(profileRaw);
  const c = profile?.candidate || {};

  const tpl = readFileSync(join(ROOT, 'templates', 'cv-template.tex'), 'utf-8');

  const summaryLines = (sections.get('Summary') || []).filter((l) => l.trim());
  const summaryText = summaryOverride
    ? String(summaryOverride).replace(/\s+/g, ' ').trim()
    : summaryLines
        .map((l) => l.replace(/^-+\s+/, '').trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

  const education = parseEducation(sections.get('Education') || []);
  const skills = parseSkills(sections.get('Technical Skills') || []);
  const experience = parseExperience(sections.get('Experience') || []);
  const projects = parseProjects(sections.get('Projects') || []);

  let filled = tpl
    .replaceAll('{{NAME}}', latexEscape(c.full_name || 'Your Name'))
    .replaceAll('{{EMAIL_URL}}', String(c.email || 'you@example.com'))
    .replaceAll('{{EMAIL_DISPLAY}}', latexEscape(c.email || 'you@example.com'))
    .replaceAll('{{LINKEDIN_URL}}', latexEscapeUrl(c.linkedin || 'https://linkedin.com/in/username'))
    .replaceAll('{{LINKEDIN_DISPLAY}}', latexEscape(stripScheme(c.linkedin || 'https://linkedin.com/in/username')))
    .replaceAll('{{PHONE_DISPLAY}}', latexEscape(c.phone || ''))
    .replaceAll('{{SUMMARY}}', latexEscape(summaryText))
    .replaceAll('{{EDUCATION}}', education)
    .replaceAll('{{SKILLS}}', skills)
    .replaceAll('{{EXPERIENCE}}', experience)
    .replaceAll('{{PROJECTS}}', projects)
    .replaceAll('{{RESEARCH_SECTION}}', '')
    .replaceAll('{{EXTRACURRICULAR_SECTION}}', '');

  filled = enforceNoHyphenation(filled);
  filled = ensureProjectHeadingMacrosWrap(filled);
  return filled;
}

