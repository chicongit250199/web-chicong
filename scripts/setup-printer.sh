#!/bin/bash
# Cài hệ thống in CUPS cho trang Hệ thống > Máy in. Chạy: sudo bash scripts/setup-printer.sh
set -e
apt-get install -y cups cups-client cups-bsd avahi-utils
usermod -aG lpadmin chicong_computer
systemctl enable --now cups
echo "XONG — vào trang Hệ thống > Máy in để thêm máy in."
