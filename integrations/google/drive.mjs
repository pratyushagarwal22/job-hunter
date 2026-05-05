import { getDriveClientOAuth } from './auth.mjs';
import { requireEnv } from './env.mjs';
import { withGoogleApi } from './rate-limit.mjs';
import { createReadStream } from 'fs';

export const REQUIRED_SUBFOLDERS = ['RESUME', 'COVERLETTER', 'EMAIL', 'JDS', 'CONTEXT'];

/**
 * Process-scoped folder cache. Stage 3 calls `ensureFolderPath(EMAIL_BUCKET,
 * [companyFolder, jobFolder])` per contact-with-email, so 80 contacts × 2
 * segments would be 160 `files.list` calls per job without this cache.
 *
 * Key shape: `${parentId}|${name}`. Stored value is the folder id (string).
 * Lifetime: the lifetime of the Node process; runs are short-lived, so we
 * don't need invalidation. If a folder is deleted out-of-band mid-run, the
 * worst case is a stale id and one downstream Drive error which the retry
 * wrapper will surface — that's acceptable for our usage.
 */
const folderCache = new Map();

/**
 * @param {string} urlOrId Drive share URL or raw file id
 * @returns {string | null}
 */
export function parseDriveFileId(urlOrId) {
  const s = String(urlOrId || '').trim();
  if (!s) return null;
  if (/^[a-zA-Z0-9_-]{25,}$/.test(s) && !s.includes('/')) return s;
  const open = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (open) return open[1];
  const d = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (d) return d[1];
  const u = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (u) return u[1];
  return null;
}

/**
 * Download file bytes as UTF-8 text (for text/plain JD uploads).
 * @param {string} fileId
 */
export async function exportFileUtf8(fileId) {
  const drive = await getDriveClientOAuth();
  const res = await withGoogleApi('drive', () =>
    drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    )
  );
  return Buffer.from(res.data).toString('utf-8');
}

function escapeDriveQueryValue(s) {
  return String(s).replace(/'/g, "\\'");
}

export async function getRootFolder() {
  const drive = await getDriveClientOAuth();
  const rootFolderId = requireEnv('GOOGLE_DRIVE_ROOT_FOLDER_ID');
  const res = await withGoogleApi('drive', () =>
    drive.files.get({
      fileId: rootFolderId,
      fields: 'id,name,mimeType',
      supportsAllDrives: true,
    })
  );
  return { drive, rootFolder: res.data };
}

export async function listChildFolders(parentId) {
  const drive = await getDriveClientOAuth();
  const res = await withGoogleApi('drive', () =>
    drive.files.list({
      q: [
        `'${parentId}' in parents`,
        `mimeType='application/vnd.google-apps.folder'`,
        'trashed=false',
      ].join(' and '),
      fields: 'files(id,name)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
  );
  return res.data.files || [];
}

export async function listChildren(parentId) {
  const drive = await getDriveClientOAuth();
  const q = [
    `'${parentId}' in parents`,
    'trashed=false',
  ].join(' and ');

  const files = [];
  let pageToken = undefined;
  do {
    const res = await withGoogleApi('drive', () =>
      drive.files.list({
        q,
        fields: 'nextPageToken,files(id,name,mimeType)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken,
      })
    );
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return files;
}

export async function findChildFolderByName(parentId, name) {
  const drive = await getDriveClientOAuth();
  const q = [
    `'${parentId}' in parents`,
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${escapeDriveQueryValue(name)}'`,
    'trashed=false',
  ].join(' and ');

  const res = await withGoogleApi('drive', () =>
    drive.files.list({
      q,
      fields: 'files(id,name)',
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
  );
  return (res.data.files || [])[0] || null;
}

export async function ensureFolder(parentId, name) {
  const cacheKey = `${parentId}|${name}`;
  const cached = folderCache.get(cacheKey);
  if (cached) {
    // We only return the id we have; callers that need a full file resource
    // (with mimeType etc.) can call findChildFolderByName themselves. This
    // matches the existing return shape (`{ folder: { id, name } }`) so
    // ensureFolderPath / ensureSubfolders consumers are unaffected.
    return { folder: { id: cached, name }, created: false };
  }

  const drive = await getDriveClientOAuth();
  const existing = await findChildFolderByName(parentId, name);
  if (existing) {
    folderCache.set(cacheKey, existing.id);
    return { folder: existing, created: false };
  }

  const res = await withGoogleApi('drive', () =>
    drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id,name',
      supportsAllDrives: true,
    })
  );
  folderCache.set(cacheKey, res.data.id);
  return { folder: res.data, created: true };
}

export async function ensureFolderPath(rootId, segments) {
  let currentId = rootId;
  const created = [];
  for (const seg of segments) {
    const { folder, created: didCreate } = await ensureFolder(currentId, seg);
    if (didCreate) created.push(folder);
    currentId = folder.id;
  }
  return { folderId: currentId, created };
}

export async function ensureSubfolders(parentId, names = REQUIRED_SUBFOLDERS) {
  const drive = await getDriveClientOAuth();
  const existing = await listChildFolders(parentId);
  const byName = new Map(existing.map(f => [f.name, f]));

  const created = [];
  for (const name of names) {
    if (byName.has(name)) continue;
    const res = await withGoogleApi('drive', () =>
      drive.files.create({
        requestBody: {
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
        },
        fields: 'id,name',
        supportsAllDrives: true,
      })
    );
    folderCache.set(`${parentId}|${name}`, res.data.id);
    created.push(res.data);
  }

  // Re-list once to get the canonical post-state, and prime the cache for any
  // folders that already existed.
  const finalList = await listChildFolders(parentId);
  for (const f of finalList) folderCache.set(`${parentId}|${f.name}`, f.id);
  return { created, folders: finalList };
}

export async function createTextFile(parentId, name, contents) {
  const drive = await getDriveClientOAuth();
  const res = await withGoogleApi('drive', () =>
    drive.files.create({
      requestBody: {
        name,
        parents: [parentId],
        mimeType: 'text/plain',
      },
      media: {
        mimeType: 'text/plain',
        body: contents,
      },
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    })
  );
  return res.data;
}

export async function uploadFileFromPath({ parentId, filename, mimeType, filePath }) {
  const drive = await getDriveClientOAuth();
  const res = await withGoogleApi('drive', () =>
    drive.files.create({
      requestBody: {
        name: filename,
        parents: [parentId],
        mimeType,
      },
      media: {
        mimeType,
        body: createReadStream(filePath),
      },
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    })
  );
  return res.data;
}

export async function listFilesByNamePrefix(parentId, prefix) {
  const drive = await getDriveClientOAuth();
  const q = [
    `'${parentId}' in parents`,
    `name contains '${escapeDriveQueryValue(prefix)}'`,
    'trashed=false',
  ].join(' and ');

  const res = await withGoogleApi('drive', () =>
    drive.files.list({
      q,
      fields: 'files(id,name,parents)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
  );
  return res.data.files || [];
}

export async function deleteFile(fileId) {
  const drive = await getDriveClientOAuth();
  await withGoogleApi('drive', () =>
    drive.files.delete({
      fileId,
      supportsAllDrives: true,
    })
  );
  return { deleted: true, fileId };
}

export async function deleteRecursively(folderId) {
  const children = await listChildren(folderId);
  for (const c of children) {
    if (c.mimeType === 'application/vnd.google-apps.folder') {
      await deleteRecursively(c.id);
    }
    await deleteFile(c.id);
  }
  // A deleted folder may have stale entries in the cache; clear any keys
  // pointing at this folder id so subsequent lookups don't return ghosts.
  for (const [k, v] of folderCache.entries()) {
    if (v === folderId) folderCache.delete(k);
  }
  return { deletedFolderContents: true, folderId, childrenCount: children.length };
}
