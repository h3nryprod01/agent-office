#!/bin/bash
# One-command install for Agent Office on Ubuntu Desktop: checks prerequisites,
# installs deps, builds the renderer, installs the daemon as a systemd --user
# service, adds a desktop launcher, then opens the office.
# Usage: ./scripts/install-ubuntu.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://127.0.0.1:8787"

die() {
  echo "$1" >&2
  exit 1
}

# (1) node >= 20
command -v node >/dev/null 2>&1 || die "Thiếu Node.js. Cài Node.js >= 20 rồi chạy lại: https://nodejs.org/en/download"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $(node -v) quá cũ — cần >= 20. Cài bản mới rồi chạy lại: https://nodejs.org/en/download"

# (2) notify-send + xdg-open (thông báo desktop + mở file/URL)
if ! command -v notify-send >/dev/null 2>&1 || ! command -v xdg-open >/dev/null 2>&1; then
  die "Thiếu gói hệ thống. Chạy lệnh sau rồi chạy lại script này:
  sudo apt install -y libnotify-bin xdg-utils"
fi

# (3) cài dependency
npm ci --prefix "$REPO/packages/daemon" || die "npm ci thất bại ở packages/daemon"
npm ci --prefix "$REPO/packages/renderer" || die "npm ci thất bại ở packages/renderer"

# (4) build renderer
npm --prefix "$REPO/packages/renderer" run build || die "Build renderer thất bại"

# (5) daemon chạy nền qua systemd --user, tự khởi động lại sau reboot
"$REPO/scripts/install-daemon-service-linux.sh" || die "Cài systemd service cho daemon thất bại"

# (6) lối tắt trong menu ứng dụng
"$REPO/scripts/make-desktop-entry.sh" || die "Tạo desktop entry thất bại"

# (7) chờ daemon sống rồi mở office
for _ in $(seq 50); do
  curl -sf -o /dev/null "$URL" && break
  sleep 0.2
done
curl -sf -o /dev/null "$URL" || die "daemon im lặng ở $URL — log: journalctl --user -u agent-office-daemon"

echo "Agent Office → $URL"
# Cài qua SSH/TTY thì không có DISPLAY, mở browser sẽ hỏng — đó KHÔNG phải cài
# thất bại (daemon đã được xác nhận sống ở bước trên). Không chặn ở đây thì
# set -e biến nó thành exit != 0 và khách tưởng cài hỏng.
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi
