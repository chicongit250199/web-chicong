'use strict';
// Thông báo qua Zalo Bot (https://bot.zapps.me/docs) — bản sao các thông báo trong web gửi sang Zalo
//  - Nhận tin bằng getUpdates (long polling): web chỉ chạy trong LAN nên không dùng webhook được
//  - Liên kết: quản lý lấy mã 6 số cho 1 tài khoản → người đó nhắn mã cho bot → lưu chat_id
//  - Gửi lần lượt qua hàng đợi; lỗi chỉ ghi log, không ảnh hưởng thông báo trong web
// Token trong .env (ZALO_BOT_TOKEN), nằm trong URL API → không bao giờ ghi URL ra log.
// Server thử (BACKUP_DISABLED=true) tắt bot, trừ khi đặt ZALO_API_BASE (trỏ tới server giả để test).
const db = require('../db');

const TOKEN = (process.env.ZALO_BOT_TOKEN || '').trim();
const BASE = (process.env.ZALO_API_BASE || 'https://bot-api.zaloplatforms.com').replace(/\/+$/, '');
const PUBLIC_URL = (process.env.PUBLIC_BASE_URL || 'http://chicongcomputer.local').replace(/\/+$/, '');
const ENABLED = !!TOKEN && (process.env.BACKUP_DISABLED !== 'true' || !!process.env.ZALO_API_BASE);
const MAX_TEXT = 2000, CODE_TTL = 15 * 60e3, MAX_QUEUE = 300, GAP_MS = 350;

const q = {
  recipients: db.prepare(`SELECT id, full_name, role, zalo_chat_id FROM users
    WHERE is_active = 1 AND zalo_enabled = 1 AND zalo_chat_id IS NOT NULL`),
  byChat: db.prepare('SELECT id, full_name FROM users WHERE zalo_chat_id = ?'),
  get: db.prepare('SELECT id, full_name, is_active, zalo_chat_id, zalo_name, zalo_enabled FROM users WHERE id = ?'),
  link: db.prepare('UPDATE users SET zalo_chat_id = ?, zalo_name = ?, zalo_enabled = 1 WHERE id = ?'),
  unlinkChat: db.prepare('UPDATE users SET zalo_chat_id = NULL, zalo_name = NULL WHERE zalo_chat_id = ? AND id <> ?'),
  unlink: db.prepare('UPDATE users SET zalo_chat_id = NULL, zalo_name = NULL WHERE id = ?'),
  setEnabled: db.prepare('UPDATE users SET zalo_enabled = ? WHERE id = ?'),
};

const state = {
  bot: null, polling: false, lastPollOk: null, lastError: null, lastErrorAt: null,
  sent: 0, failed: 0, lastSentAt: null, startedAt: null,
};
const codes = new Map(); // mã → { userId, exp }
const queue = [];
let sending = false, stopped = false;
const seen = new Set(); // message_id đã xử lý (phòng getUpdates trả lặp)

function log(...a) { console.log('[zalo]', ...a); }
function fail(where, e) {
  state.lastError = `${where}: ${e.message || e}`.slice(0, 300);
  state.lastErrorAt = new Date().toISOString();
  console.error('[zalo]', state.lastError);
}

async function call(method, params, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}), signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.description || `HTTP ${res.status}`);
      err.code = data.error_code || res.status;
      throw err;
    }
    return data.result;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Hết thời gian chờ Zalo');
    throw e;
  } finally { clearTimeout(t); }
}

// ---------- Gửi ----------
function clip(s) { s = String(s || ''); return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + '…' : s; }

function enqueue(chatId, text) {
  if (!ENABLED || !chatId) return false;
  if (queue.length >= MAX_QUEUE) { state.failed++; return false; }
  queue.push({ chatId: String(chatId), text: clip(text) });
  pump();
  return true;
}

async function pump() {
  if (sending) return;
  sending = true;
  try {
    while (queue.length) {
      const m = queue.shift();
      try {
        await call('sendMessage', { chat_id: m.chatId, text: m.text });
        state.sent++; state.lastSentAt = new Date().toISOString();
      } catch (e) { state.failed++; fail('gửi tin', e); }
      await new Promise(r => setTimeout(r, GAP_MS));
    }
  } finally { sending = false; }
}

function absLink(link) {
  if (!link) return '';
  return /^https?:\/\//.test(link) ? link : PUBLIC_URL + (link.startsWith('/') ? '' : '/') + link;
}

// Gọi từ events.notify: gửi cho người đã liên kết + bật nhận, đúng phạm vi (quản lý: tất cả; nhân viên: audience 'all'),
// bỏ qua người tự làm thao tác đó
function onNotification(n) {
  if (!ENABLED || !n) return;
  let list;
  try { list = q.recipients.all(); } catch (e) { return fail('đọc người nhận', e); }
  const link = absLink(n.link);
  const text = `🔔 ${n.message}${link ? '\n' + link : ''}`;
  for (const u of list) {
    if (u.role !== 'manager' && n.audience !== 'all') continue;
    if (n.actor_name && n.actor_name === u.full_name) continue;
    enqueue(u.zalo_chat_id, text);
  }
}

// ---------- Liên kết ----------
function createLinkCode(userId) {
  const u = q.get.get(userId);
  if (!u) throw Object.assign(new Error('Không tìm thấy tài khoản'), { status: 404 });
  for (const [c, v] of codes) if (v.userId === u.id || v.exp < Date.now()) codes.delete(c);
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (codes.has(code));
  const exp = Date.now() + CODE_TTL;
  codes.set(code, { userId: u.id, exp });
  return { code, expiresAt: new Date(exp).toISOString() };
}

function linkInfo(userId) {
  const u = q.get.get(userId);
  if (!u) return null;
  return { linked: !!u.zalo_chat_id, name: u.zalo_name || null, enabled: !!u.zalo_enabled };
}

function reply(chatId, text) { enqueue(chatId, text); }

function handleUpdate(up) {
  const m = up && up.message;
  if (!m || !m.chat || !m.chat.id) return;
  if (m.message_id) {
    if (seen.has(m.message_id)) return;
    seen.add(m.message_id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
  }
  if (m.chat.chat_type && m.chat.chat_type !== 'PRIVATE') return; // nhóm (beta): chưa hỗ trợ
  const chatId = String(m.chat.id);
  const name = (m.from && m.from.display_name) || null;
  const text = String(m.text || '').trim();
  const match = text.match(/\b(\d{6})\b/);
  if (match && codes.has(match[1])) {
    const c = codes.get(match[1]);
    codes.delete(match[1]);
    if (c.exp < Date.now()) return reply(chatId, 'Mã liên kết đã hết hạn. Nhờ quản lý tạo mã mới trên web.');
    const u = q.get.get(c.userId);
    if (!u) return reply(chatId, 'Tài khoản không còn tồn tại.');
    db.transaction(() => { q.unlinkChat.run(chatId, u.id); q.link.run(chatId, name, u.id); })();
    log(`liên kết ${u.full_name} ↔ ${name || chatId}`);
    return reply(chatId, `✅ Đã liên kết Zalo với tài khoản "${u.full_name}". Từ giờ thông báo của web sẽ gửi về đây.`);
  }
  const owner = q.byChat.get(chatId);
  if (owner) return reply(chatId, `Bot chỉ gửi thông báo của web cho "${owner.full_name}". Muốn tắt nhận tin, nhờ quản lý tắt ở trang Tài khoản nhân viên.`);
  reply(chatId, match ? 'Mã liên kết không đúng hoặc đã dùng. Nhờ quản lý tạo mã mới trên web.'
    : 'Chào bạn! Để nhận thông báo, nhờ quản lý lấy mã liên kết 6 số trên web (Hệ thống → Tài khoản nhân viên) rồi nhắn mã đó vào đây.');
}

// ---------- Vòng nhận tin ----------
async function pollLoop() {
  let backoff = 5000;
  while (!stopped) {
    try {
      const r = await call('getUpdates', { timeout: '30' }, 45000);
      state.polling = true; state.lastPollOk = new Date().toISOString(); backoff = 5000;
      for (const up of (Array.isArray(r) ? r : r ? [r] : [])) {
        try { handleUpdate(up); } catch (e) { fail('xử lý tin', e); }
      }
    } catch (e) {
      // 408 / hết giờ chờ = không có tin mới, hỏi lại ngay
      if (e.code === 408 || /timeout|hết thời gian/i.test(e.message)) { state.polling = true; state.lastPollOk = new Date().toISOString(); continue; }
      state.polling = false; fail('nhận tin', e);
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 5 * 60e3);
    }
  }
}

async function start() {
  if (!ENABLED) { if (TOKEN) log('tắt trên máy chủ thử'); return; }
  state.startedAt = new Date().toISOString();
  try {
    state.bot = await call('getMe');
    log(`bot sẵn sàng: ${botName() || '(không rõ tên)'}`);
  } catch (e) { fail('kiểm tra bot (getMe)', e); }
  pollLoop();
}

function botName() {
  const b = state.bot || {};
  return b.display_name || b.account_name || b.name || null;
}

async function sendTest(userId) {
  if (!ENABLED) throw Object.assign(new Error(TOKEN ? 'Bot đang tắt (máy chủ thử)' : 'Chưa cấu hình ZALO_BOT_TOKEN trong .env'), { status: 400 });
  const u = q.get.get(userId);
  if (!u || !u.zalo_chat_id) throw Object.assign(new Error('Tài khoản này chưa liên kết Zalo'), { status: 400 });
  await call('sendMessage', { chat_id: u.zalo_chat_id, text: `🔔 Tin thử từ web Chí Công Computer gửi tới "${u.full_name}" — nhận được là đã liên kết đúng.` });
  state.sent++; state.lastSentAt = new Date().toISOString();
}

function setEnabled(userId, on) { q.setEnabled.run(on ? 1 : 0, userId); return linkInfo(userId); }
function unlink(userId) { q.unlink.run(userId); return linkInfo(userId); }

function status() {
  return {
    configured: !!TOKEN, enabled: ENABLED, bot: botName(), polling: state.polling, lastPollOk: state.lastPollOk,
    lastError: state.lastError, lastErrorAt: state.lastErrorAt, sent: state.sent, failed: state.failed,
    lastSentAt: state.lastSentAt, queue: queue.length,
  };
}

module.exports = { start, onNotification, createLinkCode, linkInfo, sendTest, setEnabled, unlink, status, _handleUpdate: handleUpdate };
