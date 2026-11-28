-- Báo cáo cấu hình máy do script "Kiểm tra cấu hình máy" (link /shel) gửi lên.
-- Chưa gắn vào task (task_id NULL) thì chỉ giữ 1 ngày; gắn rồi thì giữ luôn (xem lại lần sau theo serial).
CREATE TABLE pc_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT,                 -- serial máy (đã bỏ giá trị rác kiểu "To be filled by O.E.M.")
  maker TEXT,
  model TEXT,
  computer_name TEXT,
  summary TEXT NOT NULL,       -- cấu hình dạng chữ để điền vào ô Cấu hình
  data TEXT NOT NULL,          -- JSON đầy đủ script gửi lên
  ip TEXT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  linked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pc_reports_task ON pc_reports(task_id);
CREATE INDEX idx_pc_reports_serial ON pc_reports(serial);
CREATE INDEX idx_pc_reports_created ON pc_reports(created_at);

-- Script nào chạy được khi boot WinPE (menu /shel trên WinPE chỉ hiện các script này)
ALTER TABLE win_scripts ADD COLUMN pe INTEGER NOT NULL DEFAULT 0;
