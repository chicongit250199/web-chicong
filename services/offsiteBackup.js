'use strict';
// Sao lưu ra ngoài máy: đẩy bản sao lưu DB (nén gzip) + ảnh upload lên Google Drive CỦA CHỦ CỬA HÀNG.
// Service account không có dung lượng Drive riêng (không ghi được vào Drive Gmail cá nhân) -> dùng OAuth của chính tài khoản Google,
// kết nối 1 lần bằng mã thiết bị (giống đăng nhập trên TV). Quyền drive.file: web chỉ thấy / sửa file do chính web tạo.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('../config');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_FILE = path.join(__dirname, '..', 'credentials', 'drive-backup-token.json');
const STATE_FILE = path.join(path.dirname(config.dbPath), 'offsite-backup.json');
const KEEP = parseInt(process.env.OFFSITE_BACKUP_KEEP, 10) || 30; // số bản DB giữ trên Drive
const ROOT_NAME = 'Chi Cong Computer - Sao luu';

const clientId = () => process.env.GDRIVE_BACKUP_CLIENT_ID || '';
const clientSecret = () => process.env.GDRIVE_BACKUP_CLIENT_SECRET || '';
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 }); };

let state = readJson(STATE_FILE, { folders: {}, uploaded: [], last: null, lastError: null, account: null });
const saveState = () => writeJson(STATE_FILE, state);
let pending = null; // phiên kết nối bằng mã đang chờ người dùng xác nhận
let running = false;

function configured() { return Boolean(clientId() && clientSecret()); }
function connected() { return fs.existsSync(TOKEN_FILE); }

// ---- Kết nối bằng mã thiết bị ----
async function post(url, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}

async function startConnect() {
  if (!configured()) throw Object.assign(new Error('Chưa có GDRIVE_BACKUP_CLIENT_ID / GDRIVE_BACKUP_CLIENT_SECRET trong .env'), { status: 400, expose: true });
  const { ok, j } = await post('https://oauth2.googleapis.com/device/code', { client_id: clientId(), scope: SCOPE });
  if (!ok) throw Object.assign(new Error('Google từ chối: ' + String(j.error_description || j.error || 'không rõ').replace(/\.$/, '') + '. Kiểm tra loại OAuth client là "TV và thiết bị đầu vào hạn chế".'), { status: 400, expose: true });
  pending = { device_code: j.device_code, user_code: j.user_code, url: j.verification_url, interval: (j.interval || 5) * 1000, expires: Date.now() + j.expires_in * 1000, lastPoll: 0 };
  return { user_code: j.user_code, url: j.verification_url, expires_in: j.expires_in };
}

// Gọi định kỳ từ trình duyệt cho tới khi người dùng xác nhận xong
async function pollConnect() {
  if (!pending) return { status: connected() ? 'connected' : 'idle' };
  if (Date.now() > pending.expires) { pending = null; return { status: 'expired' }; }
  if (Date.now() - pending.lastPoll < pending.interval) return { status: 'waiting' };
  pending.lastPoll = Date.now();
  const { ok, j } = await post('https://oauth2.googleapis.com/token', {
    client_id: clientId(), client_secret: clientSecret(), device_code: pending.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (!ok) {
    if (j.error === 'authorization_pending') return { status: 'waiting' };
    if (j.error === 'slow_down') { pending.interval += 5000; return { status: 'waiting' }; }
    pending = null;
    return { status: 'error', error: j.error === 'access_denied' ? 'Bạn đã từ chối cấp quyền.' : (j.error_description || j.error) };
  }
  writeJson(TOKEN_FILE, { refresh_token: j.refresh_token, created_at: new Date().toISOString() });
  pending = null;
  drive = null;
  state = { folders: {}, uploaded: [], last: null, lastError: null, account: null };
  try { const a = await client().about.get({ fields: 'user(emailAddress,displayName)' }); state.account = a.data.user.emailAddress; } catch { /* không bắt buộc */ }
  saveState();
  return { status: 'connected', account: state.account };
}

function disconnect() {
  fs.rmSync(TOKEN_FILE, { force: true });
  drive = null;
  state = { folders: {}, uploaded: [], last: null, lastError: null, account: null };
  saveState();
}

// ---- Drive client ----
let drive = null;
function client() {
  if (drive) return drive;
  const tok = readJson(TOKEN_FILE, null);
  if (!tok || !tok.refresh_token) throw Object.assign(new Error('Chưa kết nối Google Drive'), { status: 400, expose: true });
  const { drive: makeDrive, auth } = require('@googleapis/drive');
  const o = new auth.OAuth2(clientId(), clientSecret());
  o.setCredentials({ refresh_token: tok.refresh_token });
  drive = makeDrive({ version: 'v3', auth: o });
  return drive;
}

async function folder(name, parent) {
  const key = (parent || 'root') + '/' + name;
  const d = client();
  if (state.folders[key]) {
    try { const f = await d.files.get({ fileId: state.folders[key], fields: 'id, trashed' }); if (!f.data.trashed) return state.folders[key]; } catch { /* bị xóa -> tạo lại */ }
  }
  const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false` + (parent ? ` and '${parent}' in parents` : '');
  const found = (await d.files.list({ q, fields: 'files(id)', pageSize: 1 })).data.files[0];
  const id = found ? found.id : (await d.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }, fields: 'id' })).data.id;
  state.folders[key] = id; saveState();
  return id;
}

async function uploadFile(name, parent, body, mimeType) {
  const r = await client().files.create({ requestBody: { name, parents: [parent] }, media: { mimeType, body }, fields: 'id, size' });
  return r.data;
}

// ---- Sao lưu: DB mới nhất (gzip) + ảnh upload chưa đẩy ----
async function run(reason = 'auto') {
  if (running) return { skipped: 'Đang chạy' };
  if (!configured() || !connected()) return { skipped: 'Chưa kết nối Google Drive' };
  running = true;
  const t0 = Date.now();
  try {
    const root = await folder(ROOT_NAME);
    const dbDir = await folder('CSDL', root);
    const upDir = await folder('Anh-upload', root);

    // 1) Bản sao lưu DB mới nhất trong data/backups (local backup chạy trước)
    const files = fs.existsSync(config.backupDir) ? fs.readdirSync(config.backupDir).filter(f => /^chicong-.*\.db$/.test(f)).sort() : [];
    const latest = files[files.length - 1];
    let dbInfo = null;
    if (latest) {
      const name = latest + '.gz';
      const exists = (await client().files.list({ q: `name = '${name}' and '${dbDir}' in parents and trashed = false`, fields: 'files(id)', pageSize: 1 })).data.files.length;
      if (!exists) {
        const gz = zlib.gzipSync(fs.readFileSync(path.join(config.backupDir, latest)), { level: 9 });
        const r = await uploadFile(name, dbDir, require('stream').Readable.from(gz), 'application/gzip');
        dbInfo = { name, size: Number(r.size) || gz.length };
      } else dbInfo = { name, size: null, existed: true };
      // giữ KEEP bản mới nhất trên Drive
      const all = (await client().files.list({ q: `'${dbDir}' in parents and trashed = false`, fields: 'files(id, name)', orderBy: 'name desc', pageSize: 200 })).data.files;
      for (const f of all.slice(KEEP)) await client().files.delete({ fileId: f.id }).catch(() => {});
    }

    // 2) Ảnh upload: chỉ đẩy file mới (ảnh đặt tên duy nhất, không bị sửa đè)
    const done = new Set(state.uploaded);
    const imgs = fs.readdirSync(config.uploadDir).filter(f => !f.startsWith('.') && !done.has(f) && fs.statSync(path.join(config.uploadDir, f)).isFile());
    let imgCount = 0;
    for (const f of imgs) {
      await uploadFile(f, upDir, fs.createReadStream(path.join(config.uploadDir, f)), 'application/octet-stream');
      state.uploaded.push(f); imgCount++;
      if (imgCount % 10 === 0) saveState();
    }
    state.last = { at: new Date().toISOString(), reason, db: dbInfo, images: imgCount, totalImages: state.uploaded.length, seconds: Math.round((Date.now() - t0) / 1000) };
    state.lastError = null;
    saveState();
    console.log(`[offsite] Drive: ${dbInfo ? dbInfo.name : 'không có DB'} + ${imgCount} ảnh mới`);
    return state.last;
  } catch (e) {
    const msg = /invalid_grant/.test(String(e.message)) ? 'Quyền truy cập Drive đã hết hạn hoặc bị thu hồi — hãy kết nối lại.' : e.message;
    state.lastError = { at: new Date().toISOString(), message: msg };
    saveState();
    console.error('[offsite] lỗi', msg);
    throw Object.assign(new Error(msg), { status: 502, expose: true });
  } finally { running = false; }
}

function status() {
  return { configured: configured(), connected: connected(), account: state.account, last: state.last, lastError: state.lastError, running, keep: KEEP,
    pending: pending ? { user_code: pending.user_code, url: pending.url } : null };
}

module.exports = { startConnect, pollConnect, disconnect, run, status };
