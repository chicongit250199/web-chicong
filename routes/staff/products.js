'use strict';
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const ai = require('../../services/aiService');
const { imageUpload, saveImage } = require('../../services/upload');
const { notify } = require('../../services/events');

const router = express.Router();
const qCats = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order, id');

router.get('/products/new', (req, res) => {
  res.locals.nav = 'product-new';
  const mine = db.prepare(`SELECT p.*, c.name_vi AS cat_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
                           WHERE p.created_by = ? ORDER BY p.id DESC LIMIT 20`).all(req.user.id);
  res.render('staff/product_new', { title: 'Đăng sản phẩm', categories: qCats.all(), mine, aiEnabled: ai.isEnabled() });
});

// Gemini viết mô tả từ tên + cấu hình
router.post('/api/ai/describe', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(422).json({ error: 'Nhập tên sản phẩm trước' });
  const cat = req.body.category_id ? db.prepare('SELECT name_vi FROM categories WHERE id = ?').get(req.body.category_id) : null;
  try {
    const description = await ai.writeProductDescription({ name, specs: String(req.body.specs || ''), category: cat && cat.name_vi, price: req.body.price });
    res.json({ description });
  } catch (e) {
    console.error('[ai] describe', e.message);
    res.status(e.status || 502).json({ error: e.expose ? e.message : 'AI tạm thời không phản hồi, thử lại sau hoặc tự viết mô tả.' });
  }
});

const productSchema = v.z.object({
  category_id: v.z.coerce.number().int().positive('Chọn danh mục'),
  name_vi: v.reqText('Nhập tên sản phẩm', 200),
  specs_vi: v.text(3000),
  desc_vi: v.text(8000),
  price: v.money,
});

router.post('/products', imageUpload.single('image'), async (req, res, next) => {
  try {
    const { data, error } = v.parse(productSchema, req.body);
    if (error) { req.flash('error', error); return res.redirect('/staff/products/new'); }
    const image_url = req.file ? await saveImage(req.file, 'product') : null;
    // Manager đăng thì duyệt luôn
    const status = req.user.role === 'manager' ? 'approved' : 'pending';
    const r = db.prepare(`INSERT INTO products (category_id, name_vi, specs_vi, desc_vi, price, image_url, status, created_by)
                          VALUES (@category_id, @name_vi, @specs_vi, @desc_vi, @price, @image_url, @status, @created_by)`)
      .run({ ...data, image_url, status, created_by: req.user.id });
    if (status === 'pending') notify('product', `${req.user.full_name} đăng sản phẩm "${data.name_vi}" — chờ duyệt`, `/manager/products/${r.lastInsertRowid}`, req.user.full_name);
    req.flash('success', status === 'pending' ? 'Đã gửi sản phẩm, chờ Quản lý duyệt.' : 'Đã đăng sản phẩm. Vào "Duyệt sản phẩm" để dịch sang các ngôn ngữ khác.');
    res.redirect('/staff/products/new');
  } catch (e) { next(e); }
});

module.exports = router;
