import crypto from 'crypto';

export function ymd(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function slugifyFolderName(s) {
  return String(s || '')
    .trim()
    .replace(/[\/\\:*?"<>|]/g, '-') // illegal on some filesystems (safe habit)
    .replace(/\s+/g, ' ')
    .replace(/\s/g, ' ')
    .slice(0, 80);
}

export function makeJobId({ company, role, url }) {
  const date = ymd();
  const base = `${company || ''}::${role || ''}::${url || ''}`.toLowerCase().trim();
  const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 8).toUpperCase();
  return `JH-${date.replace(/-/g, '')}-${hash}`;
}

