# Chí Công Computer — Web nội bộ & ERP

Node.js + Express 5 · SQLite (better-sqlite3, WAL) · EJS + Tailwind + Alpine.js

## Chạy local
```bash
cp .env.example .env        # điền SESSION_SECRET, GEMINI_API_KEY...
npm install
npm start                   # build CSS rồi chạy http://<IP-NUC>:3000
npm run dev                 # tự restart khi sửa code (chạy thêm `npm run watch:css` khi sửa giao diện)
```
Tài khoản mặc định: `admin` / `123456` (manager), `staff1` / `123456` (staff) — đổi ngay sau khi chạy.

## Chạy nền 24/7 (PM2)
```bash
npm run build:css
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

## Cấu trúc
- `config.js` — cấu hình tập trung (đọc `.env`)
- `db/` — kết nối, migration (`db/migrations/*.sql`), seed, session store
- `middleware/` — `requireAuth`, `requireRole`, CSRF, biến chung cho view
- `routes/` — `auth`, `public`, `staff`, `manager`
- `services/` — settings, i18n, format, (AI, Drive ở các giai đoạn sau)
- `views/` — EJS · `public/` — CSS/JS/ảnh upload · `locales/` — nhãn giao diện 4 ngôn ngữ
