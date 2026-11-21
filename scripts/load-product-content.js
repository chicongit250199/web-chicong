'use strict';
// Nạp nội dung sản phẩm hàng loạt từ file JSON:
//   [{ "id": 24, "name": "...", "specs": "...", "desc": "...", "images": ["https://..."] }]
// - Cập nhật tên / cấu hình / mô tả (trường nào có mới ghi)
// - Tải ảnh (tối đa 5 / sản phẩm), nén WebP, gắn vào bộ ảnh; ảnh đầu tiên làm ảnh đại diện
// Chạy: node scripts/load-product-content.js data/product-content.json [--replace-images]
const fs = require('fs');
const db = require('../db');
const { saveImage } = require('../services/upload');
const gallery = require('../services/productImages');

const file = process.argv[2];
const replace = process.argv.includes('--replace-images');
if (!file) { console.error('Thiếu đường dẫn file JSON'); process.exit(1); }
const items = JSON.parse(fs.readFileSync(file, 'utf8'));

async function download(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
      Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', Referer: new URL(url).origin + '/',
    } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = r.headers.get('content-type') || '';
    if (!/^image\//.test(type)) throw new Error(`không phải ảnh (${type})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 3000) throw new Error('ảnh quá nhỏ');
    return buf;
  } finally { clearTimeout(t); }
}

(async () => {
  const report = [];
  for (const it of items) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(it.id);
    if (!p) { report.push(`#${it.id}: không có sản phẩm`); continue; }
    db.prepare(`UPDATE products SET name_vi = COALESCE(?, name_vi), specs_vi = COALESCE(?, specs_vi), desc_vi = COALESCE(?, desc_vi),
                condition = COALESCE(?, condition) WHERE id = ?`)
      .run(it.name || null, it.specs || null, it.desc || null, it.condition || null, p.id);
    if (replace && (it.images || []).length) for (const img of gallery.list(p.id)) gallery.remove(img.id);
    let ok = 0; const errs = [];
    for (const url of (it.images || []).slice(0, gallery.MAX)) {
      if (gallery.list(p.id).length >= gallery.MAX) break;
      if (db.prepare('SELECT 1 FROM product_images WHERE product_id = ? AND source_url = ?').get(p.id, url)) continue;
      try {
        const local = await saveImage({ buffer: await download(url) }, 'product');
        gallery.add(p.id, local, url); ok++;
      } catch (e) { errs.push(`${new URL(url).hostname}: ${e.message}`); }
    }
    report.push(`#${p.id} ${(it.name || p.name_vi).slice(0, 50)} — ảnh +${ok}${errs.length ? ' | lỗi: ' + errs.join('; ') : ''}`);
  }
  console.log(report.join('\n'));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
