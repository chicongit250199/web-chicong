'use strict';
// Máy in bill nhiệt (ESC/POS, khổ 80mm): đổi ảnh phiếu thành lệnh in ảnh raster (GS v 0) + cắt giấy.
// In dạng ảnh nên tiếng Việt có dấu, bảng, chữ đậm... giống hệt trang web, không phụ thuộc bảng mã của máy in.
// Khổ 80mm: vùng in 72mm = 576 chấm (203 dpi).
const sharp = require('sharp');

const DOTS = 576;
const BAND = 240; // số dòng chấm mỗi lệnh GS v 0 (máy in rẻ hay giới hạn bộ đệm)

async function fromPng(png, { width = DOTS, threshold = 165, cut = true } = {}) {
  const { data, info } = await sharp(png).flatten({ background: '#ffffff' }).greyscale()
    .resize({ width, kernel: 'lanczos3' })
    .raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, padL = 0;
  const bytesPerRow = width / 8;
  const parts = [Buffer.from([0x1b, 0x40])]; // ESC @: khởi tạo
  for (let y0 = 0; y0 < h; y0 += BAND) {
    const rows = Math.min(BAND, h - y0);
    const buf = Buffer.alloc(bytesPerRow * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y0 + y) * w + x] < threshold) {
          const X = x + padL;
          buf[y * bytesPerRow + (X >> 3)] |= 0x80 >> (X & 7);
        }
      }
    }
    parts.push(Buffer.from([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8]), buf);
  }
  parts.push(Buffer.from([0x1b, 0x64, 0x04])); // đẩy giấy 4 dòng
  if (cut) parts.push(Buffer.from([0x1d, 0x56, 0x42, 0x03])); // cắt giấy (sau khi đẩy thêm)
  return Buffer.concat(parts);
}

module.exports = { fromPng, DOTS };
