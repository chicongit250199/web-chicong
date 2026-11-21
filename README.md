# Chí Công Computer — Web nội bộ & ERP

Node.js 22 + Express 5 · SQLite (better-sqlite3, WAL) · EJS + Tailwind + Alpine.js · SSE · Gemini AI · Google Drive

## Chạy local
```bash
nvm use                     # Node 22 (theo .nvmrc)
cp .env.example .env        # điền SESSION_SECRET, GEMINI_API_KEY...
npm install
npm start                   # build CSS rồi chạy http://<IP-NUC>:3000
npm run dev                 # tự restart khi sửa code (+ `npm run watch:css` khi sửa giao diện)
```
Tài khoản mặc định: `admin` / `123456` (Quản lý), `staff1` / `123456` (Nhân viên) — **đổi ngay** trong *Tài khoản nhân viên*.

## Phân hệ
| Đường dẫn | Ai dùng | Chức năng |
|---|---|---|
| `/` | Khách | Trang chủ 4 ngôn ngữ, danh mục, chi tiết sản phẩm, bản đồ, Zalo/WhatsApp |
| `/staff` | Nhân viên + Quản lý | Nhận máy, Task (xử lý / xong / không sửa được), Trả máy (hoàn thành / sửa lại), Bán hàng, Tìm kiếm, Xem kho, Nhập kho, Đăng sản phẩm (AI) |
| `/manager` | Quản lý | Doanh thu hôm nay, Thống kê ngày/tháng/năm + CSV, Phân task, Duyệt & dịch sản phẩm, Sửa trang chủ, Tài khoản, Import Excel kho, Kho hóa đơn VAT, Thông báo real-time |

## Cấu hình AI & Google Drive
1. **Gemini**: lấy API key tại Google AI Studio → `GEMINI_API_KEY` trong `.env`.
2. **Drive (hóa đơn VAT)**:
   - Google Cloud Console → tạo project → bật **Google Drive API** → tạo **Service Account** → tạo key JSON.
   - Lưu file vào `credentials/service-account.json` (thư mục này không đưa lên git).
   - **Share** 2 thư mục hóa đơn (đầu vào / bán ra) cho email của service account (quyền Người xem).
   - Dán link hoặc ID thư mục vào `DRIVE_VAT_INPUT_FOLDER_ID`, `DRIVE_VAT_OUTPUT_FOLDER_ID`.
3. Khởi động lại server.

Hóa đơn **XML** (MISA, Viettel, FastCA, VNPT, BKAV… chuẩn Tổng cục Thuế) được đọc trực tiếp, chính xác và không tốn phí AI. File **PDF/ảnh** không kèm XML mới gửi qua Gemini. Để XML và PDF **cùng tên** trong thư mục thì hệ thống đọc XML và gắn link PDF để mở xem.

## Chạy nền 24/7 (PM2)
```bash
npm i -g pm2
npm run build:css
pm2 start ecosystem.config.js && pm2 save
pm2 startup                 # làm theo lệnh sudo nó in ra để tự chạy khi NUC khởi động
pm2 logs chicong-web        # xem log
```

## Sao lưu
- Tự động mỗi ngày lúc `BACKUP_HOUR` (mặc định 2h sáng), giữ `BACKUP_KEEP` bản trong `data/backups/`.
- Thủ công: `npm run backup`. Khôi phục: dừng server, chép file backup đè lên `data/chicong.db`, xóa `chicong.db-wal` / `-shm`, chạy lại.

## Cấu trúc
- `config.js` — cấu hình tập trung (đọc `.env`)
- `db/` — kết nối, migration (`db/migrations/*.sql`), seed, session store
- `middleware/` — `requireAuth`, `requireRole`, CSRF, flash, khung trang
- `routes/` — `auth`, `public`, `staff/*`, `manager/*`
- `services/` — `aiService` (Gemini), `driveService`, `vatXml`, `vatSync`, `excelImport`, `events` (SSE), `upload` (sharp → WebP), `backup`...
- `views/` — EJS · `public/` — CSS/JS/ảnh upload · `locales/` — nhãn giao diện 4 ngôn ngữ
- `scripts/` — `seed-demo.js` (sản phẩm demo), `backup.js`
