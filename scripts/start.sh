#!/bin/bash
# Run Agent Office: one command, from a fresh clone or on demo morning.
# Builds the renderer, makes sure the daemon is up, opens the office.
#
# macOS and Linux. On Windows use scripts/start.ps1.
# Usage: ./scripts/start.sh [--yes]
# If no daemon is running it asks whether to install one as a login service;
# --yes answers yes, answering no runs the daemon in the foreground (Ctrl+C stops it).
# Developing the renderer? `npm --prefix packages/renderer run dev` is still the
# fast path — this script serves a real build, so it has no hot reload.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=_ui.sh
. "$REPO/scripts/_ui.sh"
parse_yes "$@"
# localhost, KHÔNG phải 127.0.0.1: Chrome coi đây là hai origin riêng và cấp
# quyền riêng, nên mở bằng IP thì quyền microphone đã cấp cho localhost không
# áp dụng — nhận giọng nói chết im lặng. localhost cũng là secure context, bắt
# buộc để Web Speech / getUserMedia chạy.
URL="http://localhost:8787"

# lane L1: operations verbs go to the ao CLI: ./scripts/start.sh doctor | update | backup | restore | lan | token | report | approvals
case "${1:-}" in
  doctor | update | backup | restore | lan | token | report | approvals)
    command -v node >/dev/null 2>&1 || die "Node.js 20+ is required: https://nodejs.org/en/download" "Cần Node.js 20+: https://nodejs.org/en/download"
    exec node "$REPO/scripts/ao.mjs" "$@"
    ;;
esac

# lane L1: stop early, with the fix, on the problems that would break the start
# (old Node, no npm, port taken by another program, unwritable data directory)
command -v node >/dev/null 2>&1 || die "Node.js 20+ is required: https://nodejs.org/en/download" "Cần Node.js 20+: https://nodejs.org/en/download"
node "$REPO/scripts/ao.mjs" doctor --preflight || exit 1

for pkg in daemon renderer; do
  [ -d "$REPO/packages/$pkg/node_modules" ] || npm --prefix "$REPO/packages/$pkg" install
done

# Always rebuild. A stale dist is the one failure the daemon cannot report: it
# serves last week's build with a cheerful 200 and looks perfectly healthy.
# `tsc && vite build` also means a type error stops us here, before a browser
# window opens on the old bundle.
npm --prefix "$REPO/packages/renderer" run build

# Reuse a running daemon. Otherwise ask: a login service (KeepAlive on launchd,
# Restart=always on systemd, so a crash mid-demo restarts itself) or, if you say
# no, a foreground daemon that ends with this terminal. Nothing is installed
# without a yes.
DAEMON_PID=""
if ! curl -sf -o /dev/null "$URL"; then
  INSTALLER="$REPO/scripts/install-daemon-service.sh"
  [ "$(uname -s)" = "Linux" ] && INSTALLER="$REPO/scripts/install-daemon-service-linux.sh"
  if confirm "No daemon is running. Install it as a background service that starts at login?" \
    "Chưa có daemon nào chạy. Cài nó làm dịch vụ nền tự chạy khi đăng nhập?"; then
    "$INSTALLER" --yes
  else
    say "Running the daemon in this terminal; Ctrl+C stops it." "Chạy daemon ngay trong terminal này; Ctrl+C để dừng."
    node --max-old-space-size=768 "$REPO/packages/daemon/src/index.js" &
    DAEMON_PID=$!
    trap 'kill "$DAEMON_PID" 2>/dev/null || true' EXIT INT TERM
  fi
fi

for _ in $(seq 50); do
  curl -sf -o /dev/null "$URL" && break
  sleep 0.2
done

if ! curl -sf -o /dev/null "$URL"; then
  # shellcheck disable=SC2088  # hiển thị cho người đọc, không phải path để mở
  LOG_HINT="~/Library/Logs/agent-office-daemon.log"
  [ "$(uname -s)" = "Linux" ] && LOG_HINT="journalctl --user -u agent-office-daemon"
  die "daemon is silent at $URL - log: $LOG_HINT" "daemon im lặng ở $URL — log: $LOG_HINT"
fi

echo "Agent Office → $URL"
if [ "$(uname -s)" = "Linux" ]; then xdg-open "$URL" >/dev/null 2>&1 || true; else open "$URL"; fi
if [ -n "$DAEMON_PID" ]; then wait "$DAEMON_PID"; fi
