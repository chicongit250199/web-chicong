'use strict';
// Google Drive (Service Account, chỉ đọc). Nhớ share thư mục cho email của service account.
const fs = require('fs');
const config = require('../config');

let drive = null;

function status() {
  const p = config.googleServiceAccountPath;
  let email = '';
  let ok = Boolean(p && fs.existsSync(p));
  if (ok) {
    try { email = JSON.parse(fs.readFileSync(p, 'utf8')).client_email || ''; } catch { ok = false; }
  }
  return {
    credentials: ok, email,
    inFolder: config.driveVatInputFolderId, outFolder: config.driveVatOutputFolderId,
  };
}

function client() {
  if (drive) return drive;
  if (!status().credentials) {
    const e = new Error('Chưa có file Service Account (GOOGLE_SERVICE_ACCOUNT_PATH)'); e.status = 400; e.expose = true; throw e;
  }
  const { drive: makeDrive, auth } = require('@googleapis/drive');
  const credentials = JSON.parse(fs.readFileSync(config.googleServiceAccountPath, 'utf8'));
  const a = new auth.JWT({ email: credentials.client_email, key: credentials.private_key, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  drive = makeDrive({ version: 'v3', auth: a });
  return drive;
}

// Liệt kê file trong thư mục (kèm thư mục con 1 cấp — nhiều người chia theo tháng).
// skipFolder(name) -> true để bỏ qua thư mục con (VD: thư mục "HĐ Bán ra" nằm trong "Đầu vào")
async function listFiles(folderId, depth = 1, skipFolder = () => false) {
  const d = client();
  const out = [];
  let pageToken;
  do {
    const r = await d.files.list({
      q: `'${folderId.replace(/'/g, '')}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, webViewLink, createdTime, size)',
      pageSize: 1000, pageToken, orderBy: 'createdTime',
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        if (depth > 0 && !skipFolder(f.name)) out.push(...await listFiles(f.id, depth - 1, skipFolder));
      } else out.push(f);
    }
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function download(fileId) {
  const r = await client().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return Buffer.from(r.data);
}

module.exports = { status, listFiles, download };
