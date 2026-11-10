#!/bin/bash
# Install the Agent Office daemon as a macOS launchd user agent:
# starts at login, restarts on crash, logs to ~/Library/Logs.
# Usage: ./scripts/install-daemon-service.sh [--yes] [uninstall]
# Asks before installing; --yes answers the question.
set -euo pipefail

# shellcheck source=_ui.sh
. "$(dirname "$0")/_ui.sh"
parse_yes "$@"

LABEL="com.agentoffice.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOG="$HOME/Library/Logs/agent-office-daemon.log"
# launchd PATH doesn't include ~/.local/bin etc., so probe the absolute path now
# and bake it into the plist — else POST /chat fails with "spawn claude ENOENT".
CLAUDE="$(command -v claude || true)"
# PM workspace outside the package folder (set by `<package> --install-service`); a clone leaves it unset.
WORKSPACE="${AGENT_OFFICE_REPO:-}"
ENV_XML=""
[ -n "$CLAUDE" ] && ENV_XML="$ENV_XML    <key>CHAT_CLAUDE_BIN</key><string>$CLAUDE</string>
"
[ -n "$WORKSPACE" ] && ENV_XML="$ENV_XML    <key>AGENT_OFFICE_REPO</key><string>$WORKSPACE</string>
"

if [ "${1:-}" = "uninstall" ] || [ "${2:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

# A service from another copy (e.g. a git clone) may already be installed under this label:
# say so, because installing replaces it.
OLD=""
if [ -f "$PLIST" ]; then
  OLD="$(sed -n 's#.*<string>\(.*\)/packages/daemon/src/index.js</string>.*#\1#p' "$PLIST" | head -n 1)"
fi
REPLACE_EN=""
REPLACE_VI=""
if [ -n "$OLD" ] && [ "$OLD" != "$REPO" ]; then
  REPLACE_EN=" This will REPLACE the service currently running from $OLD."
  REPLACE_VI=" Việc này sẽ THAY dịch vụ đang chạy từ $OLD."
fi

confirm "Install Agent Office as a background service (starts at login, restarts on crash)? This writes $PLIST and runs launchctl.$REPLACE_EN" \
  "Cài Agent Office làm dịch vụ chạy nền (tự chạy khi đăng nhập, tự khởi động lại khi lỗi)? Việc này ghi $PLIST và chạy launchctl.$REPLACE_VI" ||
  die "Not installed. To run in the foreground instead: node $REPO/packages/daemon/src/index.js" "Chưa cài. Muốn chạy ở tiền cảnh: node $REPO/packages/daemon/src/index.js"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--max-old-space-size=768</string>
    <string>$REPO/packages/daemon/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
${ENV_XML:+  <key>EnvironmentVariables</key><dict>
$ENV_XML  </dict>}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Không có ProcessType, launchd xếp job vào lớp không-tương-tác và Apple
       Silicon ghim nó vào efficiency core: TTS VieNeu đi từ ~3s lên ~10s, và ép
       hẳn xuống QoS nền thì lên 53-152s. Daemon phục vụ UI nên phải Interactive. -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the old job is gone; bootstrapping too early fails with
# "5: Input/output error" and leaves NO daemon running. Wait for it to go, then retry.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
ok=0
err=""
for _ in 1 2 3 4 5; do
  if err=$(launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>&1); then ok=1; break; fi
  sleep 1
done
if [ "$ok" != 1 ]; then
  say_err "launchctl bootstrap failed: $err" "launchctl bootstrap thất bại: $err"
  say_err "finish by hand: launchctl bootstrap gui/$(id -u) '$PLIST'" "làm nốt bằng tay: launchctl bootstrap gui/$(id -u) '$PLIST'"
  exit 1
fi
echo "installed $LABEL (node: $NODE, claude: ${CLAUDE:-<not found, CHAT_CLAUDE_BIN unset>}, repo: $REPO, log: $LOG)"
say "Remove it any time: $0 uninstall" "Gỡ bất cứ lúc nào: $0 uninstall"
