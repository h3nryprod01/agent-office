#!/bin/bash
# Daily standup — tổng hợp 24h của Agent Office thành 1 note Obsidian (vault 2nBrain).
# Chạy bởi launchd 09:00 (install-standup-service.sh) hoặc tay: ./scripts/standup.sh
#
# Repo đã rời OneDrive CloudStorage (TCC/File Provider chặn launchd) → nay là local
# ~/Projects/agent-office, launchd chạy thẳng script tại chỗ, không cần bản copy.
# daemon HTTP + `gh api` vẫn là fallback fail-soft khi git/file không đọc được.
# Kỷ luật: 1 lần/ngày (note theo ngày, chạy lại = ghi đè), fail thì log rồi thoát im lặng, KHÔNG retry.
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
GH_REPO="h3nryprod01/agent-office"
VAULT="$HOME/Documents/Projects/2ndBrain/2nBrain"
NOTE_DIR="$VAULT/AI-Memory/agent-office/standup"
TODAY="$(date +%Y-%m-%d)"
NOTE="$NOTE_DIR/$TODAY.md"
LOG="$HOME/Library/Logs/agent-office-standup.log"
CLAUDE_CLI="$HOME/.local/bin/claude"
MODEL="claude-haiku-4-5"
DAEMON="http://localhost:8787"
PLANE_BASE="http://localhost:8080"
PLANE_WS="mission-control"
# ponytail: project id AGOF cố định (1 project duy nhất); đổi project thì sửa dòng này
PLANE_PROJECT="62907022-3cf2-4caf-be81-7a61d5e77f5f"
PROMPT_FILE="$SCRIPT_DIR/standup-prompt.md"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }
die() { log "FAIL: $*"; exit 0; }  # thoát im lặng, không retry

mkdir -p "$(dirname "$LOG")"
log "standup start"

[ -x "$CLAUDE_CLI" ] || die "claude CLI not found at $CLAUDE_CLI"
[ -d "$VAULT" ] || die "vault not found at $VAULT"
[ -f "$PROMPT_FILE" ] || die "prompt template not found at $PROMPT_FILE"

# ── Gom data (mỗi nguồn fail-soft: thiếu thì ghi chú, standup vẫn chạy) ──
CTX="$(mktemp)"
trap 'rm -f "$CTX"' EXIT

{
  cat "$PROMPT_FILE"
  echo; echo "Ngày: $TODAY"; echo

  echo "## work-items (registry)"
  curl -sf -m 5 "$DAEMON/work-items" 2>/dev/null \
    || cat "$REPO/.claude/memory/work-items.json" 2>/dev/null \
    || echo "(daemon tắt và repo không đọc được — bỏ qua)"

  echo; echo "## git log 24h"
  git -C "$REPO" log --since=24hours --pretty='- %h %s (%an, %ar)' 2>/dev/null \
    || gh api "repos/$GH_REPO/commits?since=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)&per_page=50" \
         --jq '.[] | "- \(.sha[0:7]) \(.commit.message | split("\n")[0])"' 2>>"$LOG" \
    || echo "(git và GitHub API đều không đọc được — bỏ qua)"

  echo; echo "## Plane issues (AGOF)"
  PLANE_KEY="$(jq -r '.mcpServers.plane.env.PLANE_API_KEY // empty' "$HOME/.claude.json" 2>/dev/null)"
  if [ -n "$PLANE_KEY" ]; then
    PLANE_API="$PLANE_BASE/api/v1/workspaces/$PLANE_WS/projects/$PLANE_PROJECT"
    # states trả về UUID → in bảng id→tên để model map
    curl -sf -m 10 -H "X-API-Key: $PLANE_KEY" "$PLANE_API/states/" 2>>"$LOG" \
      | jq -r '.results[] | "state \(.id) = \(.name)"' 2>>"$LOG" \
      || echo "(Plane states không đọc được)"
    curl -sf -m 10 -H "X-API-Key: $PLANE_KEY" "$PLANE_API/issues/?per_page=100" 2>>"$LOG" \
      | jq -r '.results[] | "- \(.name) | state:\(.state) | updated:\(.updated_at)"' 2>>"$LOG" \
      || echo "(Plane không phản hồi — bỏ qua)"
  else
    echo "(không có Plane API key — bỏ qua)"
  fi

  echo; echo "## costs (daemon GET /costs)"
  curl -sf -m 5 "$DAEMON/costs" 2>/dev/null || echo "(chưa có endpoint /costs — bỏ qua)"
  echo
} >"$CTX"

# ── Gọi claude -p (headless, 1 lượt, không tool) ──
# ponytail: không có `timeout` trên máy này — job 1 lần/ngày, hang thì mai ghi đè
STANDUP="$("$CLAUDE_CLI" -p --model "$MODEL" --max-turns 1 <"$CTX" 2>>"$LOG")" \
  || die "claude -p failed (see log)"
[ -n "$STANDUP" ] || die "claude -p returned empty output"

# ── Ghi vault (file trực tiếp, cùng cách obsi-sync) ──
mkdir -p "$NOTE_DIR"
{
  echo "---"
  echo "title: Daily Standup $TODAY"
  echo "date: $TODAY"
  echo "tags: [agent-office, standup]"
  echo "---"
  echo
  echo "# Daily Standup $TODAY"
  echo
  echo "$STANDUP"
} >"$NOTE"

log "standup written: $NOTE"
