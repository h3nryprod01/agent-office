#!/bin/bash
# One-command install for Agent Office on Ubuntu Desktop: checks prerequisites,
# installs deps, builds the renderer, optionally installs the daemon as a
# systemd --user service, adds a desktop launcher, then opens the office.
# Usage: ./scripts/install-ubuntu.sh [--yes]
# --yes agrees to the background-service question; without it the script asks.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://127.0.0.1:8787"

# shellcheck source=_ui.sh
. "$REPO/scripts/_ui.sh"
parse_yes "$@"

# lane L1: operations verbs go to the ao CLI: ./scripts/install-ubuntu.sh doctor | update | backup | restore | lan | token
case "${1:-}" in
  doctor | update | backup | restore | lan | token)
    command -v node >/dev/null 2>&1 || die "Node.js 20+ is required: https://nodejs.org/en/download" "Cần Node.js 20+: https://nodejs.org/en/download"
    exec node "$REPO/scripts/ao.mjs" "$@"
    ;;
esac

# (1) node >= 20
command -v node >/dev/null 2>&1 || die "Node.js is missing. Install Node.js >= 20 and run this again: https://nodejs.org/en/download" "Thiếu Node.js. Cài Node.js >= 20 rồi chạy lại: https://nodejs.org/en/download"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $(node -v) is too old: need >= 20. Install a newer one and run this again: https://nodejs.org/en/download" "Node.js $(node -v) quá cũ — cần >= 20. Cài bản mới rồi chạy lại: https://nodejs.org/en/download"

# lane L1: the same readiness check the other platforms use; prints only what is wrong, with the fix
node "$REPO/scripts/ao.mjs" doctor --preflight || exit 1

# (2) notify-send + xdg-open (desktop notifications + opening files/URLs)
if ! command -v notify-send >/dev/null 2>&1 || ! command -v xdg-open >/dev/null 2>&1; then
  die "Missing system packages. Run this, then run the script again:
  sudo apt install -y libnotify-bin xdg-utils" "Thiếu gói hệ thống. Chạy lệnh sau rồi chạy lại script này:
  sudo apt install -y libnotify-bin xdg-utils"
fi

# (3) install dependencies
npm ci --prefix "$REPO/packages/daemon" || die "npm ci failed in packages/daemon" "npm ci thất bại ở packages/daemon"
npm ci --prefix "$REPO/packages/renderer" || die "npm ci failed in packages/renderer" "npm ci thất bại ở packages/renderer"

# (4) build renderer
npm --prefix "$REPO/packages/renderer" run build || die "Renderer build failed" "Build renderer thất bại"

# (5) background daemon via systemd --user (survives reboot) - asks first.
# The service script asks too, so hand it the answer instead of asking twice.
SERVICE=0
if confirm "Install the daemon as a systemd user service (starts at login)?" "Cài daemon làm dịch vụ systemd của người dùng (tự chạy khi đăng nhập)?"; then
  "$REPO/scripts/install-daemon-service-linux.sh" --yes || die "Installing the daemon's systemd service failed" "Cài systemd service cho daemon thất bại"
  SERVICE=1
fi

# (6) application menu launcher
"$REPO/scripts/make-desktop-entry.sh" || die "Creating the desktop entry failed" "Tạo desktop entry thất bại"

if [ "$SERVICE" = 0 ]; then
  say "No background service installed. Start Agent Office when you want it: ./scripts/start.sh" \
    "Chưa cài dịch vụ nền. Khi cần thì chạy: ./scripts/start.sh"
  exit 0
fi

# (7) wait for the daemon, then open the office
for _ in $(seq 50); do
  curl -sf -o /dev/null "$URL" && break
  sleep 0.2
done
curl -sf -o /dev/null "$URL" || die "daemon is silent at $URL - log: journalctl --user -u agent-office-daemon" "daemon im lặng ở $URL — log: journalctl --user -u agent-office-daemon"

echo "Agent Office → $URL"
# Installing over SSH/TTY has no DISPLAY, so opening a browser would fail - that
# is NOT an install failure (the daemon was confirmed up above). Without this
# guard set -e turns it into exit != 0 and the user thinks the install broke.
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi
