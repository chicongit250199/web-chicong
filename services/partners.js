'use strict';
// Khách đối tác: nhận diện task thuộc đối tác nào theo tên khách (bỏ dấu, bỏ khoảng trắng) hoặc SĐT
const db = require('../db');

const squash = s => db.vn(String(s || '')).replace(/[^a-z0-9]/g, '');
const digits = s => String(s || '').replace(/\D/g, '');
const splitList = s => String(s || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);

function matchers() {
  return db.prepare('SELECT * FROM partners ORDER BY id').all().map(p => ({
    id: p.id,
    // tên dài khớp trước ("Quốc Computer 2" trước "Quốc Computer")
    keys: [p.name, ...splitList(p.aliases)].map(squash).filter(k => k.length >= 3).sort((a, b) => b.length - a.length),
    phones: splitList(p.phones).map(digits).filter(d => d.length >= 8),
  }));
}

function detect(name, phone, list = matchers()) {
  const n = squash(name); const ph = digits(phone);
  let best = null; let bestLen = 0;
  for (const m of list) {
    if (ph && m.phones.includes(ph)) return m.id;
    for (const k of m.keys) if (n && n.includes(k) && k.length > bestLen) { best = m.id; bestLen = k.length; }
  }
  return best;
}

// Xếp lại toàn bộ task (gọi sau khi thêm / sửa / xóa đối tác)
function reclassify() {
  const list = matchers();
  const upd = db.prepare('UPDATE tasks SET partner_id = ? WHERE id = ?');
  let n = 0;
  db.transaction(() => {
    for (const t of db.prepare('SELECT id, customer_name, customer_phone, partner_id FROM tasks').all()) {
      const pid = detect(t.customer_name, t.customer_phone, list);
      if (pid !== t.partner_id) { upd.run(pid, t.id); n++; }
    }
  })();
  return n;
}

// Gợi ý đối tác: tên khách (task + doanh thu) có chữ kiểu cửa hàng, chưa thuộc đối tác nào
const SHOP = /computer|comp\b|store|shop|\bpc\b|laptop|mobile|tech|cong nghe|may tinh|dien thoai|ccpt|\bkt\b/;
function suggestions() {
  const list = matchers();
  const names = db.prepare(`SELECT customer_name AS name, MAX(customer_phone) AS phone, COUNT(*) AS n FROM (
      SELECT customer_name, customer_phone FROM tasks UNION ALL SELECT customer_name, customer_phone FROM revenues)
      WHERE customer_name IS NOT NULL AND TRIM(customer_name) <> '' GROUP BY lower(trim(customer_name)) ORDER BY n DESC`).all();
  const seen = new Set();
  return names.filter(r => {
    const k = squash(r.name);
    if (seen.has(k) || !SHOP.test(db.vn(r.name))) return false;
    seen.add(k);
    return !detect(r.name, null, list);
  }).slice(0, 20);
}

module.exports = { detect, reclassify, suggestions, splitList, squash, matchers };
