'use strict';
// Ghi các dòng của 1 đơn bán (dùng chung: trang Bán hàng + Trả máy có bán kèm)
// Món từ kho: trừ đúng món (serial) + doanh thu 'sale'. Hàng ngoài kho / dịch vụ: chỉ ghi doanh thu.
const db = require('../db');
const v = require('./validate');

const lineSchema = v.z.object({
  // Chọn từ kho: item_id. Hàng ngoài kho / dịch vụ: để trống item_id, nhập name + kind
  item_id: v.z.preprocess(x => (x === '' || x == null ? null : Number(x)), v.z.number().int().positive().nullable()),
  name: v.text(300),
  kind: v.z.preprocess(x => (x === 'sale' ? 'sale' : 'repair'), v.z.enum(['repair', 'sale'])),
  price: v.money.refine(x => x != null, 'Nhập giá tiền cho từng món'),
  warranty_months: v.intOpt,
}).refine(d => d.item_id || d.name, { message: 'Nhập tên hàng hóa / dịch vụ' });

const noDupSerial = items => new Set(items.filter(i => i.item_id).map(i => i.item_id)).size === items.filter(i => i.item_id).length;

// Mã đơn: BH-YYMMDD-HHMMSS-xxx (giờ VN)
function newOrderCode() {
  const d = new Date(Date.now() + 7 * 3600e3).toISOString();
  return `BH-${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}-${Math.random().toString(36).slice(2, 5)}`;
}

const insRevenue = db.prepare(`INSERT INTO revenues (type, ref_id, customer_name, customer_phone, delivery_address, content, amount, payment_method, warranty_months, staff_name, created_at, order_code)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const getItem = db.prepare(`SELECT * FROM inventory_items WHERE id = ? AND status = 'in_stock'`);
const markSold = db.prepare(`UPDATE inventory_items SET status = 'sold', sold_date = ?, customer_name = ?, customer_phone = ?, warranty_out_months = ? WHERE id = ?`);

// Gọi BÊN TRONG db.transaction. ctx: { customer_name, customer_phone, delivery_address, payment_method, staff_name, now (ISO), saleDay (YYYY-MM-DD), orderCode }
// Món kho không còn -> ném lỗi có e.gone = true (transaction bên ngoài tự hoàn tác).
function writeLines(items, ctx) {
  return items.map(line => {
    if (!line.item_id) {
      insRevenue.run(line.kind, null, ctx.customer_name, ctx.customer_phone, ctx.delivery_address || null, line.name, line.price, ctx.payment_method,
        line.warranty_months ?? 0, ctx.staff_name, ctx.now, ctx.orderCode);
      return { content: line.name, price: line.price, kind: line.kind };
    }
    const item = getItem.get(line.item_id);
    if (!item) { const e = new Error('Có món trong đơn vừa được bán hoặc không còn trong kho. Hãy chọn lại.'); e.gone = true; throw e; }
    const warranty = line.warranty_months ?? item.warranty_out_months ?? 0;
    markSold.run(ctx.saleDay, ctx.customer_name, ctx.customer_phone, warranty, item.id);
    const content = `${item.name}${item.serial ? ' — SN: ' + item.serial : ''}`;
    insRevenue.run('sale', item.id, ctx.customer_name, ctx.customer_phone, ctx.delivery_address || null, content, line.price, ctx.payment_method, warranty, ctx.staff_name, ctx.now, ctx.orderCode);
    return { content, price: line.price, kind: 'sale', serial: item.serial };
  });
}

// Xóa các dòng bán kèm cùng phiếu (trừ dòng sửa chữa của task), trả món kho về tồn. Gọi trong transaction.
// Trả về tổng tiền đã xóa.
function removeOrderExtras(orderCode) {
  if (!orderCode) return 0;
  const rows = db.prepare(`DELETE FROM revenues WHERE order_code = ? AND NOT (type = 'repair' AND ref_id IS NOT NULL) RETURNING type, ref_id, amount`).all(orderCode);
  const restock = db.prepare(`UPDATE inventory_items SET status = 'in_stock', sold_date = NULL, customer_name = NULL, customer_phone = NULL WHERE id = ? AND status = 'sold'`);
  for (const r of rows) if (r.type === 'sale' && r.ref_id) restock.run(r.ref_id);
  return rows.reduce((s, r) => s + (r.amount || 0), 0);
}

module.exports = { lineSchema, noDupSerial, newOrderCode, writeLines, removeOrderExtras };
