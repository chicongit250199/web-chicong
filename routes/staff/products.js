'use strict';
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const ai = require('../../services/aiService');
const { imageUpload, saveImage } = require('../../services/upload');
const gallery = require('../../services/productImages');
const { notify } = require('../../services/events');

const router = express.Router();
const qCats = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order, id');

router.get('/products/new', (req, res) => {
  res.locals.nav = 'product-new';
  const mine = db.prepare(`SELECT p.*, c.name_vi AS cat_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
                           WHERE p.created_by = ? ORDER BY p.id DESC LIMIT 20`).all(req.user.id);
  res.render('staff/product_new', { title: 'Đăng sản phẩm', categories: qCats.all(), mine, aiEnabled: ai.isEnabled(), scripts: ['/js/product-ai.js'] });
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

// Gemini tra cứu thông số thật trên Google + viết bài giới thiệu chi tiết
router.post('/api/ai/research', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 3) return res.status(422).json({ error: 'Nhập tên / model máy trước (VD: Dell Latitude 5420)' });
  const cat = req.body.category_id ? db.prepare('SELECT name_vi FROM categories WHERE id = ?').get(req.body.category_id) : null;
  try {
    const r = await ai.researchProduct({
      name, specs: String(req.body.specs || '').slice(0, 3000), category: cat && cat.name_vi,
      price: req.body.price, condition: String(req.body.condition || '').slice(0, 100),
    });
    res.json(r);
  } catch (e) {
    console.error('[ai] research', e.message);
    const quota = /429|quota|RESOURCE_EXHAUSTED/i.test(e.message);
    res.status(e.status || 502).json({ error: e.expose ? e.message : quota ? 'Đã hết lượt AI miễn phí hôm nay, thử lại sau.' : 'AI tạm thời không phản hồi, thử lại sau ít phút.' });
  }
});

const productSchema = v.z.object({
  category_id: v.z.coerce.number().int().positive('Chọn danh mục'),
  name_vi: v.reqText('Nhập tên sản phẩm', 200),
  specs_vi: v.text(3000),
  desc_vi: v.text(8000),
  price: v.money,
});

router.post('/products', imageUpload.array('images', 5), async (req, res, next) => {
  try {
    const { data, error } = v.parse(productSchema, req.body);
    if (error) { req.flash('error', error); return res.redirect('/staff/products/new'); }
    const urls = [];
    for (const f of (req.files || []).slice(0, gallery.MAX)) urls.push(await saveImage(f, 'product'));
    const image_url = urls[0] || null;
    // Manager đăng thì duyệt luôn
    const status = req.user.role === 'manager' ? 'approved' : 'pending';
    const r = db.prepare(`INSERT INTO products (category_id, name_vi, specs_vi, desc_vi, price, image_url, status, created_by)
                          VALUES (@category_id, @name_vi, @specs_vi, @desc_vi, @price, @image_url, @status, @created_by)`)
      .run({ ...data, image_url, status, created_by: req.user.id });
    urls.forEach((u, i) => db.prepare('INSERT INTO product_images (product_id, url, sort) VALUES (?, ?, ?)').run(r.lastInsertRowid, u, i));
    if (status === 'pending') notify('product', `${req.user.full_name} đăng sản phẩm "${data.name_vi}" — chờ duyệt`, `/manager/products/${r.lastInsertRowid}`, req.user.full_name);
    req.flash('success', status === 'pending' ? 'Đã gửi sản phẩm, chờ Quản lý duyệt.' : 'Đã đăng sản phẩm. Vào "Duyệt sản phẩm" để dịch sang các ngôn ngữ khác.');
    res.redirect('/staff/products/new');
  } catch (e) { next(e); }
});

module.exports = router;
