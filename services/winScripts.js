'use strict';
// Script PowerShell cho máy khách (link /shel). Lưu trong bảng win_scripts; cập nhật từ gist qua GitHub API.
const db = require('../db');

const MAX_SIZE = 1024 * 1024; // 1 MB / script
const now = () => new Date().toISOString();

const COLS = 'id, file, name, descr, gist_url, enabled, pe, sort, synced_at, updated_at, length(content) AS size, prev_content IS NOT NULL AS has_prev';
const list = () => db.prepare(`SELECT ${COLS}, (SELECT full_name FROM users u WHERE u.id = s.updated_by) AS updated_by_name FROM win_scripts s ORDER BY sort, id`).all();
const get = (id) => db.prepare('SELECT * FROM win_scripts WHERE id = ?').get(id);
const enabledWithContent = () => db.prepare("SELECT file, name, descr, content, pe FROM win_scripts WHERE enabled = 1 AND content <> '' ORDER BY sort, id").all();

function cleanFile(f) {
  let s = String(f || '').trim().replace(/\.ps1$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  if (!s) throw new Error('Tên file không hợp lệ (chỉ dùng chữ không dấu, số, . _ -)');
  return s.slice(0, 60) + '.ps1';
}
function cleanContent(c) {
  const s = String(c == null ? '' : c).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (Buffer.byteLength(s) > MAX_SIZE) throw new Error('Script quá lớn (tối đa 1 MB)');
  return s;
}
function cleanGist(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  if (!gistId(s)) throw new Error('Link gist không hợp lệ');
  return s;
}
function gistId(u) {
  const s = String(u || '').trim();
  const m = s.match(/gist\.github(?:usercontent)?\.com\/(?:[^/]+\/)?([0-9a-f]{20,40})/i) || s.match(/^([0-9a-f]{20,40})$/i);
  return m ? m[1].toLowerCase() : null;
}
function dupFile(file, exceptId) {
  const r = db.prepare('SELECT id FROM win_scripts WHERE file = ? COLLATE NOCASE AND id <> ?').get(file, exceptId || 0);
  if (r) throw new Error('Đã có script tên file ' + file);
}

// Đọc gist: { id, description, files: [{ name, size }], file, content } — file = file .ps1 khớp tên muốn lấy, không có thì file .ps1 đầu tiên
async function fetchGist(url, wantFile) {
  const id = gistId(url);
  if (!id) throw new Error('Link gist không hợp lệ');
  const r = await fetch('https://api.github.com/gists/' + id, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'chicong-web' }, signal: AbortSignal.timeout(20000),
  });
  if (r.status === 404) throw new Error('Không thấy gist (link sai hoặc gist đã xóa)');
  if (r.status === 403 || r.status === 429) throw new Error('GitHub tạm chặn vì gọi quá nhiều (60 lần/giờ) — thử lại sau');
  if (!r.ok) throw new Error('GitHub lỗi ' + r.status);
  const g = await r.json();
  const files = Object.values(g.files || {});
  if (!files.length) throw new Error('Gist không có file nào');
  const want = String(wantFile || '').toLowerCase();
  const f = files.find(x => x.filename.toLowerCase() === want) || files.find(x => /\.ps1$/i.test(x.filename)) || files[0];
  let content = f.content;
  if (f.truncated || content == null) {
    const rr = await fetch(f.raw_url, { headers: { 'User-Agent': 'chicong-web' }, signal: AbortSignal.timeout(20000) });
    if (!rr.ok) throw new Error('Không tải được file ' + f.filename + ' (lỗi ' + rr.status + ')');
    content = await rr.text();
  }
  return { id, description: g.description || '', files: files.map(x => ({ name: x.filename, size: x.size })), file: f.filename, content: cleanContent(content) };
}

function create(d, userId) {
  const file = cleanFile(d.file);
  dupFile(file);
  const name = String(d.name || '').trim().slice(0, 120);
  if (!name) throw new Error('Nhập tên chức năng');
  const content = cleanContent(d.content);
  if (!content.trim()) throw new Error('Script đang trống — dán nội dung, chọn file .ps1 hoặc lấy từ gist');
  const sort = (db.prepare('SELECT MAX(sort) AS m FROM win_scripts').get().m || 0) + 1;
  const info = db.prepare('INSERT INTO win_scripts (file, name, descr, gist_url, content, enabled, pe, sort, synced_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(file, name, String(d.descr || '').trim().slice(0, 300), cleanGist(d.gist_url), content, d.enabled === false ? 0 : 1, d.pe ? 1 : 0, sort, d.fromGist ? now() : null, userId || null);
  return get(info.lastInsertRowid);
}

function update(id, d, userId) {
  const cur = get(id);
  if (!cur) throw new Error('Không thấy script');
  const file = d.file != null ? cleanFile(d.file) : cur.file;
  dupFile(file, id);
  const name = d.name != null ? String(d.name).trim().slice(0, 120) : cur.name;
  if (!name) throw new Error('Nhập tên chức năng');
  const content = d.content != null ? cleanContent(d.content) : cur.content;
  if (!content.trim()) throw new Error('Script đang trống');
  const changed = content !== cur.content;
  db.prepare(`UPDATE win_scripts SET file = ?, name = ?, descr = ?, gist_url = ?, content = ?, prev_content = ?, enabled = ?, pe = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
    .run(file, name, d.descr != null ? String(d.descr).trim().slice(0, 300) : cur.descr,
      d.gist_url !== undefined ? cleanGist(d.gist_url) : cur.gist_url, content, changed ? cur.content : cur.prev_content,
      d.enabled != null ? (d.enabled ? 1 : 0) : cur.enabled, d.pe != null ? (d.pe ? 1 : 0) : cur.pe, now(), userId || null, id);
  return get(id);
}

// Lấy bản mới từ gist. Trả { changed }
async function sync(id, userId) {
  const cur = get(id);
  if (!cur) throw new Error('Không thấy script');
  if (!cur.gist_url) throw new Error('Script này chưa gắn link gist');
  const g = await fetchGist(cur.gist_url, cur.file);
  const changed = g.content !== cur.content;
  if (!g.content.trim()) throw new Error('File trên gist đang trống — không cập nhật');
  db.prepare('UPDATE win_scripts SET content = ?, prev_content = ?, synced_at = ?, updated_at = CASE WHEN ? THEN ? ELSE updated_at END, updated_by = CASE WHEN ? THEN ? ELSE updated_by END WHERE id = ?')
    .run(g.content, changed ? cur.content : cur.prev_content, now(), changed ? 1 : 0, now(), changed ? 1 : 0, userId || null, id);
  return { changed, file: g.file };
}

async function syncAll(userId) {
  const rows = db.prepare('SELECT id, name FROM win_scripts WHERE gist_url IS NOT NULL ORDER BY sort, id').all();
  const out = [];
  for (const r of rows) {
    try { out.push({ id: r.id, name: r.name, ok: true, ...(await sync(r.id, userId)) }); }
    catch (e) { out.push({ id: r.id, name: r.name, ok: false, error: e.message }); }
  }
  return out;
}

function undo(id, userId) {
  const cur = get(id);
  if (!cur || cur.prev_content == null) throw new Error('Không có bản trước để khôi phục');
  db.prepare('UPDATE win_scripts SET content = ?, prev_content = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(cur.prev_content, cur.content, now(), userId || null, id);
}

function move(id, dir) {
  const rows = db.prepare('SELECT id FROM win_scripts ORDER BY sort, id').all().map(r => r.id);
  const i = rows.indexOf(Number(id)), j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  const st = db.prepare('UPDATE win_scripts SET sort = ? WHERE id = ?');
  db.transaction(() => rows.forEach((rid, k) => st.run(k + 1, rid)))();
}

const remove = (id) => db.prepare('DELETE FROM win_scripts WHERE id = ?').run(id);

module.exports = { list, get, enabledWithContent, fetchGist, create, update, sync, syncAll, undo, move, remove, gistId };
