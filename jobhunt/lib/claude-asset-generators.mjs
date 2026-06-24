import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { resolveAnthropicModel } from '../../integrations/anthropic/config.mjs';
import { extractJsonObject } from './claude-json.mjs';
import { buildEducationFromCv, buildEducationLatex, loadCvSections } from './cv-resume-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Target length for sheet resume summary in the model prompt only; not enforced in code. */
const SUMMARY_CHAR_GUIDE = 350;

/**
 * Parse the `candidate` block out of a raw `profile.yml` string and return the
 * fields used by the deterministic email signature. Robust to malformed YAML
 * (returns an empty object) so a missing field never breaks Stage 2.
 */
export function parseCandidateFromProfileYaml(yamlText) {
  if (!yamlText) return {};
  try {
    const doc = yaml.load(yamlText);
    const cand = (doc && typeof doc === 'object' && doc.candidate) || {};
    return {
      full_name: typeof cand.full_name === 'string' ? cand.full_name.trim() : '',
      phone: typeof cand.phone === 'string' ? cand.phone.trim() : '',
      linkedin: typeof cand.linkedin === 'string' ? cand.linkedin.trim() : '',
      email: typeof cand.email === 'string' ? cand.email.trim() : '',
    };
  } catch {
    return {};
  }
}

/**
 * Build the canonical closing block that every Stage 2 / Stage 3 email ends
 * with. Order is fixed: full name, phone, LinkedIn URL, email. Missing fields
 * are skipped silently.
 */
export function buildEmailSignatureBlock(candidate) {
  const lines = ['Best regards,', ''];
  if (candidate?.full_name) lines.push(candidate.full_name);
  if (candidate?.phone) lines.push(candidate.phone);
  if (candidate?.linkedin) lines.push(candidate.linkedin);
  if (candidate?.email) lines.push(candidate.email);
  return lines.join('\n');
}

const CLOSING_KEYWORDS_RE =
  /\n+[ \t]*(?:Best regards|Best wishes|Kind regards|Warmest regards|Warm regards|Sincerely yours|Yours sincerely|Yours truly|Sincerely|Regards|Best|Cheers)\b[\s\S]*$/i;

/**
 * Strip whatever closing/signature block Claude produced (from the first
 * "Best regards"/"Sincerely"/etc. through end of body) and append a
 * deterministic signature built from `profile.yml`. Idempotent.
 */
export function applyDeterministicEmailSignature(body, candidate) {
  const stripped = String(body || '').replace(CLOSING_KEYWORDS_RE, '').trimEnd();
  const sig = buildEmailSignatureBlock(candidate || {});
  return `${stripped}\n\n${sig}\n`;
}

function loadCanonical() {
  return JSON.parse(readFileSync(join(__dirname, 'resume-canonical.json'), 'utf-8'));
}

function textBlocks(msg) {
  return (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** & → and, % and $ (currency) escapes, then a single ~ → $\\sim$ (no extra passes). */
export function sanitizeItemBulletText(s) {
  let out = String(s || '');
  out = out.replace(/(?<!\\)\s*&\s*/g, ' and ');
  out = out.replace(/(?<!\\)%/g, '\\%');
  out = out.replace(/(?<!\\)\$(?=\d)/g, '\\$');
  out = out.replace(/~/g, '$\\sim$');
  return out;
}

/**
 * Like sanitizeItemBulletText(), plus escape unescaped # for LaTeX.
 * IMPORTANT: Only use this for Claude-generated bullet/fragment text (skills + bullets),
 * not for the full template or canonical/static LaTeX.
 */
function sanitizeClaudeBulletText(s) {
  let out = sanitizeItemBulletText(s);
  out = out.replace(/(?<!\\)#/g, '\\#');
  return out;
}

function sanitizeTagLineThirdArg(s) {
  return String(s || '')
    .replace(/(?<!\\)\s*&\s*/g, ' and ')
    .trim();
}

/** Fix experience / extracurricular order to match resume-canonical.json (reverse-chronological). */
function reorderToCanonical(canonicalList, includeIds) {
  const wanted = new Set(includeIds || []);
  return canonicalList.map((x) => x.id).filter((id) => wanted.has(id));
}

function modelOrderDiffers(modelOrder, canonicalOrder) {
  if (!Array.isArray(modelOrder) || !Array.isArray(canonicalOrder)) return true;
  if (modelOrder.length !== canonicalOrder.length) return true;
  return modelOrder.some((id, idx) => id !== canonicalOrder[idx]);
}

/**
 * Strip common model wrappers so plain text survives normalization.
 * (Otherwise ``` fences / JSON can yield "empty" summaries in the PDF.)
 */
function stripSummaryModelNoise(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:plaintext|text|json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    try {
      const o = JSON.parse(s);
      if (typeof o.summary === 'string') s = o.summary.trim();
      else if (typeof o.text === 'string') s = o.text.trim();
    } catch {
      /* keep s */
    }
  }
  s = s.replace(/^\s*summary\s*:\s*/i, '').trim();
  return s;
}

function forbidExtraListWrappers(block, label) {
  const s = String(block || '');
  if (/\b\\resumeSubHeadingListStart\b/.test(s)) {
    throw new Error(`${label} must not contain \\\\resumeSubHeadingListStart (template already wraps this section)`);
  }
  if (/\b\\resumeSubHeadingListEnd\b/.test(s)) {
    throw new Error(`${label} must not contain \\\\resumeSubHeadingListEnd`);
  }
  for (const bad of ['\\documentclass', '\\usepackage', '\\begin{document}', '\\end{document}', '\\section{']) {
    if (s.includes(bad)) throw new Error(`${label} must not contain ${bad}`);
  }
}

function itemsTex(bullets, indent) {
  return (bullets || [])
    .map((b) => String(b || '').trim())
    .filter(Boolean)
    .map((b) => `${indent}\\item {${sanitizeClaudeBulletText(b)}}`)
    .join('\n');
}

function validateIdList(arr, label, allowed) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`${label} must be a non-empty array of canonical ids`);
  }
  const set = new Set(allowed);
  for (const id of arr) {
    if (!set.has(id)) throw new Error(`Unknown id "${id}" in ${label}`);
  }
}

/**
 * Keys in education_coursework / education_certifications must be subset of education_include.
 * Values must be non-empty string or non-empty string[] (after trim).
 */
function validateEducationSupplementalMaps(coursework, certifications, allowedIncludeIds) {
  const allowed = new Set(allowedIncludeIds);
  for (const [label, obj] of [
    ['education_coursework', coursework],
    ['education_certifications', certifications],
  ]) {
    if (obj == null) continue;
    if (typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error(`${label} must be a plain object mapping school id to string or string[]`);
    }
    for (const id of Object.keys(obj)) {
      if (!allowed.has(id)) {
        throw new Error(`${label}: key "${id}" must be listed in education_include`);
      }
      const v = obj[id];
      if (Array.isArray(v)) {
        const parts = v.map((x) => String(x || '').trim()).filter(Boolean);
        if (!parts.length) {
          throw new Error(`${label}: value for "${id}" must be a non-empty array of strings`);
        }
      } else if (typeof v === 'string') {
        if (!v.trim()) throw new Error(`${label}: value for "${id}" must be a non-empty string`);
      } else {
        throw new Error(`${label}: value for "${id}" must be string or string[]`);
      }
    }
  }
}

function bulletsFor(canonicalList, selection, bulletsMap, label) {
  const out = [];
  for (const id of selection) {
    const row = canonicalList.find((x) => x.id === id);
    const raw = bulletsMap && bulletsMap[id];
    if (!Array.isArray(raw) || !raw.length) {
      throw new Error(`${label}: bullets for "${id}" must be a non-empty array of strings`);
    }
    out.push({ row, bullets: raw });
  }
  return out;
}

function buildExperience(canonical, selection, bulletsMap) {
  const rows = bulletsFor(canonical.experience, selection, bulletsMap, 'experience_bullets');
  return rows
    .map(
      ({ row, bullets }) => `    \\resumeSubheading
      ${row.line1}
      ${row.line2}
      \\resumeItemListStart
${itemsTex(bullets, '        ')}
      \\resumeItemListEnd`
    )
    .join('\n\n');
}

function buildProjects(canonical, selection, bulletsMap, tagOverrides) {
  const rows = bulletsFor(canonical.projects, selection, bulletsMap, 'project_bullets');
  return rows
    .map(({ row, bullets }) => {
      const tags = tagOverrides && tagOverrides[row.id] != null
        ? sanitizeTagLineThirdArg(tagOverrides[row.id])
        : row.defaultTags;
      return `    \\resumeProjectHeadingLinks
      {${row.primaryUrl}}
      {${row.title}}
      {${tags}}
      {${row.githubUrl}}
      \\resumeItemListStart
${itemsTex(bullets, '        ')}
      \\resumeItemListEnd`;
    })
    // Avoid blank lines between projects; blank line = paragraph break in LaTeX.
    .join('\n');
}

function buildResearch(canonical, selection, bulletsMap) {
  const rows = bulletsFor(canonical.research, selection, bulletsMap, 'research_bullets');
  return rows
    .map(({ row, bullets }) => {
      const hrefArg = `{\\href{${row.paperUrl}}{${row.paperTitle}}}`;
      return `    \\resumeResearchHeading
    ${hrefArg}
{${row.venue}}
        \\resumeItemListStart
${itemsTex(bullets, '            ')}
        \\resumeItemListEnd`;
    })
    .join('\n\n');
}

function buildExtracurricular(canonical, selection, bulletsMap) {
  if (!selection || selection.length === 0) return '';
  const rows = bulletsFor(canonical.extracurricular, selection, bulletsMap, 'extracurricular_bullets');
  const blocks = rows
    .map(
      ({ row, bullets }) => `    \\resumeSubheading
    ${row.line1}
    ${row.line2}
    \\resumeItemListStart
${itemsTex(bullets, '        ')}
    \\resumeItemListEnd`
    )
    .join('\n\n');
  return `\\section{Extracurricular}
  
  \\resumeSubHeadingListStart

${blocks}

  \\resumeSubHeadingListEnd`;
}

function buildResearchSectionInner(canonical, selection, bulletsMap) {
  if (!selection || selection.length === 0) return '';
  const inner = buildResearch(canonical, selection, bulletsMap);
  return `\\section{Research}
  \\resumeSubHeadingListStart
${inner}
  \\resumeSubHeadingListEnd`;
}

/**
 * Validates resume body JSON and returns template placeholders (Education, Skills, Experience, Projects; Research and Extracurricular optional).
 * @param {ReturnType<loadCanonical>} canonical
 * @param {Record<string, unknown>} parsed
 */
function buildTemplateSectionsFromResumeBody(canonical, parsed) {
  const skillsRaw = String(parsed.skills || '');

  forbidExtraListWrappers(skillsRaw, 'skills');

  const allowedEdu = Array.isArray(canonical.education)
    ? canonical.education.map((e) => e.id)
    : [];
  if (!allowedEdu.length) {
    throw new Error('resume-canonical.json must define a non-empty education[]');
  }

  let education;
  const eduInc = parsed.education_include;
  if (Array.isArray(eduInc) && eduInc.length > 0) {
    validateIdList(eduInc, 'education_include', allowedEdu);
    const orderedEdu = reorderToCanonical(canonical.education, eduInc);
    if (modelOrderDiffers(eduInc, orderedEdu)) {
      parsed.__education_order_normalized = true;
    }

    const cwMap =
      parsed.education_coursework != null && typeof parsed.education_coursework === 'object'
        ? parsed.education_coursework
        : {};
    const certMap =
      parsed.education_certifications != null && typeof parsed.education_certifications === 'object'
        ? parsed.education_certifications
        : {};

    validateEducationSupplementalMaps(cwMap, certMap, orderedEdu);

    education = buildEducationLatex(canonical.education, {
      include: orderedEdu,
      coursework: cwMap,
      certifications: certMap,
    });
  } else {
    education = buildEducationFromCv(loadCvSections());
    parsed.__education_fallback_reason = 'education_legacy_or_missing';
  }

  let skillsTrim = skillsRaw.trim();
  if (!/\\item\s*\{/.test(skillsTrim)) {
    // Safe fallback: wrap only if the body looks like a real skills block.
    // (If the model returned garbage/plain prose, fail loudly.)
    const looksLikeSkillsBody = /\\textbf\{[^}]+\}\s*\{\s*:\s*[^}]+\}/.test(skillsTrim);
    if (!looksLikeSkillsBody) {
      throw new Error('skills must be one \\item{ ... } block (see cv-complete Technical Skills)');
    }
    skillsTrim = `\\item{\n${skillsTrim}\n}`;
    parsed.__skills_auto_wrapped = true;
  }
  const skills = sanitizeClaudeBulletText(skillsTrim.replace(/(?<!\\)\s*&\s*/g, ' and '));

  const allowedExp = canonical.experience.map((e) => e.id);
  const allowedProj = canonical.projects.map((p) => p.id);
  const allowedRes = canonical.research.map((r) => r.id);
  const allowedExtra = canonical.extracurricular.map((e) => e.id);

  validateIdList(parsed.experience_include, 'experience_include', allowedExp);
  validateIdList(parsed.projects_include, 'projects_include', allowedProj);
  const resInc = Array.isArray(parsed.research_include) ? parsed.research_include : [];
  if (resInc.length > 0) {
    validateIdList(resInc, 'research_include', allowedRes);
  }
  const extraInc = Array.isArray(parsed.extracurricular_include) ? parsed.extracurricular_include : [];
  for (const id of extraInc) {
    if (!allowedExtra.includes(id)) throw new Error(`Unknown extracurricular id "${id}"`);
  }

  const orderedExp = reorderToCanonical(canonical.experience, parsed.experience_include);
  if (modelOrderDiffers(parsed.experience_include, orderedExp)) {
    parsed.__experience_order_normalized = true;
  }

  const orderedExtra = reorderToCanonical(canonical.extracurricular, extraInc);
  if (modelOrderDiffers(extraInc, orderedExtra)) {
    parsed.__extracurricular_order_normalized = true;
  }

  const experience = buildExperience(canonical, orderedExp, parsed.experience_bullets);
  const projects = buildProjects(
    canonical,
    parsed.projects_include,
    parsed.project_bullets,
    parsed.project_tags || {}
  );
  const researchSection = buildResearchSectionInner(
    canonical,
    resInc,
    parsed.research_bullets || {}
  );
  const extracurricularSection = buildExtracurricular(
    canonical,
    orderedExtra,
    parsed.extracurricular_bullets || {}
  );

  return {
    EDUCATION: education,
    SKILLS: skills,
    EXPERIENCE: experience,
    PROJECTS: projects,
    RESEARCH_SECTION: researchSection,
    EXTRACURRICULAR_SECTION: extracurricularSection,
  };
}

/**
 * Plain-text resume summary for the ASSETS sheet only (not embedded in LaTeX).
 * Single model call; the prompt asks for ≤ SUMMARY_CHAR_GUIDE characters but code does not truncate or retry.
 *
 * @param {import('@anthropic-ai/sdk').Anthropic} client
 * @param {{ jdText: string, resumeJson: string }} args
 * @returns {Promise<{ text: string, model: string }>}
 */
export async function generateResumeSummaryForSheet(client, { jdText, resumeJson }) {
  const model = resolveAnthropicModel('resume_summary');
  const summarySystem = `You write exactly one short professional resume summary as plain text for a spreadsheet cell (not LaTeX, not JSON, no markdown fences).
Hard rules:
- Your reply must be only the summary: first visible character starts the summary (no preamble like "Here is" or "Summary:").
- Keep the summary at most ${SUMMARY_CHAR_GUIDE} characters (count a space as one character). Aim shorter if needed; this limit is your responsibility and it is a hard limit—the pipeline will not trim or re-ask you.
- Highlight impact from work experience, projects, and research only; align with the resume body JSON you are given.
- Do NOT mention degrees, university names, GPA, graduation dates, or coursework.
- Do not use the "&" character; use "and".
- Make sure the summary is at most ${SUMMARY_CHAR_GUIDE} characters (count a space as one character).`;

  const userContent = `--- Job description ---
${jdText}

--- Resume (JSON from Claude; summary must match this only) ---
${resumeJson}

Write the summary now (plain text, one paragraph):`;

  const msg = await client.messages.create({
    model,
    max_tokens: 512,
    system: summarySystem,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = stripSummaryModelNoise(textBlocks(msg)).trim();

  return { text, model };
}

function renderTemplate(tpl, map) {
  let out = tpl;
  for (const [k, v] of Object.entries(map)) {
    out = out.replaceAll(`{{${k}}}`, v ?? '');
  }
  return out;
}

/**
 * Resume LaTeX body only (Education, Skills, Experience, Projects; Research and Extracurricular optional). No summary in the PDF.
 *
 * @param {import('@anthropic-ai/sdk').Anthropic} client
 * @returns {Promise<
 *   | { ok: true, tex: string, model: string, resumeJson: string, resume_warnings: string[] }
 *   | {
 *       ok: false;
 *       model: string;
 *       error: string;
 *       debug: { rawClaudeText: string; parsedJson?: string; stage?: string };
 *     }
 * >}
 */
export async function generateResumeTex(client, { company, role, jdText, context }) {
  const model = resolveAnthropicModel('resume');
  const canonical = loadCanonical();
  const allowedExp = canonical.experience.map((e) => e.id);
  const allowedProj = canonical.projects.map((p) => p.id);
  const allowedRes = canonical.research.map((r) => r.id);
  const allowedExtra = canonical.extracurricular.map((e) => e.id);
  const allowedEdu = Array.isArray(canonical.education)
    ? canonical.education.map((e) => e.id)
    : [];

  const systemBody = `You tailor resume CONTENT for a specific job. Reply with STRICT JSON only (no markdown).

Always include these sections in the JSON (required for the PDF template):
- education_include, skills, experience_include + experience_bullets, projects_include + project_bullets
Optional (omit when they do not strengthen this application):
- education_coursework — plain object mapping school id (from education_include) to either an array of course title strings (preferred) or one comma-separated string. Only include ids where you want a Relevant Coursework line; omit the key entirely otherwise. Each value must be non-empty. The pipeline renders each as \\resumeEducationCoursework{Relevant Coursework}{body} immediately under that school's subheading (you never emit LaTeX for education).
- education_certifications — same shape as education_coursework; rendered as \\resumeEducationCertifications{Certifications}{body} under that school only.
- research_include + research_bullets — use research_include: [] and {} bullets to omit Research entirely.
- extracurricular_include + extracurricular_bullets — to omit Extracurricular entirely, set extracurricular_include: [] and extracurricular_bullets: {}. If you include any extracurricular id, bullets are mandatory (see below).

Keys:
- education_include: non-empty array of school ids — subset of ${JSON.stringify(allowedEdu)}. Display order is fixed to the canonical resume order; the pipeline reorders your array to match. Include every school you want on the resume. For this candidate, include BOTH schools unless space is extremely critical.
- skills: one complete LaTeX \\item{ ... } block as in cv-complete.tex (the template's Technical Skills section has a single list entry). Inside: multiple \\\\textbf{Category}{: skills} lines separated by \\\\.
  Structure-only examples (do NOT copy content; customize categories/skills to THIS JD):
  - Valid (structure only):
    \\item{
      \\textbf{CategoryA}{: Skill1, Skill2} \\\\
      \\textbf{CategoryB}{: Skill3, Skill4}
    }
  - Invalid examples:
    - Plain text like: \"Languages: Python, SQL\" (missing \\item{...})
    - Multiple items like: \"\\item{...}\\n\\item{...}\" (must be exactly one)
    - Any list wrappers like \\resumeSubHeadingListStart/End (template already wraps)
- experience_include: array of ids — subset of ${JSON.stringify(allowedExp)} (at least one). Display order is fixed by the canonical resume (reverse-chronological); the pipeline reorders your array to match. Choose which roles to include, not their order.
- experience_bullets: object; for each id in experience_include, an array of non-empty strings (bullet bodies only, no \\item, no LaTeX section commands).
- projects_include: subset of ${JSON.stringify(allowedProj)} (at least one), order preserved from this list when possible.
- project_bullets: object mapping each included project id to string array (bullet bodies only).
- project_tags: optional object; for any included project id, you may override ONLY the comma-separated tag line (third argument of \\resumeProjectHeadingLinks). If you omit an id, the default tags from the canonical resume are used. Never change project titles or URLs.
- research_include: array of ids from ${JSON.stringify(allowedRes)}; may be [] to omit the Research section entirely if it does not strengthen the resume for this role.
- research_bullets: object mapping each id in research_include to a non-empty string array (bullet bodies only). Omit or use {} when research_include is []. Never paraphrase paper titles; titles are fixed in the template data.
- extracurricular_include: array of ids subset of ${JSON.stringify(allowedExtra)}. To omit Extracurricular, set exactly: extracurricular_include: [] and extracurricular_bullets: {}.
- extracurricular_bullets: object mapping each id in extracurricular_include to a non-empty string array (bullet bodies only).
  Critical invariant:
  - If extracurricular_include is non-empty, you MUST include extracurricular_bullets.
  - extracurricular_bullets MUST contain EVERY id listed in extracurricular_include (no missing keys).
  - Each value must be a non-empty array of non-empty strings.
  - If you cannot write bullets for an id, do NOT include that id.

Hard rules:
- Do not use the "&" character anywhere in any string value; use "and" instead.
- Never include C# in the skills section. Do not claim C# proficiency. If the JD mentions C#/.NET, emphasize transferable skills you actually have instead.
- No LaTeX preamble, no \\usepackage, no redefinitions of resume macros.
- Facts must match cv.md, profile.yml, and article-digest.md; do not invent employers or degrees.
- Bullet strings are plain prose unless a macro is required; avoid raw % and $ where possible (post-processing will fix common cases).
- Education: school names, degrees, dates, and locations come from the canonical resume data — you only choose which school ids to include and optionally tailor coursework/certification text per id. Coursework and certifications MUST be tied to exactly one school id each — never put a course or certification from one school under another id. Only reuse items that appear under that school's block in cv.md Education; do not invent courses or certs.
- Certifications note (important): Certifications can materially strengthen ATS keyword coverage and credibility across software engineering, data/analytics, product, security, cloud/platform, and other technical roles. When you include education_coursework for a school OR when the JD emphasizes tools/platforms that match certifications present in cv.md, strongly prefer adding education_certifications for that same school (2–4 items). Keep it selective; do not dump the entire certifications list.

Length discipline (aim for ~1-2 pages when compiled with this template; avoid 3+ pages):
- Prefer at most 4 bullets per experience role (3 is typical); only exceed when one role is clearly the spine of the story for this JD.
- Prefer at most 3 bullets per project (2 for secondary projects).
- Keep education compact: prefer 5–8 most JD-relevant courses per school when you include coursework; prefer 2–4 certifications per school when you include certifications. Omit education_coursework or education_certifications keys (or omit a school id inside them) when they do not strengthen this application.
- Omit extracurricular when it does not strengthen this application.

Before you respond (silently verify; do NOT include this checklist in your output):
- If extracurricular_include is [], then extracurricular_bullets must be {}.
- If extracurricular_include is non-empty, ensure EVERY id in extracurricular_include exists as a key in extracurricular_bullets and has at least one bullet string.`;

  const userBody = `Target role: ${role} at ${company}

--- Job description ---
${jdText}

--- profile.yml ---
${context.profile}

--- cv.md ---
${context.cv}

--- article-digest.md (truncated) ---
${(context.digest || '').slice(0, 4000)}

Canonical ids:
- education: ${allowedEdu.join(', ')}
- experience: ${allowedExp.join(', ')}
- projects: ${allowedProj.join(', ')}
- research: ${allowedRes.join(', ')}
- extracurricular: ${allowedExtra.join(', ')}`;

  let msgBody;
  try {
    msgBody = await client.messages.create({
      model,
      max_tokens: 8000,
      system: systemBody,
      messages: [{ role: 'user', content: userBody }],
    });
  } catch (err) {
    return {
      ok: false,
      model,
      error: err?.message || String(err),
      debug: {
        stage: 'anthropic_api',
        rawClaudeText: `(no model response)\n${err?.message || String(err)}`,
      },
    };
  }

  const rawBody = textBlocks(msgBody);
  let parsedSnapshot = null;

  try {
    const parsed = extractJsonObject(rawBody);
    if (!parsed) {
      return {
        ok: false,
        model,
        error: `Resume JSON parse failed. Snippet: ${rawBody.slice(0, 600)}`,
        debug: { stage: 'json_parse', rawClaudeText: rawBody },
      };
    }
    if (parsed.summary != null) delete parsed.summary;
    parsedSnapshot = parsed;

    const sections = buildTemplateSectionsFromResumeBody(canonical, parsed);
    const resumeJson = JSON.stringify(parsed);

    const resume_warnings = [];
    if (parsed.__education_fallback_reason) {
      resume_warnings.push(`education_fallback: ${parsed.__education_fallback_reason}`);
    }
    if (parsed.__education_order_normalized) {
      resume_warnings.push('education_include reordered to canonical resume order');
    }
    if (parsed.__experience_order_normalized) {
      resume_warnings.push('experience_include reordered to canonical reverse-chronological order');
    }
    if (parsed.__extracurricular_order_normalized) {
      resume_warnings.push('extracurricular_include reordered to canonical order');
    }
    if (parsed.__skills_auto_wrapped) {
      resume_warnings.push('skills auto-wrapped into single \\item{...} block');
    }

    const tplPath = join(process.cwd(), 'templates', 'cv-template.tex');
    const tpl = readFileSync(tplPath, 'utf-8');

    const tex = renderTemplate(tpl, sections);

    return { ok: true, tex, model, resumeJson, resume_warnings };
  } catch (err) {
    return {
      ok: false,
      model,
      error: err?.message || String(err),
      debug: {
        stage: 'template_assembly',
        rawClaudeText: rawBody,
        ...(parsedSnapshot != null && {
          parsedJson: JSON.stringify(parsedSnapshot, null, 2),
        }),
      },
    };
  }
}

export async function generateCoverLetter(client, { company, role, jdText, context }) {
  const model = resolveAnthropicModel('cover_letter');
  const system = `You write concise, professional cover letters as plain text (not markdown).
Structure exactly:
1) Salutation line: "Dear Hiring Manager," (or "Dear [Team] Hiring Team," if company name fits naturally)
2) Blank line
3) 2–3 short paragraphs (no bullet lists) connecting the candidate to THIS role
4) Blank line
5) One line: "Thank you for your time and consideration."
6) Blank line
7) Closing: "Best regards," then blank line then the candidate's full name on its own line (take from profile/cv)
Do not include bracketed placeholders. No subject line.`;

  const user = `Company: ${company}\nRole: ${role}\n\n--- JD ---\n${jdText}\n\n--- profile ---\n${context.profile}\n\n--- cv ---\n${context.cv}`;

  const msg = await client.messages.create({
    model,
    max_tokens: 2500,
    system,
    messages: [{ role: 'user', content: user }],
  });

  return { model, text: textBlocks(msg) };
}

export async function generateOutreachEmail(client, { company, role, jdText, context }) {
  const model = resolveAnthropicModel('outreach');
  const candidate = parseCandidateFromProfileYaml(context?.profile || '');
  const signaturePreview = buildEmailSignatureBlock(candidate);

  const system = `You draft a GENERAL outreach email template for the ${role} role at ${company} — addressed to a specific person using a placeholder, because this email will be sent to an individual contact. Reply with a STRICT JSON object only (no markdown), keys:
- subject: one line, professional (e.g. "Interest in ${role} — ${candidate.full_name || 'the candidate'}"). Do NOT include a recipient name.
- body: plain text email body that MUST include:
  • Opening salutation line MUST be exactly: "Hi [Name],"
  • Blank line
  • 2–3 short paragraphs that pitch the candidate to the recipient ("you" language). Write as if the recipient is the person you're reaching out to.
  • Blank line
  • Gratitude line (e.g. "Thank you for your time and consideration.")
  • Blank line
  • Closing block — write EXACTLY this, on its own lines, as the final lines of the body (no extra text after it):

${signaturePreview}

Hard rules:
- Do NOT write "someone on your team", "anyone on your team", or "your team". This email is directed to the recipient.
- Do NOT invent a recipient name. Always keep the literal placeholder [Name] in the salutation.
- Use only factual content from the candidate materials.
- No emojis. Do NOT add any text after the signature block above. Do NOT hyperlink the LinkedIn URL — leave it as plain text.`;

  const user = `Company: ${company}\nRole: ${role}\n\n--- JD ---\n${jdText}\n\n--- profile ---\n${context.profile}\n\n--- cv ---\n${context.cv}`;

  const msg = await client.messages.create({
    model,
    max_tokens: 2500,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const raw = textBlocks(msg);
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') {
    throw new Error(`Outreach model did not return JSON with subject+body. Got: ${raw.slice(0, 500)}`);
  }
  const subject = parsed.subject.trim();
  const body = applyDeterministicEmailSignature(parsed.body, candidate);
  return { model, subject, body };
}

export async function generateLinkedInInvite(client, { company, role, jdText, context }) {
  const model = resolveAnthropicModel('linkedin');
  const system = `Write a GENERAL LinkedIn connection note UNDER 280 characters that the candidate (Pratyush) can send to an individual person at ${company} about the ${role} role. This is a template that will be reused across recipients.
Rules:
- Plain text, no hashtags, no emojis.
- Start with "Hi [Name]," — use the literal placeholder "[Name]" because this draft will be reused across recipients.
- One or two short sentences max.
- Make it clear Pratyush is reaching out about ${role} at ${company} and would love to connect / chat with YOU.
- Do NOT say "someone on your team" or "anyone on your team".
- Do NOT sound like the recipient is reaching out to Pratyush.
- End with "— Pratyush".`;

  const user = `JD summary (truncated): ${jdText.slice(0, 1800)}\n\nCandidate context:\n- profile.yml excerpt:\n${context.profile.slice(0, 2000)}\n\n- cv.md excerpt:\n${context.cv.slice(0, 1200)}`;

  const msg = await client.messages.create({
    model,
    max_tokens: 400,
    system,
    messages: [
      {
        role: 'user',
        content: `${user}\n\n--- profile ---\n${context.profile.slice(0, 4000)}\n\n--- cv head ---\n${context.cv.slice(0, 2000)}`,
      },
    ],
  });

  let text = textBlocks(msg).replace(/\s+/g, ' ').trim();
  if (text.length > 280) text = text.slice(0, 277) + '...';
  return { model, text };
}

function describeContactKind(kind) {
  const k = String(kind || '').toUpperCase();
  if (k === 'RECRUITER') return 'recruiter / talent acquisition contact';
  if (k === 'HIRING_MANAGER') return 'hiring manager / engineering leader for the team';
  return 'team member';
}

function recruiterPromptFlavor(kind) {
  if (String(kind).toUpperCase() === 'HIRING_MANAGER') {
    return [
      'Tone: peer-to-leader. Emphasize concrete impact the candidate could deliver on the team and the strongest evidence of fit from the resume summary and JD.',
      'Briefly mention 1-2 specific achievements from the resume summary that map to what the team is hiring for.',
      'Do NOT lead with logistics (visa, location, timeline); that is the recruiter conversation.',
    ].join('\n');
  }
  return [
    'Tone: warm and professional, helpful to the recruiter\'s job. Make it easy for them to evaluate fit quickly.',
    'Cover: (1) why this specific role + company, (2) one or two strongest fit points from the resume summary, (3) availability / location / authorization status if it can be inferred from profile.',
    'Stay under ~180 words.',
  ].join('\n');
}

/**
 * Per-contact email targeted at a recruiter or hiring manager.
 *
 * @param {import('@anthropic-ai/sdk').Anthropic} client
 * @param {{
 *   contact: { kind: 'RECRUITER'|'HIRING_MANAGER'|'PEER', name?: string, title?: string, linkedin_url?: string },
 *   company: string,
 *   role: string,
 *   jdText: string,
 *   resumeSummary: string,
 *   context: { profile: string, cv: string },
 * }} args
 * @returns {Promise<{ model: string, subject: string, body: string }>}
 */
export async function generatePersonalizedRecruiterEmail(
  client,
  { contact, company, role, jdText, resumeSummary, context }
) {
  const model = resolveAnthropicModel('outreach');
  const kind = String(contact?.kind || 'RECRUITER').toUpperCase();
  const flavor = recruiterPromptFlavor(kind);
  const recipientDescriptor = describeContactKind(kind);
  const namePart = contact?.name ? `the recipient is ${contact.name}` : 'the recipient name is unknown';
  const titlePart = contact?.title ? ` (${contact.title})` : '';

  const system = `You draft a SHORT, personalized outreach email for the ${role} role at ${company}, addressed to a specific ${recipientDescriptor}. ${namePart}${titlePart}.

Reply with a STRICT JSON object only (no markdown, no code fences), keys:
- subject: one line, professional (e.g. "Interest in ${role} — Pratyush Agarwal"). Keep it specific but not gimmicky.
- body: plain text email body that MUST include:
  • Salutation: if a real name is provided, use "Dear <First Name>,". If no name is provided, use "Dear ${company} Hiring Team,".
  • Blank line
  • 2-3 short paragraphs of plain prose
  • Blank line
  • Gratitude line (e.g. "Thank you for your time and consideration.")
  • Blank line
  • Closing "Best regards," then blank line then the candidate's full name on its own line
  • Optional final line with email from profile

${flavor}

Hard rules:
- Use only factual content from the candidate materials — never invent employers, degrees, or numbers.
- No emojis, no markdown, no code fences. Subject must NOT contain a placeholder bracket.
- If contact.linkedin_url is referenced, only mention it implicitly ("saw your work on ..."); never paste the URL.`;

  const userBlocks = [
    `Company: ${company}`,
    `Role: ${role}`,
    `Recipient kind: ${kind}`,
    `Recipient name: ${contact?.name || '(unknown)'}`,
    `Recipient title: ${contact?.title || '(unknown)'}`,
    '',
    '--- JD ---',
    jdText,
    '',
    '--- resume summary (already approved by the candidate) ---',
    resumeSummary || '(no summary available)',
    '',
    '--- profile.yml ---',
    context?.profile || '',
    '',
    '--- cv.md ---',
    context?.cv || '',
  ];

  const msg = await client.messages.create({
    model,
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: userBlocks.join('\n') }],
  });

  const raw = textBlocks(msg);
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') {
    throw new Error(
      `Personalized email model did not return JSON with subject+body. Got: ${raw.slice(0, 500)}`
    );
  }
  return { model, subject: parsed.subject.trim(), body: parsed.body.trim() };
}

function liInvitePromptFlavor(kind) {
  if (String(kind).toUpperCase() === 'HIRING_MANAGER') {
    return 'Frame: peer-to-leader. Mention one specific impact area the candidate could contribute to. Do not pitch logistics.';
  }
  return 'Frame: warm and concise; signal genuine interest in the role and ease the recruiter into a follow-up.';
}

/**
 * Per-contact LinkedIn connection note (under 280 chars), tailored to the
 * contact kind. Uses the 3-sentence framework documented in
 * career-ops/modes/contacto.md.
 *
 * @param {import('@anthropic-ai/sdk').Anthropic} client
 * @param {{
 *   contact: { kind: 'RECRUITER'|'HIRING_MANAGER'|'PEER', name?: string, title?: string },
 *   company: string,
 *   role: string,
 *   jdText: string,
 *   resumeSummary: string,
 *   context: { profile: string, cv: string },
 * }} args
 * @returns {Promise<{ model: string, text: string }>}
 */
export async function generatePersonalizedLinkedInInvite(
  client,
  { contact, company, role, jdText, resumeSummary, context }
) {
  const model = resolveAnthropicModel('linkedin');
  const kind = String(contact?.kind || 'RECRUITER').toUpperCase();
  const flavor = liInvitePromptFlavor(kind);
  const greetName = contact?.name
    ? contact.name.split(/\s+/)[0].replace(/[,.]+$/, '')
    : '[Name]';

  const system = `Write a LinkedIn connection note UNDER 280 characters that Pratyush sends to a specific ${describeContactKind(kind)} at ${company} about the ${role} role.

Use the 3-sentence framework:
  1) Greeting + why you are reaching out (mention ${role} at ${company}).
  2) One concrete reason this person specifically (their team / area / ${contact?.title || 'role'}).
  3) Soft call to chat / share notes; sign off "— Pratyush".

Rules:
- Plain text, no hashtags, no emojis, no markdown.
- Start with "Hi ${greetName},".
- Do NOT sound like the recipient is reaching out to Pratyush.
- Stay under 280 characters total. End with "— Pratyush".

${flavor}`;

  const userBlocks = [
    `Recipient: ${contact?.name || '(unknown name)'} — ${contact?.title || '(unknown title)'}`,
    `Recipient kind: ${kind}`,
    '',
    `JD (truncated):`,
    String(jdText || '').slice(0, 1800),
    '',
    `Resume summary: ${resumeSummary || '(none)'}`,
    '',
    `--- profile excerpt ---`,
    String(context?.profile || '').slice(0, 1500),
    '',
    `--- cv excerpt ---`,
    String(context?.cv || '').slice(0, 1200),
  ];

  const msg = await client.messages.create({
    model,
    max_tokens: 400,
    system,
    messages: [{ role: 'user', content: userBlocks.join('\n') }],
  });

  let text = textBlocks(msg).replace(/\s+/g, ' ').trim();
  if (text.length > 280) text = text.slice(0, 277) + '...';
  return { model, text };
}

export function formatEmailFile({ subject, body }) {
  return `Subject: ${subject}\n\n${body}\n`;
}
