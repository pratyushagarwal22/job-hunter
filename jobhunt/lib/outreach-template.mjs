import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// career-ops/ (module is in career-ops/jobhunt/lib)
const CAREER_OPS_ROOT = resolve(__dirname, '..', '..');

function getTemplatesRoot() {
  return join(CAREER_OPS_ROOT, 'templates', 'outreach');
}

function safeReadText(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

function renderBracketPlaceholders(text, map) {
  let out = String(text || '');
  for (const [k, v] of Object.entries(map || {})) {
    out = out.split(`[${k}]`).join(v == null ? '' : String(v));
  }
  return out;
}

function parseEmailTemplate(raw) {
  const s = String(raw || '');
  const lines = s.split(/\r?\n/);
  let subject = '';
  let startIdx = 0;

  // Support:
  // 1) `Subject: ...` on first line
  // 2) optional blank lines after Subject
  if (lines[0] && /^Subject:\s*/i.test(lines[0])) {
    subject = lines[0].replace(/^Subject:\s*/i, '').trim();
    startIdx = 1;
    while (startIdx < lines.length && lines[startIdx].trim() === '') startIdx++;
  }

  const body = lines.slice(startIdx).join('\n').replace(/\n+$/, '');
  return { subject, body };
}

function roleArchetypeToLabel(roleArchetype) {
  const r = String(roleArchetype || '').toUpperCase();
  if (r === 'ANALYST') return 'Data Analyst';
  if (r === 'DE') return 'Data Engineering';
  if (r === 'BI') return 'Business Intelligence';
  if (r === 'PRODUCT') return 'Product';
  if (r === 'SWE') return 'Software Engineering';
  return r || 'Professional';
}

function describeRecipientKind(kind) {
  const k = String(kind || '').toUpperCase();
  if (k === 'HIRING_MANAGER') return 'a hiring manager';
  if (k === 'RECRUITER') return 'a recruiter';
  return 'a team member';
}

function fallbackEmail({ roleArchetype, kind, company, name }) {
  const roleLabel = roleArchetypeToLabel(roleArchetype);
  const recipientTone = String(kind || '').toUpperCase() === 'HIRING_MANAGER'
    ? 'I’d love to connect directly with you about'
    : 'I’d appreciate your help connecting me with the right person for';

  const subject = `Interest in ${roleLabel} at ${company}`;
  const body = [
    `Hi ${name || 'there'},`,
    '',
    `${recipientTone} the ${roleLabel} role at ${company}.`,
    'I’m a data/analytics engineer who ships production pipelines and turns messy inputs into reliable reporting and decisions.',
    '',
    'Thank you for your time and consideration.',
  ].join('\n');

  return { subject, body };
}

function fallbackLinkedIn({ roleArchetype, kind, company, name }) {
  const roleLabel = roleArchetypeToLabel(roleArchetype);
  // Keep it short; we do not strictly enforce 280 chars because sending is out of scope.
  return [
    `Hi ${name || 'there'},`,
    `I’m reaching out about the ${roleLabel} role at ${company}.`,
    `If you’re the right person (${describeRecipientKind(kind)}), I’d love to connect and chat.`,
    '— Pratyush',
  ].join(' ');
}

function pickTemplateFile(kind, roleArchetype, channel) {
  const templatesRoot = getTemplatesRoot();
  // channel: 'emails' | 'linkedin'
  const role = String(roleArchetype || '').toUpperCase();
  const wanted = join(templatesRoot, channel, role, `${String(kind).toUpperCase()}.txt`);

  // If the user hasn’t created templates for a given role yet, we fall back
  // to ANALYST templates so Stage 3 can still exercise the full draft path.
  const fallback = join(templatesRoot, channel, 'ANALYST', `${String(kind).toUpperCase()}.txt`);

  return existsSync(wanted) ? wanted : fallback;
}

export function loadOutreachEmailTemplate({ roleArchetype, kind }) {
  const p = pickTemplateFile(kind, roleArchetype, 'emails');
  const raw = safeReadText(p);
  if (!raw) return null;
  const parsed = parseEmailTemplate(raw);
  if (!parsed.subject && !parsed.body) return null;
  return parsed;
}

export function loadOutreachLinkedInTemplate({ roleArchetype, kind }) {
  const p = pickTemplateFile(kind, roleArchetype, 'linkedin');
  const raw = safeReadText(p);
  if (!raw) return null;
  return String(raw).trim().replace(/\n+$/, '');
}

export function renderEmailFromTemplate({
  template,
  placeholders,
}) {
  const subject = renderBracketPlaceholders(template?.subject || '', placeholders);
  const body = renderBracketPlaceholders(template?.body || '', placeholders);
  return { subject, body };
}

export function renderLinkedInFromTemplate({ templateText, placeholders }) {
  return renderBracketPlaceholders(templateText || '', placeholders).trim();
}

export function buildDraftEmailAndLinkedIn({
  roleArchetype,
  recipientKind,
  company,
  personName,
}) {
  const templateEmail = loadOutreachEmailTemplate({ roleArchetype, kind: recipientKind });
  const fallback = fallbackEmail({
    roleArchetype,
    kind: recipientKind,
    company,
    name: personName,
  });

  const email = templateEmail
    ? renderEmailFromTemplate({
        template: templateEmail,
        placeholders: {
          Name: personName || '',
          Company: company || '',
          RoleType: roleArchetypeToLabel(roleArchetype),
          Role: roleArchetypeToLabel(roleArchetype),
        },
      })
    : fallback;

  const templateLi = loadOutreachLinkedInTemplate({ roleArchetype, kind: recipientKind });
  const linkedin = templateLi
    ? renderLinkedInFromTemplate({
        templateText: templateLi,
        placeholders: {
          Name: personName || '',
          Company: company || '',
          RoleType: roleArchetypeToLabel(roleArchetype),
          Role: roleArchetypeToLabel(roleArchetype),
        },
      })
    : fallbackLinkedIn({
        roleArchetype,
        kind: recipientKind,
        company,
        name: personName,
      });

  return { email, linkedin };
}

export function sanitizeEmailForFolder(email) {
  // Google Drive folder names are fairly permissive; just strip slashes that break path semantics.
  return String(email || '').trim().replace(/[\\/]+/g, '-');
}

