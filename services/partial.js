'use strict';
// Dựng mẫu con (partial) nhanh cho vòng lặp: biên dịch 1 lần, mỗi lần gọi chỉ nhận vài biến cần thiết.
// (include() của EJS sao chép toàn bộ biến trang + kiểm tra file trên đĩa ở MỖI lần gọi -> chậm khi lặp hàng trăm lần)
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const config = require('../config');

const VIEWS = path.join(__dirname, '..', 'views');
const cache = new Map();

function partial(name, data) {
  let fn = cache.get(name);
  if (!fn) {
    const file = path.join(VIEWS, name + '.ejs');
    fn = ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
    if (config.isProd) cache.set(name, fn); // dev: luôn đọc lại để sửa giao diện thấy ngay
  }
  return fn(data);
}

module.exports = partial;
