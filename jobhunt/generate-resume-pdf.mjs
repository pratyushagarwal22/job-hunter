#!/usr/bin/env node
/**
 * generate-resume-pdf.mjs
 *
 * Minimal end-to-end check:
 * - Fills templates/cv-template.tex placeholders with safe sample content
 * - Compiles to PDF via generate-latex.mjs (tectonic/pdflatex)
 * - Uploads PDF into Drive under RESUME/<Company>/<Date_JOBID>/
 * - Appends an ASSETS row with the resume link
 *
 * Usage:
 *   node jobhunt/generate-resume-pdf.mjs
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';

import { loadDotenv } from '../integrations/google/env.mjs';
import { ensureSubfolders, ensureFolderPath, uploadFileFromPath } from '../integrations/google/drive.mjs';
import { getRootFolder } from '../integrations/google/drive.mjs';
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

const now = new Date();
const date = ymd(now);

// We treat this as a “job” so it fits the same job_id / folder conventions.
const context = {
  source: 'RESUME_TEST',
  company: 'ResumeTest',
  role: 'LaTeX PDF Generation',
  location: '',
  url: 'local:resume-test',
};
const job_id = makeJobId(context);

// Load profile.yml for real identity fields
const profilePath = join(ROOT, 'config', 'profile.yml');
const profileRaw = await readFile(profilePath, 'utf-8');
const profile = yaml.load(profileRaw);
const c = profile?.candidate || {};

const name = c.full_name || 'Your Name';
const email = c.email || 'you@example.com';
const linkedinUrl = c.linkedin || 'https://linkedin.com/in/username';
const phone = c.phone || '';
const location = c.location || '';

const contactLine = [phone, location].filter(Boolean).join(' $|$ ');

// Minimal content blocks that satisfy validator requirements.
const summary = latexEscape(profile?.narrative?.headline || 'ATS-friendly summary goes here.');

const education = [
  '\\resumeSubheading',
  '  {University}{Aug 2024 -- May 2026}',
  '  {Degree; GPA}{City, State}',
].join('\n');

const skills = [
  '\\item{',
  '  \\textbf{Languages}{: Python, SQL} \\\\',
  '  \\textbf{Data}{: Airflow, dbt, Spark} \\\\',
  '  \\textbf{Cloud}{: AWS, GCP, Azure}',
  '}',
].join('\n');

const experience = [
  '\\resumeSubheading',
  '  {Company}{Jan 2025 -- Present}',
  '  {Role}{Location}',
  '  \\resumeItemListStart',
  '    \\resumeItem{Impact}{Shipped an end-to-end data pipeline with measurable outcomes.}',
  '  \\resumeItemListEnd',
].join('\n');

const projects = [
  '\\resumeProjectHeading{Project Name}{Context}',
  '\\resumeItemListStart',
  '  \\resumeItem{Result}{Built something useful and quantified the impact.}',
  '\\resumeItemListEnd',
].join('\n');

// Optional sections empty for this test.
const researchSection = '';
const extracurricularSection = '';

// Fill LaTeX template
const tplPath = join(ROOT, 'templates', 'cv-template.tex');
const tpl = await readFile(tplPath, 'utf-8');

const filled = tpl
  .replaceAll('{{NAME}}', latexEscape(name))
  .replaceAll('{{EMAIL_URL}}', email)
  .replaceAll('{{EMAIL_DISPLAY}}', latexEscape(email))
  .replaceAll('{{LINKEDIN_URL}}', linkedinUrl)
  .replaceAll('{{LINKEDIN_DISPLAY}}', latexEscape(stripScheme(linkedinUrl)))
  .replaceAll('{{CONTACT_LINE}}', latexEscape(contactLine))
  .replaceAll('{{SUMMARY}}', summary)
  .replaceAll('{{EDUCATION}}', education)
  .replaceAll('{{SKILLS}}', skills)
  .replaceAll('{{EXPERIENCE}}', experience)
  .replaceAll('{{PROJECTS}}', projects)
  .replaceAll('{{RESEARCH_SECTION}}', researchSection)
  .replaceAll('{{EXTRACURRICULAR_SECTION}}', extracurricularSection);

const outDir = join(ROOT, 'output', 'jobhunt');
await mkdir(outDir, { recursive: true });
const texOut = join(outDir, `resume-${job_id}.tex`);
const pdfOut = join(outDir, `resume-${job_id}.pdf`);

await writeFile(texOut, filled, 'utf-8');

// Compile using existing validator/compiler
execFileSync('node', [join(ROOT, 'generate-latex.mjs'), texOut, pdfOut], {
  stdio: 'pipe',
  timeout: 180_000,
});

// Upload PDF into nested Drive folder: RESUME/<Company>/<Date_JOBID>/
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
  filename: `resume-${job_id}.pdf`,
  mimeType: 'application/pdf',
  filePath: pdfOut,
});

// Write minimal ASSETS row linking the resume
await appendRow('ASSETS', [
  job_id,
  context.company,
  context.role,
  'RESUME_PDF_READY',
  uploaded.webViewLink,
  '',
  '',
  '',
  '',
  now.toISOString(),
  'latex/pdf generation test',
]);

console.log(JSON.stringify({
  ok: true,
  job_id,
  tex: texOut,
  pdf: pdfOut,
  drive: uploaded.webViewLink,
}, null, 2));

