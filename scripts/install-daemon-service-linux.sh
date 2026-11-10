#!/bin/bash
# Install the Agent Office daemon as a systemd --user service on Linux:
# starts at login, restarts on crash, and (via loginctl linger) keeps running
# after logout. Analogous to install-daemon-service.sh (launchd) on macOS,
# which this script does not touch.
# Usage: ./scripts/install-daemon-service-linux.sh [--yes]
# Asks before installing; --yes answers the question.
set -euo pipefail

# shellcheck source=_ui.sh
. "$(dirname "$0")/_ui.sh"
parse_yes "$@"

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/agent-office-daemon.service"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
ENV_FILE="$HOME/.config/agent-office/env"

confirm "Install Agent Office as a systemd user service (starts at login, keeps running after logout via linger)?" \
  "Cài Agent Office làm dịch vụ systemd của người dùng (tự chạy khi đăng nhập, chạy tiếp sau khi đăng xuất nhờ linger)?" ||
  die "Not installed. To run in the foreground instead: node packages/daemon/src/index.js" "Chưa cài. Muốn chạy ở tiền cảnh: node packages/daemon/src/index.js"

# systemd --user does NOT inherit the shell environment, so without an
# EnvironmentFile the daemon can never see TELEGRAM_BOT_TOKEN and every Telegram
# feature silently does nothing. Secrets live here, never in the unit: the unit
# is world-readable (644), this file is 600.
mkdir -p "$(dirname "$ENV_FILE")"
write_env_vi() {
  cat > "$ENV_FILE" << 'ENVEOF'
# Điền 2 dòng dưới để bật thông báo + nhắn tin cho PM qua Telegram.
# Bỏ trống cũng được: daemon chạy bình thường, chỉ là không có Telegram.
# Tạo bot bằng @BotFather. Lấy chat id bằng @userinfobot.
#TELEGRAM_BOT_TOKEN=
#TELEGRAM_CHAT_ID=

# Ngân sách (USD) toàn máy: vượt thì yêu cầu cần duyệt sẽ chờ bạn duyệt vượt +
# tab Chi phí hiện cảnh báo. Bỏ trống = tắt.
#AGENT_OFFICE_BUDGET_USD=

# Zalo OA — kênh quản lý dự án (docs/multi-pm-telegram.md). Cần đủ 3 biến: access token
# của OA (hết hạn ~1 ngày → refresh bằng OAuth của Zalo), App ID và OA secret (để kiểm chữ
# ký webhook); và expose công khai POST /zalo/webhook qua HTTPS. Bỏ trống = tắt.
#ZALO_OA_TOKEN=
#ZALO_APP_ID=
#ZALO_OA_SECRET=
#ZALO_ALLOWED_USER=   # tuỳ chọn: chat Zalo riêng của chủ máy (kiểu cũ)

# VieNeu TTS — giọng tiếng Việt đọc reply của PM. Cần python có 'vieneu' + 'torch':
#   python3 -m venv ~/.venv-vieneu
#   ~/.venv-vieneu/bin/pip install vieneu torch torchaudio --index-url https://download.pytorch.org/whl/cpu
# Bỏ trống = dùng giọng hệ thống của trình duyệt (vẫn đọc được, chỉ kém hay hơn).
#VIENEU_PYTHON=/home/youruser/.venv-vieneu/bin/python
ENVEOF
}
write_env_en() {
  cat > "$ENV_FILE" << 'ENVEOF'
# Fill in these two lines to get notifications and PM messages over Telegram.
# Leaving them empty is fine: the daemon runs normally, just without Telegram.
# Create a bot with @BotFather. Get your chat id with @userinfobot.
#TELEGRAM_BOT_TOKEN=
#TELEGRAM_CHAT_ID=

# Machine-wide budget (USD): past it, permission requests wait for you to approve
# the overage and the Costs tab shows a warning. Empty = off.
#AGENT_OFFICE_BUDGET_USD=

# Zalo OA - project-management channel (docs/multi-pm-telegram.md). Needs all three:
# the OA access token (expires after ~1 day, refresh it through Zalo's OAuth), the App ID
# and the OA secret (to check the webhook signature); and POST /zalo/webhook exposed
# publicly over HTTPS. Empty = off.
#ZALO_OA_TOKEN=
#ZALO_APP_ID=
#ZALO_OA_SECRET=
#ZALO_ALLOWED_USER=   # optional: the machine owner's private Zalo chat (legacy style)

# VieNeu TTS - Vietnamese voice that reads the PM's replies. Needs a python with 'vieneu' + 'torch':
#   python3 -m venv ~/.venv-vieneu
#   ~/.venv-vieneu/bin/pip install vieneu torch torchaudio --index-url https://download.pytorch.org/whl/cpu
# Check the model card's licence for the weights you use before relying on it.
# Empty = the browser's system voice (still reads aloud, just less nice).
#VIENEU_PYTHON=/home/youruser/.venv-vieneu/bin/python
ENVEOF
}
if [ ! -f "$ENV_FILE" ]; then
  if ao_vi; then write_env_vi; else write_env_en; fi
fi
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
say "Telegram (optional): fill in $ENV_FILE, then run: systemctl --user restart agent-office-daemon" \
  "Telegram (tuỳ chọn): điền $ENV_FILE rồi chạy: systemctl --user restart agent-office-daemon"
