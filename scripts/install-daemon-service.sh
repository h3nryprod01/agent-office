#!/bin/bash
# Install the Agent Office daemon as a macOS launchd user agent:
# starts at login, restarts on crash, logs to ~/Library/Logs.
# Usage: ./scripts/install-daemon-service.sh [uninstall]
set -euo pipefail

LABEL="com.agentoffice.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOG="$HOME/Library/Logs/agent-office-daemon.log"
# launchd PATH doesn't include ~/.local/bin etc., so probe the absolute path now
# and bake it into the plist — else POST /chat fails with "spawn claude ENOENT".
CLAUDE="$(command -v claude || true)"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

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
${CLAUDE:+  <key>EnvironmentVariables</key><dict><key>CHAT_CLAUDE_BIN</key><string>$CLAUDE</string></dict>}
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
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (node: $NODE, claude: ${CLAUDE:-<not found, CHAT_CLAUDE_BIN unset>}, repo: $REPO, log: $LOG)"
