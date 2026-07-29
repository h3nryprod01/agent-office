#!/bin/bash
# Install the Agent Office daemon as a systemd --user service on Linux:
# starts at login, restarts on crash, and (via loginctl linger) keeps running
# after logout. Analogous to install-daemon-service.sh (launchd) on macOS,
# which this script does not touch.
# Usage: ./scripts/install-daemon-service-linux.sh
set -euo pipefail

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/agent-office-daemon.service"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
ENV_FILE="$HOME/.config/agent-office/env"

# systemd --user does NOT inherit the shell environment, so without an
# EnvironmentFile the daemon can never see TELEGRAM_BOT_TOKEN and every Telegram
# feature silently does nothing. Secrets live here, never in the unit: the unit
# is world-readable (644), this file is 600.
mkdir -p "$(dirname "$ENV_FILE")"
[ -f "$ENV_FILE" ] || cat > "$ENV_FILE" << 'ENVEOF'
# Điền 2 dòng dưới để bật thông báo + nhắn tin cho PM qua Telegram.
# Bỏ trống cũng được: daemon chạy bình thường, chỉ là không có Telegram.
# Tạo bot bằng @BotFather. Lấy chat id bằng @userinfobot.
#TELEGRAM_BOT_TOKEN=
#TELEGRAM_CHAT_ID=

# Ngân sách (USD) toàn máy: vượt thì yêu cầu cần duyệt sẽ chờ bạn duyệt vượt +
# tab Chi phí hiện cảnh báo. Bỏ trống = tắt.
#AGENT_OFFICE_BUDGET_USD=

# Zalo (PLACEHOLDER — nhắn PM qua Zalo OA). Cần: (1) tạo Zalo OA + access token
# (token hết hạn ~1 ngày → phải refresh bằng OAuth của Zalo); (2) expose công
# khai POST /zalo/webhook qua HTTPS để Zalo gọi tới. Bỏ trống = tắt.
#ZALO_OA_TOKEN=
#ZALO_ALLOWED_USER=

# VieNeu TTS — giọng tiếng Việt đọc reply của PM. Cần python có 'vieneu' + 'torch':
#   python3 -m venv ~/.venv-vieneu
#   ~/.venv-vieneu/bin/pip install vieneu torch torchaudio --index-url https://download.pytorch.org/whl/cpu
# Bỏ trống = dùng giọng hệ thống của trình duyệt (vẫn đọc được, chỉ kém hay hơn).
#VIENEU_PYTHON=/home/youruser/.venv-vieneu/bin/python
ENVEOF
chmod 600 "$ENV_FILE"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" << EOF
[Unit]
Description=Agent Office daemon

[Service]
ExecStart=$NODE --max-old-space-size=768 $REPO/packages/daemon/src/index.js
WorkingDirectory=$REPO
# systemd --user PATH is sparse (no ~/.local/bin) → the daemon can't find the
# claude/codex/gemini CLIs it spawns for the PM chat + harness probes (ENOENT).
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin
EnvironmentFile=-$ENV_FILE
Restart=always

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable agent-office-daemon.service
# restart, NOT `enable --now`: `--now` only starts a stopped service, so on a
# re-run (unit changed) it silently keeps the already-running daemon with its
# stale config — how a PATH fix can look applied yet never take effect. restart
# starts a stopped service too, so it is correct for first install and re-run.
systemctl --user restart agent-office-daemon.service
# Without linger, systemd --user (and this service with it) is killed on logout.
loginctl enable-linger "$USER"
echo "installed agent-office-daemon (node: $NODE, repo: $REPO)"
echo "Telegram (tuỳ chọn): điền $ENV_FILE rồi chạy: systemctl --user restart agent-office-daemon"
