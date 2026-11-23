'use strict';
// Thông báo qua Zalo Bot (https://bot.zapps.me/docs)
//  - Nhận tin bằng getUpdates (long polling): web chỉ chạy trong LAN nên không dùng webhook được
//  - Liên kết bằng mã 6 số: quản lý lấy mã cho 1 tài khoản (nhắn riêng cho bot) hoặc 1 đối tác (nhắn trong nhóm Zalo có bot)
//  - Gửi lần lượt qua hàng đợi; lỗi chỉ ghi log, không ảnh hưởng thông báo trong web
// Ai nhận gì (gọi từ events.notify, kèm meta { kind, taskId, userId }):
//  - Quản lý: giao dịch (bán hàng, trả máy thu tiền), sửa xong / không sửa được, yêu cầu nhập hàng
//  - Nhân viên: task mới; task được giao cho mình (chỉ người được giao)
//  - Nhóm Zalo đối tác: máy của đối tác đó bắt đầu sửa / sửa xong / không sửa được (lời lẽ gửi khách)
//  - Mỗi ngày lúc giờ đặt (mặc định 8:00, trừ Chủ nhật): danh sách task quá hạn đang giao cho từng người
//  - Các thông báo thay đổi khác gửi ngay lúc thay đổi
//  - Không gửi cho chính người vừa làm thao tác
// Token trong .env (ZALO_BOT_TOKEN), nằm trong URL API → không bao giờ ghi URL ra log.
// Server thử (BACKUP_DISABLED=true) tắt bot, trừ khi đặt ZALO_API_BASE (trỏ tới server giả để test).
const db = require('../db');
const settings = require('./settings');
const fmt = require('./format');

const TOKEN = (process.env.ZALO_BOT_TOKEN || '').trim();
const BASE = (process.env.ZALO_API_BASE || 'https://bot-api.zaloplatforms.com').replace(/\/+$/, '');
const PUBLIC_URL = (process.env.PUBLIC_BASE_URL || 'http://chicongcomputer.local').replace(/\/+$/, '');
const ENABLED = !!TOKEN && (process.env.BACKUP_DISABLED !== 'true' || !!process.env.ZALO_API_BASE);
const MAX_TEXT = 2000, CODE_TTL = 15 * 60e3, MAX_QUEUE = 300, GAP_MS = 350;
const DEF_OVERDUE_AT = '08:00';

const MANAGER_KINDS = new Set(['sale', 'task_completed', 'task_done', 'task_unrepairable', 'stock_request']);
const PARTNER_KINDS = new Set(['task_processing', 'task_done', 'task_unrepairable']);

const q = {
  users: db.prepare(`SELECT id, full_name, role, zalo_chat_id FROM users
    WHERE is_active = 1 AND zalo_enabled = 1 AND zalo_chat_id IS NOT NULL`),
  userByChat: db.prepare('SELECT id, full_name FROM users WHERE zalo_chat_id = ?'),
  partnerByChat: db.prepare('SELECT id, name FROM partners WHERE zalo_chat_id = ?'),
  user: db.prepare('SELECT id, full_name AS name, is_active, zalo_chat_id, zalo_name, zalo_enabled FROM users WHERE id = ?'),
  partner: db.prepare('SELECT id, name, zalo_chat_id, zalo_name, zalo_enabled FROM partners WHERE id = ?'),
  task: db.prepare(`SELECT t.*, p.zalo_chat_id AS p_chat, p.zalo_enabled AS p_on FROM tasks t
    LEFT JOIN partners p ON p.id = t.partner_id WHERE t.id = ?`),
};
// Câu lệnh theo loại đích (users / partners) — tên bảng cố định, không lấy từ người dùng
const T = {};
for (const table of ['users', 'partners']) {
  T[table] = {
    link: db.prepare(`UPDATE ${table} SET zalo_chat_id = ?, zalo_name = ?, zalo_enabled = 1 WHERE id = ?`),
    unlink: db.prepare(`UPDATE ${table} SET zalo_chat_id = NULL, zalo_name = NULL WHERE id = ?`),
    freeChat: db.prepare(`UPDATE ${table} SET zalo_chat_id = NULL, zalo_name = NULL WHERE zalo_chat_id = ?`),
    setEnabled: db.prepare(`UPDATE ${table} SET zalo_enabled = ? WHERE id = ?`),
  };
}
const TARGET = { user: { table: 'users', get: id => q.user.get(id) }, partner: { table: 'partners', get: id => q.partner.get(id) } };

const state = {
  bot: null, polling: false, lastPollOk: null, lastError: null, lastErrorAt: null,
  sent: 0, failed: 0, lastSentAt: null, lastOverdue: null,
};
const codes = new Map(); // mã → { kind: 'user' | 'partner', id, exp }
const queue = [];
let sending = false;
const seen = new Set(); // message_id đã xử lý (phòng getUpdates trả lặp)

function log(...a) { console.log('[zalo]', ...a); }
function fail(where, e) {
  state.lastError = `${where}: ${e.message || e}`.slice(0, 300);
  state.lastErrorAt = new Date().toISOString();
  console.error('[zalo]', state.lastError);
}
const httpErr = (msg, status = 400) => Object.assign(new Error(msg), { status });

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

// Lời nhắn gửi nhóm đối tác (khách đọc — không kèm link nội bộ, không tên nhân viên)
function partnerText(kind, t) {
  const shop = settings.get('company_name') || 'Chí Công Computer';
  const dev = `${t.device_model} (phiếu ${t.ticket_code})`;
  if (kind === 'task_processing') return `🔧 ${shop} đã bắt đầu sửa ${dev}.`;
  if (kind === 'task_done') return `✅ ${shop} đã sửa xong ${dev}${t.final_price ? ` — chi phí ${fmt.money(t.final_price)}` : ''}. Mời anh/chị qua nhận máy.`;
  if (kind === 'task_unrepairable') return `⚠️ ${dev} không sửa được${t.fail_reason ? ': ' + t.fail_reason : ''}. Mời anh/chị qua nhận lại máy.`;
  return null;
}

function onNotification(n, meta) {
  if (!ENABLED || !n) return;
  meta = meta || {};
  const kind = meta.kind || n.type;
  try {
    const link = absLink(n.link);
    const text = `🔔 ${n.message}${link ? '\n' + link : ''}`;
    for (const u of q.users.all()) {
      if (n.actor_name && n.actor_name === u.full_name) continue;
      const want = kind === 'task_assigned' ? u.id === meta.userId
        : u.role === 'manager' ? MANAGER_KINDS.has(kind)
        : kind === 'task_new';
      if (want) enqueue(u.zalo_chat_id, text);
    }
    if (PARTNER_KINDS.has(kind) && meta.taskId) {
      const t = q.task.get(meta.taskId);
      if (t && t.p_chat && t.p_on) enqueue(t.p_chat, partnerText(kind, t));
    }
  } catch (e) { fail('chọn người nhận', e); }
}

// ---------- Nhắc task quá hạn: mỗi ngày 1 lần lúc giờ đặt (mặc định 8:00), trừ Chủ nhật ----------
function overdueAt() { const v = settings.get('zalo_overdue_at'); return /^\d{2}:\d{2}$/.test(v || '') ? v : DEF_OVERDUE_AT; }
function setOverdueAt(at) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(at || ''))) throw httpErr('Giờ không hợp lệ');
  settings.set({ zalo_overdue_at: at });
  return status();
}
function vnNow() { const d = new Date(Date.now() + 7 * 3600e3); return { ymd: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16), dow: d.getUTCDay() }; }

function sendOverdue() {
  const ta = require('./taskAlerts');
  const list = db.prepare(`SELECT t.id, t.ticket_code, t.device_model, t.status, ${ta.AGE} AS age FROM tasks t
    WHERE t.assigned_to = ? AND ${ta.OVERDUE_WHERE} ORDER BY age DESC LIMIT 30`);
  let people = 0;
  for (const u of q.users.all()) {
    const rows = list.all(u.id);
    if (!rows.length) continue;
    const lines = rows.map(t => `• ${t.device_model} (${t.ticket_code}) — ${t.status === 'processing' ? 'đang sửa' : 'chưa làm'} ${String(Math.round(t.age * 10) / 10).replace('.', ',')} ngày`);
    enqueue(u.zalo_chat_id, `⏰ ${u.full_name} có ${rows.length} task quá hạn:\n${lines.join('\n')}\n${absLink('/staff/tasks?view=overdue')}`);
    people++;
  }
  state.lastOverdue = { at: new Date().toISOString(), people };
  return people;
}

function scheduleOverdue() {
  setInterval(() => {
    const n = vnNow();
    // tới giờ (hoặc web vừa khởi động lại sau giờ đó, trước 21:00) và hôm nay chưa gửi; Chủ nhật nghỉ
    if (n.dow === 0 || n.hm < overdueAt() || n.hm >= '21:00' || settings.get('zalo_overdue_last') === n.ymd) return;
    settings.set({ zalo_overdue_last: n.ymd });
    try { log(`cảnh báo task quá hạn: gửi ${sendOverdue()} người`); } catch (e) { fail('cảnh báo quá hạn', e); }
  }, 20e3).unref();
}


// Gửi tin tự soạn (mục Thử tin nhắn): target 'user:ID' | 'partner:ID'
async function sendCustom(targetKey, text) {
  if (!ENABLED) throw httpErr(TOKEN ? 'Bot đang tắt (máy chủ thử)' : 'Chưa cấu hình ZALO_BOT_TOKEN trong .env');
  const [kind, id] = String(targetKey || '').split(':');
  const msg = String(text || '').trim();
  if (!msg) throw httpErr('Nhập nội dung tin nhắn');
  const { row } = target(kind, Number(id));
  if (!row.zalo_chat_id) throw httpErr('Chưa liên kết Zalo');
  await call('sendMessage', { chat_id: row.zalo_chat_id, text: clip(msg) });
  state.sent++; state.lastSentAt = new Date().toISOString();
  return { to: row.zalo_name || row.name };
}

// ---------- Liên kết ----------
function target(kind, id) {
  const t = TARGET[kind];
  const row = t && t.get(id);
  if (!row) throw httpErr('Không tìm thấy', 404);
  return { ...t, row };
}

function createLinkCode(kind, id) {
  const { row } = target(kind, id);
  for (const [c, v] of codes) if ((v.kind === kind && v.id === row.id) || v.exp < Date.now()) codes.delete(c);
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (codes.has(code));
  const exp = Date.now() + CODE_TTL;
  codes.set(code, { kind, id: row.id, exp });
  return { code, expiresAt: new Date(exp).toISOString() };
}

function linkInfo(kind, id) {
  const { row } = target(kind, id);
  return { linked: !!row.zalo_chat_id, name: row.zalo_name || null, enabled: !!row.zalo_enabled };
}

function handleUpdate(up) {
  const m = up && up.message;
  if (!m || !m.chat || !m.chat.id) return;
  if (m.message_id) {
    if (seen.has(m.message_id)) return;
    seen.add(m.message_id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
  }
  const chatId = String(m.chat.id);
  const isGroup = !!m.chat.chat_type && m.chat.chat_type !== 'PRIVATE';
  const sender = (m.from && m.from.display_name) || null;
  const chatName = isGroup ? (m.chat.display_name || m.chat.name || 'Nhóm Zalo') : sender;
  const text = String(m.text || '').trim();
  const match = text.match(/\b(\d{6})\b/);
  const c = match && codes.get(match[1]);
  if (c) {
    codes.delete(match[1]);
    if (c.exp < Date.now()) return enqueue(chatId, 'Mã liên kết đã hết hạn. Nhờ quản lý tạo mã mới trên web.');
    if (c.kind === 'user' && isGroup) return enqueue(chatId, 'Mã này dùng cho tài khoản nhân viên — hãy nhắn riêng cho bot, không nhắn trong nhóm. Nhờ quản lý tạo mã mới.');
    let row;
    try { row = target(c.kind, c.id).row; } catch { return enqueue(chatId, 'Không còn tồn tại trên web.'); }
    const t = TARGET[c.kind];
    db.transaction(() => { T.users.freeChat.run(chatId); T.partners.freeChat.run(chatId); T[t.table].link.run(chatId, chatName, row.id); })();
    log(`liên kết ${c.kind === 'user' ? 'tài khoản' : 'đối tác'} ${row.name} ↔ ${chatName || chatId}`);
    return enqueue(chatId, c.kind === 'user'
      ? `✅ Đã liên kết Zalo với tài khoản "${row.name}". Từ giờ thông báo của web sẽ gửi về đây.`
      : `✅ Đã liên kết với đối tác "${row.name}". Nhóm sẽ nhận thông báo khi máy của ${row.name} bắt đầu sửa và sửa xong.`);
  }
  if (isGroup) return; // trong nhóm chỉ phản hồi mã liên kết, không làm phiền
  const owner = q.userByChat.get(chatId) || q.partnerByChat.get(chatId);
  if (owner) return enqueue(chatId, `Bot chỉ gửi thông báo tự động cho "${owner.full_name || owner.name}", không đọc tin nhắn. Cần hỗ trợ xin liên hệ cửa hàng.`);
  enqueue(chatId, match ? 'Mã liên kết không đúng hoặc đã dùng. Nhờ quản lý tạo mã mới trên web.'
    : 'Chào bạn! Bot gửi thông báo tự động của cửa hàng. Để nhận thông báo, nhắn mã liên kết 6 số (quản lý lấy trên web) vào đây.');
}

// ---------- Vòng nhận tin ----------
async function pollLoop() {
  let backoff = 5000;
  for (;;) {
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
  try {
    state.bot = await call('getMe');
    log(`bot sẵn sàng: ${botName() || '(không rõ tên)'} · nhắc task quá hạn lúc ${overdueAt()} (trừ CN)`);
  } catch (e) { fail('kiểm tra bot (getMe)', e); }
  pollLoop();
  scheduleOverdue();
}

function botName() {
  const b = state.bot || {};
  return b.display_name || b.account_name || null;
}

async function sendTest(kind, id) {
  if (!ENABLED) throw httpErr(TOKEN ? 'Bot đang tắt (máy chủ thử)' : 'Chưa cấu hình ZALO_BOT_TOKEN trong .env');
  const { row } = target(kind, id);
  if (!row.zalo_chat_id) throw httpErr('Chưa liên kết Zalo');
  await call('sendMessage', { chat_id: row.zalo_chat_id, text: `🔔 Tin thử từ ${settings.get('company_name') || 'Chí Công Computer'} gửi tới "${row.name}" — nhận được là đã liên kết đúng.` });
  state.sent++; state.lastSentAt = new Date().toISOString();
}

function setEnabled(kind, id, on) { const t = target(kind, id); T[t.table].setEnabled.run(on ? 1 : 0, t.row.id); return linkInfo(kind, id); }
function unlink(kind, id) { const t = target(kind, id); T[t.table].unlink.run(t.row.id); return linkInfo(kind, id); }

function status() {
  return {
    configured: !!TOKEN, enabled: ENABLED, bot: botName(), polling: state.polling, lastPollOk: state.lastPollOk,
    lastError: state.lastError, lastErrorAt: state.lastErrorAt, sent: state.sent, failed: state.failed,
    lastSentAt: state.lastSentAt, queue: queue.length, overdueAt: overdueAt(), lastOverdue: state.lastOverdue,
  };
}

module.exports = { start, onNotification, createLinkCode, linkInfo, sendTest, setEnabled, unlink, status, sendCustom, setOverdueAt, sendOverdue };
