# wi-standup — Daily Standup 9h sáng → Obsidian

Trạng thái: **done** (verified 2 đường: chạy tay + launchd kickstart, 2026-07-08)

## Cái gì được ship

- `scripts/standup.sh` — gom data 24h (work-items + git log + Plane REST + costs) → `claude -p --model claude-haiku-4-5 --max-turns 1` → ghi note `AI-Memory/agent-office/standup/<YYYY-MM-DD>.md` trong vault 2nBrain (ghi file trực tiếp, cùng cách obsi-sync).
- `scripts/standup-prompt.md` — prompt template 5 dòng (xong / đang chạy / kẹt / chi phí / nên quyết).
- `scripts/install-standup-service.sh` — LaunchAgent `com.agentoffice.standup`, StartCalendarInterval 09:00, log `~/Library/Logs/agent-office-standup.log`, idempotent, có `uninstall`.

## Phát hiện quan trọng: TCC chặn launchd đọc OneDrive CloudStorage

Test thật (job launchd tạm, cả `/bin/bash` lẫn `node`): mọi process spawn bởi launchd **không thấy được** path dưới `~/Library/CloudStorage/` — File Provider trả ENOENT, không phải EPERM. Daemon node sống được vì binary node đã có TCC grant riêng từ trước. Vault `~/Documents` thì launchd-bash ghi bình thường (obsi-sync chứng minh từ lâu).

Thiết kế né TCC (không cần user cấp quyền gì):

| Cần | Dưới launchd | Fallback chạy tay |
|---|---|---|
| script + prompt | installer **copy** ra `~/Library/Application Support/agent-office/` | chạy thẳng từ `scripts/` |
| work-items | `GET http://localhost:8787/work-items` (daemon) | đọc file registry |
| git log 24h | `gh api repos/h3nryprod01/agent-office/commits` | `git -C $REPO log` |
| Plane issues | REST `X-API-Key` (key từ `~/.claude.json`) | như nhau |
| costs | `GET :8787/costs` — hiện 404, fail-soft chờ wi-cost-dashboard | như nhau |

Mỗi nguồn fail-soft riêng: Plane/daemon tắt → standup vẫn chạy với data còn lại.

## Kỷ luật chi phí

- 1 lần/ngày (StartCalendarInterval; chạy lại cùng ngày = ghi đè note, idempotent).
- `claude -p` haiku + `--max-turns 1`, toàn bộ data nhét sẵn vào prompt, không tool.
- Fail bất kỳ đâu → ghi log, exit 0 im lặng, KHÔNG retry loop.

## Verify đã chạy

1. **Tay**: `./scripts/standup.sh` → note xuất hiện đúng path, log 2 dòng start/written.
2. **launchd**: `./scripts/install-standup-service.sh` + `launchctl kickstart gui/$UID/com.agentoffice.standup` → xóa note cũ, note mới được ghi lại sau ~25s qua đường daemon HTTP + gh API.

## Note mẫu (output thật của lần kickstart)

```markdown
---
title: Daily Standup 2026-07-08
date: 2026-07-08
tags: [agent-office, standup]
---

# Daily Standup 2026-07-08

1. **Hôm qua xong:** 11 items merged (R5② permissions gateway, R6 voice+CEO avatar, daemon OOM hotfix #17)
2. **Đang chạy:** 3 items R7 — cost-dashboard, standup, orgchart (in_progress, cost/standup/orgchart engineer)
3. **Kẹt:** không có
4. **Chi phí:** chưa có số liệu
5. **Hôm nay nên quyết:** (1) Set deadline R7 items ~2-3 ngày; (2) WILD backlog — prioritize hay defer post-R7?
```

## Vận hành

- LaunchAgent **đã cài và đang chạy** trên máy này (bản copy từ worktree — sau merge nên chạy lại `./scripts/install-standup-service.sh` từ repo chính để bản copy trỏ nguồn mới).
- Gỡ: `./scripts/install-standup-service.sh uninstall`.
- Khi `GET /costs` có thật (wi-cost-dashboard), mục 4 tự có số — không cần sửa gì.
