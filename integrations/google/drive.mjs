import { getDriveClientOAuth } from './auth.mjs';
import { requireEnv } from './env.mjs';
import { createReadStream } from 'fs';

export const REQUIRED_SUBFOLDERS = ['RESUME', 'COVERLETTER', 'EMAIL', 'JDS', 'CONTEXT'];

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
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data).toString('utf-8');
}

function escapeDriveQueryValue(s) {
  return String(s).replace(/'/g, "\\'");
}

export async function getRootFolder() {
  const drive = await getDriveClientOAuth();
  const rootFolderId = requireEnv('GOOGLE_DRIVE_ROOT_FOLDER_ID');
  const res = await drive.files.get({
    fileId: rootFolderId,
    fields: 'id,name,mimeType',
    supportsAllDrives: true,
  });
  return { drive, rootFolder: res.data };
}

export async function listChildFolders(parentId) {
  const drive = await getDriveClientOAuth();
  const res = await drive.files.list({
    q: [
      `'${parentId}' in parents`,
      `mimeType='application/vnd.google-apps.folder'`,
      'trashed=false',
    ].join(' and '),
    fields: 'files(id,name)',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
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
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken,files(id,name,mimeType)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
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

  const res = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files || [])[0] || null;
}

export async function ensureFolder(parentId, name) {
  const drive = await getDriveClientOAuth();
  const existing = await findChildFolderByName(parentId, name);
  if (existing) return { folder: existing, created: false };

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id,name',
    supportsAllDrives: true,
  });
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
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id,name',
      supportsAllDrives: true,
    });
    created.push(res.data);
  }

  const finalList = await listChildFolders(parentId);
  return { created, folders: finalList };
}

export async function createTextFile(parentId, name, contents) {
  const drive = await getDriveClientOAuth();
  const res = await drive.files.create({
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
  });
  return res.data;
}

export async function uploadFileFromPath({ parentId, filename, mimeType, filePath }) {
  const drive = await getDriveClientOAuth();
  const res = await drive.files.create({
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
  });
  return res.data;
}

export async function listFilesByNamePrefix(parentId, prefix) {
  const drive = await getDriveClientOAuth();
  const q = [
    `'${parentId}' in parents`,
    `name contains '${escapeDriveQueryValue(prefix)}'`,
    'trashed=false',
  ].join(' and ');

  const res = await drive.files.list({
    q,
    fields: 'files(id,name,parents)',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files || [];
}

export async function deleteFile(fileId) {
  const drive = await getDriveClientOAuth();
  await drive.files.delete({
    fileId,
    supportsAllDrives: true,
  });
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
  return { deletedFolderContents: true, folderId, childrenCount: children.length };
}

