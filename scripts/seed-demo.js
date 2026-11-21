'use strict';
// Tạo sản phẩm demo để xem trang chủ:  npm run seed:demo
// Xoá toàn bộ demo:                    npm run seed:demo -- --remove
const db = require('../db');

const TAG = '[Demo] ';
if (process.argv.includes('--remove')) {
  const r = db.prepare('DELETE FROM products WHERE name_vi LIKE ?').run(TAG + '%');
  console.log(`Đã xoá ${r.changes} sản phẩm demo`);
  process.exit(0);
}

const cats = Object.fromEntries(db.prepare('SELECT id, icon FROM categories').all().map(c => [c.icon, c.id]));
const demo = [
  ['laptop', 'Laptop Dell Latitude 5420 i5-1145G7', 'Dell Latitude 5420 i5-1145G7', 'CPU: Intel Core i5-1145G7\nRAM: 16GB DDR4\nSSD: 512GB NVMe\nMàn hình: 14" FHD IPS', 9500000],
  ['laptop', 'Laptop ThinkPad T14 Gen 2 Ryzen 5 Pro', 'ThinkPad T14 Gen 2 Ryzen 5 Pro', 'CPU: AMD Ryzen 5 Pro 5650U\nRAM: 16GB\nSSD: 512GB\nMàn hình: 14" FHD', 10900000],
  ['laptop', 'Laptop HP EliteBook 840 G8', 'HP EliteBook 840 G8', 'CPU: Intel Core i7-1165G7\nRAM: 16GB\nSSD: 512GB', 11500000],
  ['laptop', 'MacBook Air M1 2020 8GB/256GB', 'MacBook Air M1 2020 8GB/256GB', 'Chip: Apple M1\nRAM: 8GB\nSSD: 256GB', 13900000],
  ['laptop', 'Laptop Asus Vivobook 15 i3', 'Asus Vivobook 15 i3', 'CPU: Intel Core i3-1215U\nRAM: 8GB\nSSD: 256GB', 7900000],
  ['laptop', 'Laptop Acer Aspire 7 GTX1650', 'Acer Aspire 7 GTX1650', 'CPU: Ryzen 5 5500U\nVGA: GTX 1650 4GB\nRAM: 16GB', 12500000],
  ['desktop', 'PC Văn phòng i5-12400 / 16GB / SSD 512GB', 'Office PC i5-12400 / 16GB / 512GB SSD', 'CPU: Intel Core i5-12400\nMain: H610\nRAM: 16GB DDR4\nSSD: 512GB', 8900000],
  ['desktop', 'PC Gaming Ryzen 5 5600 + RTX 3060', 'Gaming PC Ryzen 5 5600 + RTX 3060', 'CPU: Ryzen 5 5600\nVGA: RTX 3060 12GB\nRAM: 16GB\nSSD: 1TB', 16500000],
  ['cpu', 'SSD Samsung 980 500GB NVMe', 'Samsung 980 500GB NVMe SSD', 'Chuẩn: M.2 NVMe PCIe 3.0\nĐọc: 3100MB/s', 1150000],
  ['cpu', 'RAM Kingston Fury 16GB DDR4 3200', 'Kingston Fury 16GB DDR4 3200', 'Dung lượng: 16GB\nBus: 3200MHz', 950000],
  ['wrench', 'Vệ sinh laptop + thay keo tản nhiệt', 'Laptop cleaning + thermal paste', 'Thời gian: 30-60 phút\nKeo: Arctic MX-4', 150000],
  ['wrench', 'Cài đặt Windows + phần mềm văn phòng', 'Windows + office software installation', 'Thời gian: 60 phút', 100000],
];
const ins = db.prepare(`INSERT INTO products (category_id, name_vi, name_en, specs_vi, desc_vi, desc_en, price, status, is_featured)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?)`);
db.transaction(() => demo.forEach(([icon, vi, en, specs, price], i) => ins.run(
  cats[icon], TAG + vi, en, specs,
  `${vi} — sản phẩm demo. Hàng chính hãng, bảo hành tận nơi tại Chí Công Computer.`,
  `${en} — demo product. Genuine, warranty at Chi Cong Computer.`,
  price, i % 4 === 3 ? 0 : 1,
)))();
console.log(`Đã thêm ${demo.length} sản phẩm demo`);
