-- 021: nhật ký Zalo Bot — tin nhận được (ai nhắn gì) và tin bot gửi (trả lời, thông báo, nhắc quá hạn)
CREATE TABLE zalo_messages (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  dir TEXT NOT NULL,                 -- 'in' (người nhắn bot) | 'out' (bot gửi)
  kind TEXT NOT NULL,                -- in: 'msg' · out: 'reply' | 'notify' | 'partner' | 'overdue' | 'test'
  chat_id TEXT NOT NULL,
  chat_name TEXT,                    -- tài khoản / đối tác đã liên kết, hoặc tên nhóm / tên Zalo
  sender TEXT,                       -- tên Zalo người nhắn (tin nhận)
  is_group INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  reply_to INTEGER,                  -- tin trả lời → id tin nhận
  ai INTEGER NOT NULL DEFAULT 0,     -- 1 = do AI viết
  ok INTEGER NOT NULL DEFAULT 1,     -- 0 = gửi lỗi
  error TEXT,
  note TEXT                          -- tin nhận: vì sao bot không trả lời (VD vượt giới hạn)
);
CREATE INDEX idx_zalo_messages_reply ON zalo_messages(reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX idx_zalo_messages_created ON zalo_messages(created_at);
