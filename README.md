# Sao lưu Chí Công Computer (mã hóa)

Mỗi file `chicong-YYYY-MM-DD_HHMM.tar.gz.enc` = CSDL (SQLite) + ảnh upload, mã hóa AES-256.
Mật khẩu: BACKUP_PASSPHRASE (trong file .env trên máy chủ — chủ cửa hàng giữ bản chép riêng).

## Khôi phục (Linux / máy có OpenSSL 1.1.1 trở lên)

    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in chicong-....tar.gz.enc -out backup.tar.gz
    tar xzf backup.tar.gz
    # -> chicong.db (đặt vào data/chicong.db) và thư mục uploads/ (chép vào public/uploads/)

Trên Mac nếu lệnh openssl báo không hỗ trợ -pbkdf2: `brew install openssl` rồi dùng `$(brew --prefix openssl)/bin/openssl`.
