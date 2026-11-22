# Chí Công Computer — Web nội bộ & ERP

Chủ dự án giao tiếp bằng **tiếng Việt** (văn nói, ngắn gọn). Trả lời bằng tiếng Việt.
Người dùng xem giao diện trên Mac/điện thoại trong mạng LAN; NUC **không có trình duyệt** — mọi thay đổi giao diện cần nói rõ là chưa xem trực tiếp.

## Chạy & vận hành
- Node 22 qua nvm: luôn `. ~/.nvm/nvm.sh && nvm use 22` trước khi chạy node/npm (Node 18 hệ thống làm crash better-sqlite3).
- Web chạy bằng **PM2**, tên `chicong-web`, chế độ production, KHÔNG tự theo dõi file:
  - sửa code / `.env` → `npm run build:css` (nếu đổi giao diện) rồi `pm2 restart chicong-web`
  - log: `logs/out-0.log`, `logs/error-0.log`
- Trước khi restart: kiểm tra không có lượt quét VAT đang chạy (`GET /manager/vat/sync/status`), restart sẽ ngắt (tự quét mỗi ngày lúc 0h00 giờ VN — `VAT_AUTO_SYNC_AT`; bị ngắt thì bấm cập nhật tay ở trang VAT).
- Báo cáo doanh thu qua Gmail (`services/revenueReport.js`): mỗi ngày `REPORT_DAILY_AT` (20:00) trừ Chủ nhật (CN gộp vào thứ 2), ngày cuối tháng thêm báo cáo tháng (cuối tháng là CN → gửi thứ 2); cấu hình `SMTP_*`, `REPORT_EMAIL_TO` trong `.env`; gửi thử/xem trước ở trang Hệ thống. Server thử có `BACKUP_DISABLED=true` thì không gửi.
- Máy in: CUPS trên NUC (`services/printers.js`, gọi lpstat/lpadmin/lp), quản lý ở trang Hệ thống; user chạy web cần thuộc nhóm `lpadmin`. Ngưỡng task quá hạn chỉnh ở trang Hệ thống (bảng settings `task_*_alert_days`).
- Địa chỉ LAN: http://chicongcomputer.local (hoặc http://192.168.1.199:3000) (ufw chỉ mở cho 192.168.1.0/24).
- DB: SQLite `data/chicong.db` (WAL). Migration: thêm file `db/migrations/NNN_ten.sql` (tự chạy khi khởi động). Sao lưu: `npm run backup` → `data/backups/`.

## Kiểm thử
- KHÔNG thử nghiệm trên DB thật. Chạy server thử:
  `DB_PATH=<thư mục tạm>/test.db BACKUP_DISABLED=true VAT_AUTO_SYNC_MINUTES=0 PORT=3099 node server.js`
  (thiếu `VAT_AUTO_SYNC_MINUTES=0` thì server thử sẽ quét Google Drive thật và tốn lượt Gemini).
- Kiểm tra cú pháp template: `node -e "require('ejs').compile(fs.readFileSync(f,'utf8'),{filename:f})"`.
- Thao tác sửa dữ liệu thật (xóa, gộp, import): **sao lưu trước** (`node scripts/backup.js`).

## Cấu trúc
- `server.js`, `config.js` (đọc `.env`) · `db/` · `middleware/` (auth, csrf, appShell…) · `routes/public.js`, `routes/staff/*`, `routes/manager/*`
- `services/`: aiService (Gemini + model dự phòng), driveService, vatSync/vatXml/vatReconcile (hóa đơn VAT), excelImport/revenueImport, productSync (kho → web), productImages, systemInfo, taskAlerts, events (SSE), partial (render nhanh), icons (SVG sprite)…
- `views/` (EJS + Tailwind 3 + Alpine.js), `public/js/*` (JS từng trang), `locales/*.json` (vi/en/ru/zh)
- Form có upload (multipart) gửi CSRF qua `?_csrf=`; fetch dùng `api()` trong `public/js/app.js` (tự gửi header CSRF).
- CSP chặn `onclick=` inline → dùng cú pháp Alpine (`@click`, `@submit`).

## Quy ước
- Tiền lưu INTEGER (VNĐ); thời gian lưu ISO UTC, hiển thị giờ VN; thống kê theo ngày dùng `date(created_at, '+7 hours')` (đã có index biểu thức).
- Tìm kiếm tiếng Việt không dấu: hàm SQL `vn(...)`.
- Bí mật chỉ nằm trong `.env` và `credentials/` (đã gitignore) — không bao giờ chép key vào `.env.example` hay commit.
- Git chưa cấu hình danh tính: commit bằng `git -c user.name=chicong -c user.email=chicong@localhost commit ...`; chỉ `git add` đúng file mình sửa (tránh lẫn thay đổi của phiên khác).
- Chỉ nên có **một phiên Claude** làm việc trên thư mục này tại một thời điểm.
