-- Script PowerShell cho máy khách (link /shel): mỗi dòng = 1 mục trong menu. Quản lý ở Hệ thống → Script Windows
CREATE TABLE win_scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- tên file .ps1 (lưu tạm trên máy khách khi chạy)
  name TEXT NOT NULL,                         -- tên chức năng hiện trong menu
  descr TEXT NOT NULL DEFAULT '',             -- mô tả ngắn dưới tên
  gist_url TEXT,                              -- link gist để cập nhật (tùy chọn)
  content TEXT NOT NULL DEFAULT '',
  prev_content TEXT,                          -- bản trước lần sửa / cập nhật gần nhất (khôi phục 1 bước)
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT,                             -- lần cuối lấy từ gist
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
