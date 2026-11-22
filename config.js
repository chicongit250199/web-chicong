'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const env = process.env;
const isProd = env.NODE_ENV === 'production';

// Chấp nhận cả ID lẫn link thư mục Google Drive
function driveFolderId(v) {
  if (!v) return '';
  const m = String(v).match(/folders\/([\w-]+)/);
  return m ? m[1] : String(v).trim();
}

const config = {
  isProd,
  host: env.HOST || '0.0.0.0',
  port: parseInt(env.PORT, 10) || 3000,
  sessionSecret: env.SESSION_SECRET || 'dev-only-change-me',
  // Bật khi đã public qua HTTPS (reverse proxy / Cloudflare Tunnel)
  secureCookies: env.SECURE_COOKIES === 'true',
  trustProxy: env.TRUST_PROXY === 'true',
  timezone: env.TZ_DISPLAY || 'Asia/Ho_Chi_Minh',

  dbPath: path.resolve(__dirname, env.DB_PATH || 'data/chicong.db'),
  backupDir: path.resolve(__dirname, env.BACKUP_DIR || 'data/backups'),
  uploadDir: path.join(__dirname, 'public', 'uploads'),

  geminiApiKey: env.GEMINI_API_KEY || '',
  // Danh sách key: key 1 hết lượt / quá tải -> tự chuyển sang key 2
  geminiApiKeys: [...new Set([env.GEMINI_API_KEY, env.GEMINI_API_KEY_2].map(s => (s || '').trim()).filter(Boolean))],
  geminiModel: env.GEMINI_MODEL || 'gemini-3.8-flash',
  // Dùng khi model chính quá tải / hết lượt (phân tách bằng dấu phẩy)
  geminiFallbackModels: (env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash,gemini-3.5-flash-lite').split(',').map(s => s.trim()).filter(Boolean),

  googleServiceAccountPath: env.GOOGLE_SERVICE_ACCOUNT_PATH
    ? path.resolve(__dirname, env.GOOGLE_SERVICE_ACCOUNT_PATH) : '',
  driveVatInputFolderId: driveFolderId(env.DRIVE_VAT_INPUT_FOLDER_ID),
  driveVatOutputFolderId: driveFolderId(env.DRIVE_VAT_OUTPUT_FOLDER_ID),

  languages: ['vi', 'en', 'ru', 'zh'],
  defaultLang: 'vi',
};

if (isProd && config.sessionSecret === 'dev-only-change-me') {
  console.error('[config] SESSION_SECRET chưa được đặt trong .env — dừng khởi động.');
  process.exit(1);
}

module.exports = config;
