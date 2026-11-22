#!/bin/bash
# Cho web đọc điện năng CPU (Intel RAPL) để hiện mức tiêu thụ điện ở trang Hệ thống.
# Mặc định chỉ root đọc được energy_uj. Script mở quyền đọc ngay + tạo udev rule để giữ sau khi khởi động lại.
# Chạy: sudo bash scripts/setup-power.sh
set -e
if [ "$(id -u)" != 0 ]; then echo "Cần chạy bằng sudo: sudo bash scripts/setup-power.sh"; exit 1; fi
ls /sys/class/powercap/intel-rapl:*/energy_uj >/dev/null 2>&1 || { echo "Máy không có cảm biến Intel RAPL."; exit 1; }
chmod o+r /sys/class/powercap/intel-rapl:*/energy_uj /sys/class/powercap/intel-rapl:*:*/energy_uj 2>/dev/null || true
cat > /etc/udev/rules.d/99-chicong-rapl.rules <<'RULE'
# Chí Công web: cho phép đọc điện năng CPU (trang Hệ thống)
SUBSYSTEM=="powercap", ACTION=="add", RUN+="/bin/chmod o+r /sys%p/energy_uj"
RULE
udevadm control --reload-rules || true
echo "Xong. Điện năng CPU hiện tại (µJ): $(cat /sys/class/powercap/intel-rapl:0/energy_uj)"
echo "Mở trang Hệ thống sau khoảng 20 giây để thấy số W."
