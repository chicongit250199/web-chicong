'use strict';
// Thông báo qua Zalo Bot (https://bot.zapps.me/docs)
//  - Nhận tin bằng getUpdates (long polling): web chỉ chạy trong LAN nên không dùng webhook được
//  - Liên kết bằng mã 6 số: quản lý lấy mã cho 1 tài khoản (nhắn riêng cho bot) hoặc 1 đối tác (nhắn trong nhóm Zalo có bot)
//  - Gửi lần lượt qua hàng đợi; lỗi chỉ ghi log, không ảnh hưởng thông báo trong web
// Ai nhận gì (gọi từ events.notify, kèm meta { kind, taskId, userId }):
//  - Quản lý: giao dịch (bán hàng, trả máy thu tiền, thu nợ), sửa xong / không sửa được, yêu cầu nhập hàng
//  - Nhân viên: task mới; task được giao cho mình (chỉ người được giao)
//  - Nhóm Zalo đối tác: máy của đối tác đó bắt đầu sửa / sửa xong / không sửa được (lời lẽ gửi khách);
//    đối tác nhắn hỏi tên máy → bot tự trả lời tình trạng máy của đối tác đó (xem partnerAnswer)
//  - Nhân viên / quản lý nhắn riêng tên linh kiện → bot trả giá trong kho + bảng báo giá (xem priceAnswer)
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

const MANAGER_KINDS = new Set(['sale', 'task_completed', 'task_done', 'task_unrepairable', 'stock_request', 'debt_payment']);
const PARTNER_KINDS = new Set(['task_processing', 'task_done', 'task_unrepairable']);

const q = {
  users: db.prepare(`SELECT id, full_name, role, zalo_chat_id FROM users
    WHERE is_active = 1 AND zalo_enabled = 1 AND zalo_chat_id IS NOT NULL`),
  userByChat: db.prepare('SELECT id, full_name, is_active FROM users WHERE zalo_chat_id = ?'),
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

// Tin nội bộ (quản lý / nhân viên): nội dung thông báo trong web + link mở trang
function internalText(message, link) { link = absLink(link); return `🔔 ${message}${link ? '\n' + link : ''}`; }

function onNotification(n, meta) {
  if (!ENABLED || !n) return;
  meta = meta || {};
  const kind = meta.kind || n.type;
  try {
    const text = internalText(n.message, n.link);
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

function overdueText(name, rows) {
  const lines = rows.map(t => `• ${t.device_model} (${t.ticket_code}) — ${t.status === 'processing' ? 'đang sửa' : 'chưa làm'} ${String(Math.round(t.age * 10) / 10).replace('.', ',')} ngày`);
  return `⏰ ${name} có ${rows.length} task quá hạn:\n${lines.join('\n')}\n${absLink('/staff/tasks?view=overdue')}`;
}

function sendOverdue() {
  const ta = require('./taskAlerts');
  const list = db.prepare(`SELECT t.id, t.ticket_code, t.device_model, t.status, ${ta.AGE} AS age FROM tasks t
    WHERE t.assigned_to = ? AND ${ta.OVERDUE_WHERE} ORDER BY age DESC LIMIT 30`);
  let people = 0;
  for (const u of q.users.all()) {
    const rows = list.all(u.id);
    if (!rows.length) continue;
    enqueue(u.zalo_chat_id, overdueText(u.full_name, rows));
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


// ---------- Đối tác hỏi tình trạng máy ----------
// Chat đã liên kết với 1 đối tác (nhóm hoặc nhắn riêng) nhắn VD "main b760 sao rồi" → tìm trong máy của
// đúng đối tác đó (không bao giờ lộ máy của khách khác), trả lời trạng thái bằng lời gửi khách.
//  - Nhắn riêng: luôn trả lời. Trong nhóm: chỉ trả lời khi tin khớp máy (theo từ có số / mã phiếu)
//    hoặc có từ hỏi ("tình trạng", "xong chưa", "bot"...), để không chen vào chuyện khác của nhóm.
//  - Giới hạn số tin trả lời mỗi giờ cho mỗi chat (gói bot giới hạn tin/tháng).
const STOP = new Set(('a anh chi em oi a. ah nhe nha nhi voi cho hoi xin cai con chiec bo may main cua ben minh shop ' +
  'sao roi chua xong the nao gi vay vay. duoc khong ko k di la thi va cho toi tui tao minh dang da den bao gio khi nao ' +
  'tinh trang thai check kiem tra xem giup dum ho bot nay do kia').split(/\s+/));
const ASK_RE = /tinh trang|trang thai|xong chua|sao roi|the nao|bao gio|khi nao|check|kiem tra|\bbot\b|may cua (minh|em|toi|tui|anh|chi)/;
const REPLY_PER_HOUR = 20;
const replyLog = new Map(); // chatId → [mốc thời gian trả lời]

const pq = {
  tasks: db.prepare(`SELECT id, ticket_code, device_model, specs, issue_desc, status, final_price, fail_reason, created_at, completed_at
    FROM tasks WHERE partner_id = ? AND (status <> 'completed' OR completed_at >= ?)
    ORDER BY CASE status WHEN 'done' THEN 0 WHEN 'unrepairable' THEN 1 WHEN 'processing' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END, created_at DESC
    LIMIT 300`),
};

function words(text) { return (db.vn(text) || '').replace(/[^a-z0-9\-]+/g, ' ').split(/\s+/).filter(Boolean); }
const vnDate = iso => { const d = new Date(new Date(iso).getTime() + 7 * 3600e3); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };

function taskLine(t) {
  const dev = `${t.device_model} (${t.ticket_code}, nhận ${vnDate(t.created_at)})`;
  if (t.status === 'pending') return `⏳ ${dev}: đang chờ sửa.`;
  if (t.status === 'processing') return `🔧 ${dev}: đang sửa.`;
  if (t.status === 'done') return `✅ ${dev}: đã sửa xong${t.final_price ? ` — chi phí ${fmt.money(t.final_price)}` : ''}, mời qua nhận máy.`;
  if (t.status === 'unrepairable') return `⚠️ ${dev}: không sửa được${t.fail_reason ? ' (' + t.fail_reason + ')' : ''}, mời qua nhận lại máy.`;
  return `☑️ ${dev}: đã trả máy ngày ${vnDate(t.completed_at)}.`;
}

// Trả về lời trả lời, hoặc null nếu (trong nhóm) tin không phải câu hỏi về máy
function partnerAnswer(partner, text, isGroup) {
  const norm = (db.vn(text) || '').replace(/\s+/g, ' ');
  const asked = ASK_RE.test(norm);
  const terms = [...new Set(words(text).filter(w => !STOP.has(w) && (w.length >= 2 || /\d/.test(w))))];
  const strong = terms.filter(w => /\d/.test(w) || w.length >= 4); // từ có số (b760, 3060...) / mã phiếu / tên hãng
  const since = new Date(Date.now() - 60 * 86400e3).toISOString(); // máy đã trả: chỉ tính 60 ngày gần đây
  const all = pq.tasks.all(partner.id, since);
  let hits = [];
  if (terms.length) {
    const scored = all.map(t => {
      const hay = ' ' + words(`${t.device_model} ${t.specs || ''} ${t.issue_desc} ${t.ticket_code}`).join(' ') + ' ';
      const has = w => hay.includes(' ' + w) || (/\d/.test(w) && w.length >= 3 && hay.includes(w));
      return { t, n: terms.filter(has).length, strongHit: strong.some(has) };
    }).filter(x => x.n);
    const best = Math.max(0, ...scored.map(x => x.n));
    hits = scored.filter(x => x.n === best);
    if (isGroup && !asked && !hits.some(x => x.strongHit)) return null;
    hits = hits.map(x => x.t);
  } else if (isGroup && !asked) return null;

  const shop = settings.get('company_name') || 'Chí Công Computer';
  const active = all.filter(t => t.status !== 'completed');
  const list = (rows, max) => rows.slice(0, max).map(taskLine).join('\n') + (rows.length > max ? `\n… và ${rows.length - max} máy khác.` : '');
  if (hits.length) return `${shop} gửi ${partner.name} — tình trạng máy:\n${list(hits, 8)}`;
  if (!terms.length) return active.length ? `${shop} gửi ${partner.name} — các máy đang ở cửa hàng:\n${list(active, 10)}`
    : `${shop}: hiện không có máy nào của ${partner.name} đang ở cửa hàng.`;
  return `${shop}: không tìm thấy máy nào của ${partner.name} khớp "${text.slice(0, 60)}".` +
    (active.length ? `\nCác máy đang ở cửa hàng:\n${list(active, 10)}` : '') + '\nCần hỗ trợ thêm xin gọi cửa hàng.';
}

// ---------- Nhân viên / quản lý hỏi giá linh kiện ----------
// Tài khoản đã liên kết nhắn riêng VD "giá ram 8gb", "kho i3 7100", "báo giá main h510":
//  - Kho: hàng còn trong kho (gộp theo tên + tình trạng + giá) — số lượng, giá KT, giá lẻ
//  - Báo giá: bảng giá linh kiện (Build PC) — giá, tình trạng, bảo hành, số đang có trong kho
// Có chữ "kho"/"tồn" → chỉ tra kho; "báo giá"/"bg" → chỉ bảng báo giá; còn lại tra cả hai.
// Mọi từ khóa phải khớp (không dấu, bỏ - . /), VD "i3 7100" khớp "CPU I3-7100".
const PRICE_STOP = new Set(('gia bao nhieu bn bg con khong ko k hang kho ton trong cho hoi xem check tim ban co mot cai chiec may ' +
  'nhe nha a oi em anh chi de la the nao gi vay linh kien lk sp san pham giup voi di thi va').split(/\s+/));
const PRICE_MAX = 12;
const pr = {
  inv: db.prepare(`SELECT name, item_code, condition, tech_price, retail_price, COUNT(*) AS qty FROM inventory_items
    WHERE status = 'in_stock' GROUP BY name, condition, tech_price, retail_price ORDER BY name`),
  parts: db.prepare('SELECT id, category, name, condition, price, warranty_months, note_public FROM pc_parts WHERE hidden = 0 ORDER BY category, sort, id'),
};
const flat = t => ' ' + (db.vn(t) || '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

function priceAnswer(user, text) {
  const norm = flat(text);
  const onlyQuote = / bao gia | bg /.test(norm), onlyStock = !onlyQuote && / (kho|ton) /.test(norm);
  const terms = [...new Set(norm.trim().split(' ').filter(w => w && !PRICE_STOP.has(w)))];
  if (!terms.length) {
    return `Chào ${user.full_name}! Nhắn tên linh kiện để tra giá, VD:\n• giá ram 8gb\n• kho i3 7100 (chỉ hàng trong kho)\n• báo giá main h510 (chỉ bảng báo giá)`;
  }
  const hit = hay => terms.every(w => hay.includes(' ' + w) || (/\d/.test(w) && hay.includes(w)));
  const more = (n, link) => n > PRICE_MAX ? `\n… và ${n - PRICE_MAX} món khác — xem đủ: ${absLink(link)}` : '';
  const out = [];
  if (!onlyQuote) {
    const rows = pr.inv.all().filter(r => hit(flat(`${r.name} ${r.item_code || ''} ${r.condition || ''}`)));
    out.push(rows.length
      ? `📦 Kho còn hàng (${rows.reduce((a, r) => a + r.qty, 0)} món):\n` + rows.slice(0, PRICE_MAX).map(r =>
          `• ${r.name}${r.condition ? ` (${r.condition})` : ''} ×${r.qty} — KT ${r.tech_price != null ? fmt.money(r.tech_price) : '?'} · Lẻ ${r.retail_price != null ? fmt.money(r.retail_price) : '?'}`).join('\n')
        + more(rows.length, '/staff/inventory?q=' + encodeURIComponent(terms.join(' ')))
      : '📦 Kho: không có hàng khớp.');
  }
  if (!onlyStock) {
    const rows = pr.parts.all().filter(r => hit(flat(`${r.category} ${r.name} ${r.condition || ''}`)));
    let stock = new Map();
    try { stock = require('./pcParts').stockInfo().byPart; } catch (e) { fail('đếm tồn kho báo giá', e); }
    out.push(rows.length
      ? '💲 Báo giá linh kiện:\n' + rows.slice(0, PRICE_MAX).map(r => {
          const q = stock.get(r.id);
          return `• [${r.category}] ${r.name}${r.condition ? ` (${r.condition})` : ''} — ${r.price != null ? fmt.money(r.price) : 'liên hệ'}`
            + `${r.warranty_months ? ` · BH ${r.warranty_months} tháng` : ''}${r.note_public ? ` · ${r.note_public}` : ''} · ${q && q.qty ? `kho có ${q.qty}` : 'kho hết'}`;
        }).join('\n') + more(rows.length, '/staff/build')
      : '💲 Báo giá: không có linh kiện khớp.');
  }
  return `🔍 "${text.replace(/\s+/g, ' ').slice(0, 60)}"\n${out.join('\n\n')}`;
}

function canReply(chatId, perHour = REPLY_PER_HOUR) {
  const now = Date.now(), arr = (replyLog.get(chatId) || []).filter(x => now - x < 3600e3);
  if (arr.length >= perHour) { replyLog.set(chatId, arr); return false; }
  arr.push(now); replyLog.set(chatId, arr);
  if (replyLog.size > 500) replyLog.delete(replyLog.keys().next().value);
  return true;
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
      ? `✅ Đã liên kết Zalo với tài khoản "${row.name}". Từ giờ thông báo của web sẽ gửi về đây; muốn tra giá linh kiện thì nhắn tên linh kiện (VD: \"giá ram 8gb\").`
      : `✅ Đã liên kết với đối tác "${row.name}". Nhóm sẽ nhận thông báo khi máy của ${row.name} bắt đầu sửa và sửa xong; muốn hỏi tình trạng máy thì nhắn tên máy (VD: "main b760 sao rồi").`);
  }
  const partner = q.partnerByChat.get(chatId);
  if (partner && text) {
    const ans = partnerAnswer(partner, text, isGroup);
    if (ans && canReply(chatId)) { log(`trả lời ${partner.name}: "${text.slice(0, 60)}"`); enqueue(chatId, ans); }
    return;
  }
  if (isGroup) return; // nhóm chưa liên kết: chỉ phản hồi mã liên kết, không làm phiền
  const owner = q.userByChat.get(chatId);
  if (owner) {
    if (!owner.is_active) return enqueue(chatId, 'Tài khoản này đã bị khóa trên web.');
    if (text && canReply(chatId, 60)) { log(`tra giá cho ${owner.full_name}: "${text.slice(0, 60)}"`); enqueue(chatId, priceAnswer(owner, text)); }
    return;
  }
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

module.exports = { start, onNotification, createLinkCode, linkInfo, sendTest, setEnabled, unlink, status, setOverdueAt, partnerAnswer, priceAnswer, sendOverdue };
