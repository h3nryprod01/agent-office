#!/bin/bash
# Install daily standup as a macOS launchd user agent: runs 09:00 every day.
# Repo nay là local (~/Projects/agent-office) nên launchd đọc được trực tiếp —
# không còn copy ra Application Support như hồi repo nằm trong OneDrive CloudStorage.
# Usage: ./scripts/install-standup-service.sh [uninstall]
set -euo pipefail

LABEL="com.agentoffice.standup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OLD_APP_DIR="$HOME/Library/Application Support/agent-office"
LOG="$HOME/Library/Logs/agent-office-standup.log"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$OLD_APP_DIR/standup.sh" "$OLD_APP_DIR/standup-prompt.md"
  echo "uninstalled $LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
# dọn bản copy cũ để không ai lỡ chạy nhầm script stale
rm -f "$OLD_APP_DIR/standup.sh" "$OLD_APP_DIR/standup-prompt.md"

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/standup.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 3  # bootout phải nhả xong, không thì bootstrap báo "5: Input/output error"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (script: $REPO/scripts/standup.sh, log: $LOG, schedule: 09:00 daily)"
