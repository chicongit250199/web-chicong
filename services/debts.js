'use strict';
// CÔNG NỢ (xem db/migrations/020_debts.sql)
//  - Nợ phát sinh = các dòng doanh thu payment_method 'debt' (doanh thu tính lúc bán)
//  - Tiền khách trả = debt_payments (trả trước lúc mua + thu nợ về sau), không cộng doanh thu lần 2
//  - Gộp theo người nợ (debtor_key): đối tác 'p:<id>' (mọi task / đơn của đối tác gộp chung), khách lẻ 'c:<SĐT>' hoặc 'n:<tên>'
const db = require('../db');
const partners = require('./partners');

const digits = s => String(s || '').replace(/\D/g, '');
const squash = s => db.vn(String(s || '')).replace(/[^a-z0-9]/g, '');
const httpErr = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Khóa người nợ. partnerId: đã biết (task) — không có thì tự nhận diện đối tác theo tên / SĐT
function keyFor({ partnerId, name, phone }) {
  const pid = partnerId || partners.detect(name, phone);
  if (pid) return `p:${pid}`;
  const ph = digits(phone);
  if (ph.length >= 8) return `c:${ph}`;
  const n = squash(name);
  if (n.length >= 2) return `n:${n}`;
  return null;
}
const NEED_CUSTOMER = 'Ghi nợ cần tên hoặc SĐT khách (để gộp công nợ).';

// Chia tiền đơn: paid = khách trả ngay. Trả đủ -> không nợ. Trả thiếu -> cả đơn ghi 'debt', phần trả ngay ghi vào debt_payments.
// Trả về { method (cho dòng doanh thu), upfront (số tiền trả trước, 0 nếu không) }
function split(total, paymentMethod, paid, paidMethod) {
  if (paymentMethod !== 'debt') return { method: paymentMethod, upfront: 0 };
  const p = Math.max(0, Number(paid) || 0);
  if (p >= total) return { method: paidMethod || 'cash', upfront: 0 }; // trả đủ thì không còn là nợ
  return { method: 'debt', upfront: p };
}

const q = {
  setKey: db.prepare(`UPDATE revenues SET debtor_key = ? WHERE order_code = ? AND payment_method = 'debt'`),
  insPay: db.prepare(`INSERT INTO debt_payments (debtor_key, amount, payment_method, order_code, note, staff_name, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`),
  owed: db.prepare(`SELECT debtor_key k, COALESCE(SUM(amount),0) s, COUNT(DISTINCT COALESCE(order_code, id)) n, MAX(created_at) last
                    FROM revenues WHERE payment_method = 'debt' AND debtor_key IS NOT NULL GROUP BY debtor_key`),
  paid: db.prepare(`SELECT debtor_key k, COALESCE(SUM(amount),0) s, MAX(created_at) last FROM debt_payments GROUP BY debtor_key`),
  lastCustomer: db.prepare(`SELECT customer_name, customer_phone FROM revenues WHERE debtor_key = ? ORDER BY id DESC LIMIT 1`),
  partner: db.prepare('SELECT id, name, phones FROM partners WHERE id = ?'),
  charges: db.prepare(`SELECT order_code, MIN(created_at) created_at, GROUP_CONCAT(content, ' · ') content, SUM(amount) amount,
                         MAX(staff_name) staff_name, MAX(customer_name) customer_name, MAX(customer_phone) customer_phone,
                         MAX(CASE WHEN type = 'repair' THEN ref_id END) task_id, MIN(id) id
                       FROM revenues WHERE debtor_key = ? AND payment_method = 'debt' GROUP BY COALESCE(order_code, id) ORDER BY created_at DESC`),
  payments: db.prepare('SELECT * FROM debt_payments WHERE debtor_key = ? ORDER BY created_at DESC'),
  getPay: db.prepare('SELECT * FROM debt_payments WHERE id = ?'),
  delPay: db.prepare('DELETE FROM debt_payments WHERE id = ?'),
  orphans: db.prepare(`DELETE FROM debt_payments WHERE order_code IS NOT NULL
                       AND order_code NOT IN (SELECT order_code FROM revenues WHERE order_code IS NOT NULL)`),
};

// Sau khi ghi đơn nợ (trong cùng transaction): gắn khóa người nợ + ghi tiền trả trước
function recordOrder({ key, orderCode, upfront, upfrontMethod, staff, now }) {
  q.setKey.run(key, orderCode);
  if (upfront > 0) q.insPay.run(key, upfront, upfrontMethod || 'cash', orderCode, 'Trả trước khi mua', staff, now);
}

// Xóa doanh thu xong: bỏ tiền trả trước của các đơn không còn dòng doanh thu nào
function cleanupOrphans() { return q.orphans.run().changes; }

function label(key) {
  if (key.startsWith('p:')) {
    const p = q.partner.get(Number(key.slice(2)));
    if (p) return { name: p.name, phone: p.phones || '', partnerId: p.id };
  }
  const c = q.lastCustomer.get(key) || {};
  return { name: c.customer_name || (key.startsWith('c:') ? '' : key.slice(2)), phone: c.customer_phone || (key.startsWith('c:') ? key.slice(2) : ''), partnerId: null };
}

// Danh sách người nợ. all = cả người đã trả hết
function list({ all = false, search = '' } = {}) {
  const map = new Map();
  for (const r of q.owed.all()) map.set(r.k, { key: r.k, owed: r.s, orders: r.n, last: r.last, paid: 0 });
  for (const r of q.paid.all()) {
    const d = map.get(r.k) || { key: r.k, owed: 0, orders: 0, last: null, paid: 0 };
    d.paid = r.s; if (!d.last || r.last > d.last) d.last = r.last;
    map.set(r.k, d);
  }
  const s = db.vn(search.trim());
  const out = [];
  for (const d of map.values()) {
    d.balance = d.owed - d.paid;
    if (!all && d.balance === 0) continue;
    Object.assign(d, label(d.key));
    if (s && !db.vn(`${d.name} ${d.phone}`).includes(s)) continue;
    out.push(d);
  }
  out.sort((a, b) => b.balance - a.balance || String(b.last).localeCompare(String(a.last)));
  return out;
}

function totals() {
  const owed = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM revenues WHERE payment_method = 'debt'`).get().s;
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM debt_payments').get().s;
  return { owed, paid, balance: owed - paid };
}

function balanceOf(key) {
  const o = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM revenues WHERE debtor_key = ? AND payment_method = 'debt'`).get(key).s;
  const p = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM debt_payments WHERE debtor_key = ?').get(key).s;
  return { owed: o, paid: p, balance: o - p };
}

// Chi tiết 1 người nợ: các đơn nợ + các lần trả, sắp theo thời gian
function detail(key) {
  if (!/^[pcn]:.+/.test(key || '')) return null;
  const charges = q.charges.all(key);
  const payments = q.payments.all(key);
  if (!charges.length && !payments.length) return null;
  return { key, ...label(key), ...balanceOf(key), charges, payments };
}

// Thu nợ
function pay(key, { amount, payment_method, note }, staff) {
  const d = detail(key);
  if (!d) throw httpErr('Không tìm thấy công nợ', 404);
  if (!Number.isInteger(amount) || amount <= 0) throw httpErr('Nhập số tiền thu');
  if (!['cash', 'transfer'].includes(payment_method)) throw httpErr('Chọn hình thức thanh toán');
  if (amount > d.balance) throw httpErr(`Số tiền thu lớn hơn số còn nợ (${d.balance.toLocaleString('vi-VN')} ₫)`);
  q.insPay.run(key, amount, payment_method, null, note || null, staff, new Date().toISOString());
  return { ...d, ...balanceOf(key) };
}

function deletePayment(id) {
  const p = q.getPay.get(id);
  if (!p) throw httpErr('Không tìm thấy lần trả', 404);
  q.delPay.run(id);
  return p;
}

// Thêm / sửa đối tác: nợ của khách lẻ khớp với đối tác thì chuyển sang gộp vào đối tác
function relinkPartners() {
  const keys = db.prepare(`SELECT DISTINCT debtor_key k FROM revenues WHERE debtor_key LIKE 'c:%' OR debtor_key LIKE 'n:%'`).all().map(r => r.k);
  const list = partners.matchers();
  let moved = 0;
  db.transaction(() => {
    for (const k of keys) {
      const c = q.lastCustomer.get(k);
      const pid = c && partners.detect(c.customer_name, c.customer_phone, list);
      if (!pid) continue;
      const nk = `p:${pid}`;
      db.prepare('UPDATE revenues SET debtor_key = ? WHERE debtor_key = ?').run(nk, k);
      db.prepare('UPDATE debt_payments SET debtor_key = ? WHERE debtor_key = ?').run(nk, k);
      moved++;
    }
  })();
  return moved;
}

// Số còn nợ của từng đối tác (trang Khách đối tác)
function partnerBalances() {
  const m = new Map();
  for (const d of list({ all: true })) if (d.key.startsWith('p:')) m.set(Number(d.key.slice(2)), d.balance);
  return m;
}

module.exports = { label, keyFor, NEED_CUSTOMER, split, recordOrder, cleanupOrphans, list, totals, detail, pay, deletePayment, relinkPartners, partnerBalances, balanceOf };
