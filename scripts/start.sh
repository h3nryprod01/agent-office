#!/bin/bash
# Run Agent Office: one command, from a fresh clone or on demo morning.
# Builds the renderer, makes sure the daemon is up, opens the office.
#
# macOS. On Windows use scripts/install-daemon-service.ps1 and build by hand.
# Developing the renderer? `npm --prefix packages/renderer run dev` is still the
# fast path — this script serves a real build, so it has no hot reload.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# localhost, KHÔNG phải 127.0.0.1: Chrome coi đây là hai origin riêng và cấp
# quyền riêng, nên mở bằng IP thì quyền microphone đã cấp cho localhost không
# áp dụng — nhận giọng nói chết im lặng. localhost cũng là secure context, bắt
# buộc để Web Speech / getUserMedia chạy.
URL="http://localhost:8787"

for pkg in daemon renderer; do
  [ -d "$REPO/packages/$pkg/node_modules" ] || npm --prefix "$REPO/packages/$pkg" install
done

# Always rebuild. A stale dist is the one failure the daemon cannot report: it
# serves last week's build with a cheerful 200 and looks perfectly healthy.
# `tsc && vite build` also means a type error stops us here, before a browser
# window opens on the old bundle.
npm --prefix "$REPO/packages/renderer" run build

# Reuse a running daemon; otherwise install it as a login service. KeepAlive
# (launchd) / Restart=always (systemd) means a crash mid-demo restarts itself
# instead of ending the demo.
INSTALLER="$REPO/scripts/install-daemon-service.sh"
[ "$(uname -s)" = "Linux" ] && INSTALLER="$REPO/scripts/install-daemon-service-linux.sh"
curl -sf -o /dev/null "$URL" || "$INSTALLER"

for _ in $(seq 50); do
  curl -sf -o /dev/null "$URL" && break
  sleep 0.2
done

if ! curl -sf -o /dev/null "$URL"; then
  # shellcheck disable=SC2088  # hiển thị cho người đọc, không phải path để mở
  LOG_HINT="~/Library/Logs/agent-office-daemon.log"
  [ "$(uname -s)" = "Linux" ] && LOG_HINT="journalctl --user -u agent-office-daemon"
  echo "daemon im lặng ở $URL — log: $LOG_HINT" >&2
  exit 1
fi

echo "Agent Office → $URL"
open "$URL"
