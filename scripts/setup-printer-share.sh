#!/bin/bash
# Chia sẻ máy in của NUC cho máy tính / điện thoại trong LAN, và không giữ lại file đã in.
# Chạy: sudo bash scripts/setup-printer-share.sh
set -e
cupsctl PreserveJobFiles=No --share-printers
for p in $(lpstat -p 2>/dev/null | awk '/^printer/{print $2}'); do lpadmin -p "$p" -o printer-is-shared=true; done
ufw allow from 192.168.1.0/24 to any port 631 proto tcp comment 'CUPS in qua LAN'
ufw allow from 192.168.1.0/24 to any port 5353 proto udp comment 'mDNS tim may in'
systemctl restart cups
echo "XONG — máy in đã chia sẻ trong mạng LAN, file in xong không lưu lại."
