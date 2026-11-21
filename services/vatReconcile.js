'use strict';
// Đối chiếu HĐ bán ra với tồn kho VAT đầu vào: ghép tên hàng (ưu tiên mã model), trừ tồn FIFO
const db = require('../db');

const EPS = 1e-9;

// Chuẩn hóa: bỏ dấu, chữ thường, gom ' '' " về một kiểu
function norm(s) {
  return db.vn(String(s || '')).replace(/[''`´]{2}|["“”]/g, ' inch ').replace(/[^a-z0-9.]+/g, ' ').trim();
}
const compact = s => norm(s).replace(/[^a-z0-9]/g, '');
const STOP = new Set(['may', 'tinh', 'vi', 'cho', 'dung', 'cua', 'va', 'loai', 'model', 'mau', 'den', 'black', 'chiec', 'cai', 'hieu', 'nhan', 'thuong', 'kich', 'thuoc']);
function tokens(s) {
  return [...new Set(norm(s).split(/[\s.]+/).filter(t => t.length >= 2 && !STOP.has(t)))];
}
const weight = t => (/\d/.test(t) && /[a-z]/.test(t) ? 4 : /\d/.test(t) ? 2 : 1); // mã model (chữ + số) nặng nhất

function similarity(a, b) {
  const ca = compact(a); const cb = compact(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  const ta = tokens(a); const tb = tokens(b);
  const sb = new Set(tb); const sa = new Set(ta);
  // Token dính liền (EXCERIABASIC) vẫn khớp nếu là chuỗi con của tên bên kia
  const hit = t => sb.has(t) || (t.length >= 5 && cb.includes(t));
  const hitB = t => sa.has(t) || (t.length >= 5 && ca.includes(t));
  let inter = 0; let total = 0;
  for (const t of ta) { total += weight(t); if (hit(t)) inter += weight(t); }
  for (const t of tb) { total += weight(t); if (hitB(t)) inter += weight(t); }
  return total ? inter / total : 0;
}

const isService = it => /^dich vu|^phi |^cong /.test(db.vn(it.item_name)) || /^lan$/.test(db.vn(it.unit || '').trim());

const AUTO_THRESHOLD = 0.72;

const q = {
  pendingOut: db.prepare(`SELECT x.*, i.invoice_date, i.invoice_number, i.id AS inv_id FROM vat_items x JOIN vat_invoices i ON i.id = x.invoice_id
                          WHERE i.direction = 'out' AND (x.match_status IS NULL OR x.match_status IN ('unmatched','partial')) ORDER BY i.invoice_date, i.id, x.id`),
  inItems: db.prepare(`SELECT x.*, i.invoice_date FROM vat_items x JOIN vat_invoices i ON i.id = x.invoice_id WHERE i.direction = 'in' ORDER BY i.invoice_date, x.id`),
  setRemain: db.prepare(`UPDATE vat_items SET quantity_remaining = ?, status = ? WHERE id = ?`),
  setMatch: db.prepare(`UPDATE vat_items SET match_status = ?, matched_qty = ? WHERE id = ?`),
  insExport: db.prepare(`INSERT INTO vat_item_exports (vat_item_id, quantity, buyer_name, buyer_tax_id, out_invoice_id, out_item_id, auto, note, user_name)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  invoice: db.prepare('SELECT * FROM vat_invoices WHERE id = ?'),
};

// Ứng viên đầu vào cho 1 dòng bán ra, sắp theo độ giống
function candidates(outItem, inItems, limit = 8) {
  return inItems.map(it => ({ it, score: similarity(outItem.item_name, it.item_name) }))
    .filter(c => c.score > 0.25).sort((a, b) => b.score - a.score).slice(0, limit);
}

// Trừ số lượng FIFO trên các lô cùng loại hàng (lô nhập trước ngày bán ưu tiên, sớm nhất trước)
function allocate(outItem, inv, lots, qty, actor, auto) {
  let need = qty;
  const sorted = [...lots].sort((a, b) => {
    const pa = a.invoice_date <= outItem.invoice_date ? 0 : 1; const pb = b.invoice_date <= outItem.invoice_date ? 0 : 1;
    return pa - pb || a.invoice_date.localeCompare(b.invoice_date) || a.id - b.id;
  });
  for (const lot of sorted) {
    if (need <= EPS) break;
    if (lot.quantity_remaining <= EPS) continue;
    const take = Math.min(need, lot.quantity_remaining);
    lot.quantity_remaining = Math.round((lot.quantity_remaining - take) * 1000) / 1000;
    q.setRemain.run(lot.quantity_remaining, lot.quantity_remaining <= EPS ? 'depleted' : 'available', lot.id);
    q.insExport.run(lot.id, take, inv.buyer_name, inv.buyer_tax_id, inv.id, outItem.id, auto ? 1 : 0,
      `HĐ bán ra ${inv.invoice_symbol || ''} ${inv.invoice_number}`.trim(), actor);
    need = Math.round((need - take) * 1000) / 1000;
  }
  return qty - need;
}

// Đối chiếu các dòng bán ra chưa xử lý
function reconcile(actor = 'Đối chiếu tự động') {
  return db.transaction(() => {
    const inItems = q.inItems.all();
    const stats = { matched: 0, partial: 0, unmatched: 0, service: 0 };
    for (const o of q.pendingOut.all()) {
      if (isService(o)) { q.setMatch.run('service', 0, o.id); stats.service++; continue; }
      const need = o.quantity_in - (o.matched_qty || 0);
      const cands = candidates(o, inItems);
      const best = cands[0];
      if (!best || best.score < AUTO_THRESHOLD) { q.setMatch.run(o.matched_qty > EPS ? 'partial' : 'unmatched', o.matched_qty || 0, o.id); stats[o.matched_qty > EPS ? 'partial' : 'unmatched']++; continue; }
      // Mọi lô có cùng tên đã chuẩn hóa với lô khớp nhất = cùng 1 mặt hàng
      const key = compact(best.it.item_name);
      const lots = inItems.filter(it => compact(it.item_name) === key || similarity(it.item_name, best.it.item_name) >= 0.9);
      const inv = q.invoice.get(o.invoice_id);
      const got = (o.matched_qty || 0) + allocate(o, inv, lots, need, actor, true);
      const st = got >= o.quantity_in - EPS ? 'matched' : got > EPS ? 'partial' : 'unmatched';
      q.setMatch.run(st, got, o.id);
      stats[st]++;
    }
    return stats;
  })();
}

// Chọn tay lô đầu vào cho 1 dòng bán ra
function manualMatch(outItemId, inItemId, qty, actor) {
  return db.transaction(() => {
    const o = db.prepare(`SELECT x.*, i.invoice_date FROM vat_items x JOIN vat_invoices i ON i.id = x.invoice_id WHERE x.id = ? AND i.direction = 'out'`).get(outItemId);
    const lot = db.prepare(`SELECT x.*, i.invoice_date FROM vat_items x JOIN vat_invoices i ON i.id = x.invoice_id WHERE x.id = ? AND i.direction = 'in'`).get(inItemId);
    if (!o || !lot) return { error: 'Không tìm thấy mặt hàng.' };
    const left = o.quantity_in - o.matched_qty;
    const take = Math.min(qty || left, left, lot.quantity_remaining);
    if (take <= EPS) return { error: lot.quantity_remaining <= EPS ? 'Lô đầu vào này đã hết hàng.' : 'Dòng bán ra đã đối chiếu đủ.' };
    const got = allocate(o, q.invoice.get(o.invoice_id), [lot], take, actor, false);
    const matched = o.matched_qty + got;
    q.setMatch.run(matched >= o.quantity_in - EPS ? 'matched' : 'partial', matched, o.id);
    return { got };
  })();
}

// Bỏ toàn bộ kết quả đối chiếu tự động rồi chạy lại (giữ các lần chọn tay & xuất tay)
function resetAndReconcile(actor) {
  db.transaction(() => {
    for (const e of db.prepare('SELECT * FROM vat_item_exports WHERE auto = 1').all()) {
      db.prepare(`UPDATE vat_items SET quantity_remaining = MIN(quantity_in, quantity_remaining + ?), status = 'available' WHERE id = ?`).run(e.quantity, e.vat_item_id);
    }
    db.prepare('DELETE FROM vat_item_exports WHERE auto = 1').run();
    // dòng bán ra: tính lại phần đã khớp tay
    db.prepare(`UPDATE vat_items SET match_status = NULL, matched_qty = 0
                WHERE invoice_id IN (SELECT id FROM vat_invoices WHERE direction = 'out')
                  AND id NOT IN (SELECT out_item_id FROM vat_item_exports WHERE out_item_id IS NOT NULL)`).run();
  })();
  return reconcile(actor);
}

// Hoàn tác 1 lần xuất: trả số lượng về lô đầu vào, cập nhật trạng thái dòng bán ra
function undoExport(exportId) {
  return db.transaction(() => {
    const e = db.prepare('SELECT * FROM vat_item_exports WHERE id = ?').get(exportId);
    if (!e) return false;
    db.prepare(`UPDATE vat_items SET quantity_remaining = MIN(quantity_in, quantity_remaining + ?), status = 'available' WHERE id = ?`).run(e.quantity, e.vat_item_id);
    db.prepare('DELETE FROM vat_item_exports WHERE id = ?').run(e.id);
    if (e.out_item_id) {
      const o = db.prepare('SELECT * FROM vat_items WHERE id = ?').get(e.out_item_id);
      if (o) {
        const m = Math.max(0, (o.matched_qty || 0) - e.quantity);
        // 'manual' = người dùng đã chủ động bỏ, đối chiếu tự động không ghép lại dòng này
        q.setMatch.run(m > EPS ? 'partial' : 'manual', m, o.id);
      }
    }
    return true;
  })();
}

module.exports = { undoExport, reconcile, manualMatch, resetAndReconcile, candidates, similarity, isService };
