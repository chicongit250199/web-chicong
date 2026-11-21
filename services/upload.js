'use strict';
// Upload ảnh: multer giữ trong RAM -> sharp resize + nén WebP 80% -> /public/uploads
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const config = require('../config');

sharp.concurrency(1);   // Celeron: không chiếm hết CPU
sharp.cache(false);     // tiết kiệm RAM
fs.mkdirSync(config.uploadDir, { recursive: true });

const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|avif|heic|heif|bmp|tiff)$/;

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => cb(null, IMAGE_TYPES.test(file.mimetype)),
});

// Upload file bất kỳ (Excel) vào RAM
const fileUpload = (maxMb = 15) => multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024, files: 1 } });

const PRESETS = {
  logo: { width: 512, height: 512, fit: 'inside' },
  banner: { width: 1920, height: 600, fit: 'cover' },
  product: { width: 1200, height: 1200, fit: 'inside' },
};

async function saveImage(file, preset = 'product') {
  if (!file || !file.buffer) return null;
  const opts = PRESETS[preset] || PRESETS.product;
  const name = `${preset}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.webp`;
  await sharp(file.buffer, { failOn: 'none' })
    .rotate() // xoay theo EXIF của ảnh chụp điện thoại
    .resize({ ...opts, withoutEnlargement: true })
    .webp({ quality: 80, effort: 3 })
    .toFile(path.join(config.uploadDir, name));
  return `/uploads/${name}`;
}

function removeImage(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const p = path.join(config.uploadDir, path.basename(url));
  fs.promises.unlink(p).catch(() => {});
}

module.exports = { imageUpload, fileUpload, saveImage, removeImage };
