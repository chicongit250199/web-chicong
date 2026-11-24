'use strict';
// Phân loại hàng trong kho theo tên (kho chưa có cột danh mục): Main, CPU, RAM, VGA, Ổ cứng...
// Không phụ thuộc db — db/index.js đăng ký hàm SQL inv_cat(name) từ đây.

const CATEGORIES = [
  { key: 'main', label: 'Main' },
  { key: 'cpu', label: 'CPU' },
  { key: 'ram', label: 'RAM' },
  { key: 'vga', label: 'VGA' },
  { key: 'storage', label: 'Ổ cứng' },
  { key: 'psu', label: 'Nguồn' },
  { key: 'case', label: 'Vỏ case' },
  { key: 'cooling', label: 'Tản nhiệt' },
  { key: 'monitor', label: 'Màn hình' },
  { key: 'gear', label: 'Phím chuột' },
  { key: 'laptop', label: 'Laptop' },
  { key: 'pc', label: 'PC' },
  { key: 'other', label: 'Khác' },
];

// 1) Từ đầu tên quyết định (VD "Ram lap 16gb" là RAM, "LAPTOP DELL ... SSD 256G" là Laptop)
const PREFIX = [
  ['other', /^card (wifi|mang|lan|am thanh|sound|chuyen)/],
  ['laptop', /^(laptop|notebook|macbook)\b/],
  ['pc', /^(pc|bo may|may bo|may tinh bo|cay may)\b/],
  ['main', /^(main|mainboard|bo mach chu)\b/],
  ['cpu', /^(cpu|chip|chíp)\b/],
  ['ram', /^ram\b/],
  ['vga', /^(vga|card)\b/],
  ['storage', /^(ssd|hdd|nvme|m\.?2|o cung|o ssd)\b/],
  ['psu', /^(nguon|psu)\b/],
  ['monitor', /^(man|lcd|led|monitor)\b/],
  ['case', /^(case|vo case|vo may|thung may)\b/],
  ['cooling', /^(tan|fan|quat|aio)\b/],
  ['gear', /^(ban phim|bo phim|phim|key|chuot|keyboard|tainghe|mouse|tai nghe|headphone|loa|webcam|lot chuot)\b/],
];
// 2) Không có từ đầu rõ ràng: đoán theo nội dung
const CONTAINS = [
  ['laptop', /\b(latitude|vostro|inspiron|precision|thinkpad|ideapad|elitebook|probook|zenbook|vivobook|katana|nitro|dell (g\d|e?\d{4}))\b/],
  ['vga', /\b(rtx|gtx|rx ?\d{3,4}|gt ?\d{3,4})\b/],
  ['cpu', /\b(i[3579] ?-? ?\d{4,5}\w*|e5 ?-? ?\d{4}\w*|ryzen|r[3579] \d{4}\w*|xeon|pentium|celeron)\b/],
  ['ram', /\b(ddr\d|d[345])\b/],
  ['storage', /\b(ssd|hdd|nvme)\b/],
  ['main', /\b[abhqxz]\d{2,3}m?\b/],
  ['psu', /\b\d{3,4} ?w\b/],
  ['monitor', /\b\d{2} ?(inch|in)\b/],
  ['laptop', /^(dell|hp|lenovo|acer|asus|msi)\b/], // còn lại: tên hãng + model, VD "Dell ins 5557", "Asus A1505"
];

const vn = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().trim();

function categorize(name) {
  const n = vn(name);
  for (const [k, re] of PREFIX) if (re.test(n)) return k;
  for (const [k, re] of CONTAINS) if (re.test(n)) return k;
  return 'other';
}

const isCategory = k => CATEGORIES.some(c => c.key === k);

module.exports = { CATEGORIES, categorize, isCategory };
