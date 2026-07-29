#!/bin/bash
# Add an "Agent Office" launcher to the Linux applications menu.
# Usage: ./scripts/make-desktop-entry.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APPS_DIR="$HOME/.local/share/applications"
ENTRY="$APPS_DIR/agent-office.desktop"

mkdir -p "$APPS_DIR"
cat > "$ENTRY" << EOF
[Desktop Entry]
Type=Application
Name=Agent Office
Exec=$REPO/scripts/start.sh
Terminal=false
Categories=Development;
EOF

echo "installed $ENTRY"
