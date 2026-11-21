// PM2: pm2 start ecosystem.config.js && pm2 save && pm2 startup
// Chế độ fork, 1 instance: SQLite + SSE giữ trạng thái trong 1 tiến trình
module.exports = {
  apps: [{
    name: 'chicong-web',
    script: 'server.js',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_memory_restart: '400M',
    node_args: '--max-old-space-size=384',
    env: { NODE_ENV: 'production' },
    out_file: 'logs/out.log',
    error_file: 'logs/error.log',
    time: true,
    kill_timeout: 5000, // chờ đóng kết nối (SSE) trước khi tắt
  }],
};
