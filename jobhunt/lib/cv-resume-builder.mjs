import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const __dirname = dirname(fileURLToPath(import.meta.url));
const CANONICAL_RESUME_JSON = join(__dirname, 'resume-canonical.json');

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

function loadCanonicalEducation() {
  const raw = readFileSync(CANONICAL_RESUME_JSON, 'utf-8');
  const doc = JSON.parse(raw);
  const ed = doc?.education;
  if (!Array.isArray(ed) || ed.length === 0) {
    throw new Error('resume-canonical.json must define a non-empty education[]');
  }
  for (const row of ed) {
    if (!row?.id || !row?.school || !row?.dateRange || row.degree == null || row.location == null) {
      throw new Error(`resume-canonical.json education entry invalid: ${JSON.stringify(row)}`);
    }
  }
  return ed;
}

function normalizeSchoolName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function matchSchoolToEducationId(school, canonicalEducation) {
  const want = normalizeSchoolName(school);
  for (const row of canonicalEducation) {
    if (normalizeSchoolName(row.school) === want) return row.id;
  }
  throw new Error(`cv.md Education: no resume-canonical education id for school "${school}"`);
}

/** Match canonical.json education[] order; filter to ids the caller included. */
function reorderEducationInclude(canonicalEducation, includeIds) {
  const wanted = new Set(includeIds || []);
  return canonicalEducation.map((x) => x.id).filter((id) => wanted.has(id));
}

/** Brace depth for `{` / `}`; `\` skips the next character (same rule as claude-asset-generators). */
function isBraceBalancedTex(s) {
  const str = String(s || '');
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
      continue;
    }
    if (str[i] === '{') depth++;
    else if (str[i] === '}') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function stripTrailingColon(s) {
  return String(s || '').replace(/\s*:\s*$/u, '').trim();
}

function normalizeEducationBodyInput(s) {
  return stripTrailingColon(String(s || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim());
}

function ampersandSweep(s) {
  return String(s || '').replace(/(?<!\\)\s*&\s*/g, ' and ');
}

/**
 * Deterministic Education LaTeX: one \\resumeSubheading per id, then optional
 * \\resumeEducationCoursework{label}{body} and \\resumeEducationCertifications{label}{body}
 * immediately under that school only.
 *
 * @param {Array<{ id: string, school: string, dateRange: string, degree: string, location: string }>} canonicalEducation
 * @param {{ include: string[], coursework?: Record<string, string | string[]>, certifications?: Record<string, string | string[]>, courseworkLabel?: string, certificationsLabel?: string }} opts
 */
export function buildEducationLatex(canonicalEducation, opts) {
  const include = opts?.include || [];
  const coursework = opts?.coursework || {};
  const certifications = opts?.certifications || {};
  const courseworkLabel = opts?.courseworkLabel || 'Relevant Coursework';
  const certificationsLabel = opts?.certificationsLabel || 'Certifications';

  if (!include.length) return '';

  const byId = new Map(canonicalEducation.map((e) => [e.id, e]));
  const chunks = [];

  for (const id of include) {
    const row = byId.get(id);
    if (!row) throw new Error(`buildEducationLatex: unknown education id "${id}"`);

    chunks.push(
      `    \\resumeSubheading
      {${latexEscape(row.school)}}{${latexEscape(row.dateRange)}}
      {${latexEscape(row.degree)}}{${latexEscape(row.location)}}`
    );

    const cwRaw = coursework[id];
    if (cwRaw != null && cwRaw !== '') {
      const joined = Array.isArray(cwRaw)
        ? cwRaw.map((x) => String(x || '').trim()).filter(Boolean).join(', ')
        : String(cwRaw);
      const cwFinal = ampersandSweep(normalizeEducationBodyInput(joined));
      if (cwFinal) {
        const line = `  \\resumeEducationCoursework{${latexEscape(courseworkLabel)}}{${latexEscape(cwFinal)}}`;
        if (!isBraceBalancedTex(line)) {
          throw new Error('Internal: unbalanced braces in resumeEducationCoursework line');
        }
        chunks.push(line);
      }
    }

    const certRaw = certifications[id];
    if (certRaw != null && certRaw !== '') {
      const joined = Array.isArray(certRaw)
        ? certRaw.map((x) => String(x || '').trim()).filter(Boolean).join(', ')
        : String(certRaw);
      const certFinal = ampersandSweep(normalizeEducationBodyInput(joined));
      if (certFinal) {
        const line = `  \\resumeEducationCertifications{${latexEscape(certificationsLabel)}}{${latexEscape(certFinal)}}`;
        if (!isBraceBalancedTex(line)) {
          throw new Error('Internal: unbalanced braces in resumeEducationCertifications line');
        }
        chunks.push(line);
      }
    }
  }

  // IMPORTANT: Avoid blank lines between commands; in LaTeX, a blank line is a paragraph break
  // which introduces vertical whitespace in the rendered PDF.
  return chunks.join('\n');
}

/**
 * Parse cv.md Education bullets into school blocks (same regex rules as before).
 * @returns {Array<{ school: string, dateRange: string, degree: string, location: string, courseworkLine?: string, certificationsLine?: string }>}
 */
function collectEducationBlocksFromCv(lines) {
  const blocks = [];
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

    const courseworkLine = bullets.find((b) => /^relevant coursework\b/i.test(b.trim()));
    const certificationsLine = bullets.find((b) => /^certifications\b/i.test(b.trim()));

    blocks.push({
      school,
      dateRange,
      degree,
      location,
      courseworkLine,
      certificationsLine,
    });
    i = j - 1;
  }
  return blocks;
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
  const blocks = collectEducationBlocksFromCv(sections.get('Education') || []);
  if (!blocks.length) return '';
  const canonicalEducation = loadCanonicalEducation();
  const coursework = {};
  const certifications = {};
  const includeFromCv = [];
  for (const b of blocks) {
    const id = matchSchoolToEducationId(b.school, canonicalEducation);
    includeFromCv.push(id);
    if (b.courseworkLine) {
      const p = splitEducationLabelBody(b.courseworkLine, 'Relevant Coursework');
      if (p?.body) coursework[id] = p.body;
    }
    if (b.certificationsLine) {
      const p = splitEducationLabelBody(b.certificationsLine, 'Certifications');
      if (p?.body) certifications[id] = p.body;
    }
  }
  const include = reorderEducationInclude(canonicalEducation, includeFromCv);
  return buildEducationLatex(canonicalEducation, { include, coursework, certifications });
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

  const education = buildEducationFromCv(sections);
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

