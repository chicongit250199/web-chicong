'use strict';
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const ai = require('../../services/aiService');
const { imageUpload, saveImage, removeImage } = require('../../services/upload');
const gallery = require('../../services/productImages');

const router = express.Router();
const qGet = db.prepare(`SELECT p.*, u.full_name AS author FROM products p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`);

router.get('/products', (req, res) => {
  res.locals.nav = 'm-products';
  const tab = req.query.tab === 'pending' ? 'pending' : 'approved'; // mặc định: danh sách sản phẩm đã đăng để sửa
  const s = String(req.query.q || '').trim();
  const products = db.prepare(`SELECT p.*, c.name_vi AS cat_name, u.full_name AS author FROM products p
      LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN users u ON u.id = p.created_by
      WHERE p.status = ? ${s ? 'AND p.name_vi LIKE ?' : ''} ORDER BY p.created_at DESC LIMIT 300`).all(...[tab, s && `%${s}%`].filter(Boolean));
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) c FROM products GROUP BY status').all().map(r => [r.status, r.c]));
  res.render('manager/products', { title: 'Quản lý sản phẩm', tab, products, counts, search: s });
});

// Đưa hàng tồn kho lên trang chủ (gộp theo tên, tự xếp danh mục, bỏ qua món đã có)
router.post('/products/sync-inventory', (req, res) => {
  const r = require('../../services/productSync').syncFromInventory(req.user.id);
  req.flash('success', `Đã thêm ${r.added} sản phẩm từ kho lên web${r.linked ? `, gắn ${r.linked} sản phẩm đã đăng với kho` : ''}${r.skipped ? `, bỏ qua ${r.skipped} đã có` : ''}${r.categories.length ? `; tạo danh mục: ${r.categories.join(', ')}` : ''}.`);
  res.redirect('/manager/products?tab=approved');
});

router.get('/products/:id', (req, res, next) => {
  const p = qGet.get(req.params.id);
  if (!p) return next();
  res.locals.nav = 'm-products';
  res.render('manager/product_edit', { title: p.name_vi, p, images: gallery.list(p.id), categories: db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all(), aiEnabled: ai.isEnabled(), scripts: ['/js/product-ai.js'] });
});

const editSchema = v.z.object({
  category_id: v.z.coerce.number().int().positive('Chọn danh mục'),
  name_vi: v.reqText('Nhập tên sản phẩm', 200), name_en: v.text(200), name_ru: v.text(200), name_zh: v.text(200),
  specs_vi: v.text(3000),
  desc_vi: v.text(8000), desc_en: v.text(8000), desc_ru: v.text(8000), desc_zh: v.text(8000),
  price: v.money,
  is_featured: v.z.preprocess(x => (x ? 1 : 0), v.z.number()),
  condition: v.text(30),
});

async function translateInto(p) {
  const t = await ai.translateProduct({ name: p.name_vi, desc: p.desc_vi });
  db.prepare(`UPDATE products SET name_en=?, desc_en=?, name_ru=?, desc_ru=?, name_zh=?, desc_zh=? WHERE id=?`)
    .run(t.en.name, t.en.desc, t.ru.name, t.ru.desc, t.zh.name, t.zh.desc, p.id);
}

// Lưu chỉnh sửa; action = save | approve | translate
router.post('/products/:id', imageUpload.array('images', 5), async (req, res, next) => {
  try {
    const p = qGet.get(req.params.id);
    if (!p) return next();
    const { data, error } = v.parse(editSchema, req.body);
    if (error) { req.flash('error', error); return res.redirect(`/manager/products/${p.id}`); }
    // Ảnh mới thêm vào bộ ảnh (tối đa 5)
    let skipped = 0;
    for (const f of req.files || []) {
      const url = await saveImage(f, 'product');
      if (!gallery.add(p.id, url)) { removeImage(url); skipped++; }
    }
    if (skipped) req.flash('error', `Mỗi sản phẩm tối đa ${gallery.MAX} ảnh — bỏ qua ${skipped} ảnh.`);
    db.prepare(`UPDATE products SET category_id=@category_id, name_vi=@name_vi, name_en=@name_en, name_ru=@name_ru, name_zh=@name_zh, specs_vi=@specs_vi,
                desc_vi=@desc_vi, desc_en=@desc_en, desc_ru=@desc_ru, desc_zh=@desc_zh, price=@price, is_featured=@is_featured, condition=@condition WHERE id=@id`)
      .run({ ...data, id: p.id });

    const action = req.body.action;
    if (action === 'approve' || action === 'translate') {
      let translated = false;
      if (ai.isEnabled()) {
        try { await translateInto({ ...p, ...data }); translated = true; } catch (e) {
          console.error('[ai] translate', e.message);
          req.flash('error', `Không dịch được bằng AI (${e.message}). Có thể bấm "Dịch lại" sau.`);
        }
      } else if (action === 'translate') req.flash('error', 'Chưa cấu hình GEMINI_API_KEY.');
      if (action === 'approve') {
        db.prepare(`UPDATE products SET status = 'approved' WHERE id = ?`).run(p.id);
        req.flash('success', `Đã duyệt "${data.name_vi}"${translated ? ' và dịch sang EN / RU / ZH' : ''}.`);
        const left = db.prepare(`SELECT COUNT(*) c FROM products WHERE status = 'pending'`).get().c;
        return res.redirect(left ? '/manager/products?tab=pending' : '/manager/products');
      }
      if (translated) req.flash('success', 'Đã dịch sang EN / RU / ZH.');
    } else req.flash('success', 'Đã lưu.');
    res.redirect(`/manager/products/${p.id}`);
  } catch (e) { next(e); }
});

router.post('/products/:id/unapprove', (req, res) => {
  db.prepare(`UPDATE products SET status = 'pending' WHERE id = ?`).run(req.params.id);
  req.flash('success', 'Đã gỡ sản phẩm khỏi trang chủ (chuyển về chờ duyệt).');
  res.redirect(`/manager/products/${req.params.id}`);
});

// Ảnh: xóa / đặt làm ảnh đại diện
router.post('/products/:id/images/:imageId/delete', (req, res) => {
  gallery.remove(Number(req.params.imageId));
  res.redirect(`/manager/products/${req.params.id}#images`);
});
router.post('/products/:id/images/:imageId/cover', (req, res) => {
  gallery.makeCover(Number(req.params.imageId));
  res.redirect(`/manager/products/${req.params.id}#images`);
});

router.post('/products/:id/delete', (req, res) => {
  const p = qGet.get(req.params.id);
  if (p) {
    const imgs = gallery.list(p.id);
    db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
    for (const i of imgs) if (!db.prepare('SELECT 1 FROM product_images WHERE url = ?').get(i.url)) removeImage(i.url);
    if (p.image_url && !imgs.some(i => i.url === p.image_url)) removeImage(p.image_url);
    req.flash('success', `Đã xóa "${p.name_vi}".`);
  }
  res.redirect('/manager/products');
});

module.exports = router;
