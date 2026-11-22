#!/bin/bash
# Thư viện + font cho Chrome không giao diện (dựng phiếu thành PDF để in ra máy in NUC).
# Chạy: sudo bash scripts/setup-print-pdf.sh
set -e
apt-get install -y libatk1.0-0t64 libatk-bridge2.0-0t64 libxdamage1 libasound2t64 libatspi2.0-0t64 \
  fontconfig fonts-liberation fonts-dejavu-core fonts-noto-core
fc-cache -f >/dev/null
echo "XONG — bấm 'In ra máy in cửa hàng' trên phiếu để thử."
