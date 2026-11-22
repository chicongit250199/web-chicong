'use strict';
// Đưa cấu hình PC mẫu (Build PC) lên trang chủ: tạo / cập nhật 1 sản phẩm trong danh mục PC, gắn với mẫu (products.pc_build_id).
// Sửa mẫu -> sản phẩm tự cập nhật tên, giá, cấu hình. Gỡ / xóa mẫu -> xóa sản phẩm (kèm ảnh).
const db = require('../db');
const gallery = require('./productImages');
const { removeImage } = require('./upload');

const parse = s => { try { return JSON.parse(s || '[]'); } catch { return []; } };

// Danh mục PC trên trang chủ (icon desktop); chưa có thì tạo
function pcCategoryId() {
  const c = db.prepare(`SELECT id FROM categories WHERE icon = 'desktop' OR vn(name_vi) = 'pc' ORDER BY id LIMIT 1`).get();
  if (c) return c.id;
  return db.prepare(`INSERT INTO categories (name_vi, name_en, name_ru, name_zh, icon, sort_order, is_active) VALUES ('PC', 'PC', 'ПК', '台式电脑', 'desktop', 2, 1)`).run().lastInsertRowid;
}

function content(b) {
  const items = parse(b.items);
  const name = /^\s*pc\b/i.test(b.name || '') ? b.name.trim() : `PC ${(b.name || b.code).trim()}`;
  const line = l => `${l.category}: ${l.qty > 1 ? l.qty + '× ' : ''}${l.name}${l.condition ? ' (' + l.condition + ')' : ''}${l.warranty_months ? ' — BH ' + l.warranty_months + ' tháng' : ''}`;
  const specs = items.map(line).join('\n');
  const desc = `Cấu hình PC lắp sẵn tại Chí Công Computer — ${items.length} linh kiện, cài đặt và kiểm tra trước khi giao. Có thể nâng cấp / thay đổi linh kiện theo nhu cầu.${b.note ? '\n' + b.note : ''}`;
  return { name, specs, desc, price: b.total || null };
}

const productOf = buildId => db.prepare('SELECT * FROM products WHERE pc_build_id = ?').get(buildId);

function publish(buildId, userId) {
  const b = db.prepare('SELECT * FROM pc_builds WHERE id = ?').get(buildId);
  if (!b) throw Object.assign(new Error('Cấu hình không còn.'), { status: 404 });
  if (!b.is_template) throw Object.assign(new Error('Chỉ cấu hình mẫu mới đưa lên trang chủ được.'), { status: 400 });
  const c = content(b);
  const p = productOf(b.id);
  if (p) {
    db.prepare(`UPDATE products SET name_vi = ?, specs_vi = ?, desc_vi = COALESCE(desc_vi, ?), price = ?, status = 'approved' WHERE id = ?`).run(c.name, c.specs, c.desc, c.price, p.id);
    return productOf(b.id);
  }
  const id = db.prepare(`INSERT INTO products (category_id, name_vi, specs_vi, desc_vi, price, status, is_featured, created_by, source, pc_build_id)
      VALUES (?, ?, ?, ?, ?, 'approved', 0, ?, 'pc_build', ?)`).run(pcCategoryId(), c.name, c.specs, c.desc, c.price, userId || null, b.id).lastInsertRowid;
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

// Sau khi lưu / sửa mẫu: đang trên web thì cập nhật theo; bỏ đánh dấu mẫu thì gỡ khỏi web
function refresh(buildId) {
  const p = productOf(buildId);
  if (!p) return null;
  const b = db.prepare('SELECT is_template FROM pc_builds WHERE id = ?').get(buildId);
  if (!b || !b.is_template) return unpublish(buildId);
  return publish(buildId);
}

function unpublish(buildId) {
  const p = productOf(buildId);
  if (!p) return null;
  const imgs = gallery.list(p.id);
  db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
  for (const i of imgs) if (!db.prepare('SELECT 1 FROM product_images WHERE url = ?').get(i.url)) removeImage(i.url);
  if (p.image_url && !imgs.some(i => i.url === p.image_url)) removeImage(p.image_url);
  return p;
}

// { buildId: productId } của các mẫu đang trên web
const publishedMap = () => new Map(db.prepare('SELECT pc_build_id, id FROM products WHERE pc_build_id IS NOT NULL').all().map(r => [r.pc_build_id, r.id]));

module.exports = { publish, refresh, unpublish, publishedMap, content };
