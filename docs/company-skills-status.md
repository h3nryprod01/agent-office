# Company skill suite — status (wi-company-skills)

_Skill Builder · 2026-07-07 · Company Protocol v1 (`docs/company-protocol.md`)_

## Đã ship

3 skill **user-level** tại `~/.claude/skills/` (ngoài repo — dùng được cho mọi dự án, không cần branch/worktree cho phần skill):

| Skill | Gọi | Làm gì |
|-------|-----|--------|
| `company-pm` | "làm PM", "điều phối", "chạy công ty", "giao việc cho agents" | Biến session hiện tại thành PM stateless (protocol mục 4): đọc Plane/registry → đối chiếu git/PR/sessions thật → hành động. Kèm template prompt giao việc tiêm sẵn giao thức báo cáo (mục 3) + kỷ luật worktree/vùng file (mục 5) + ngưỡng <30 phút. |
| `company-report` | Được tiêm vào prompt agent, không dành cho user gọi trực tiếp | 5 mục Did/Verified/Links/Blockers/Next, 3 bước đúng thứ tự: Plane (hoặc outbox khi tắt) + registry → send_message coordinator nếu sống → Obsidian chỉ khi có insight tái dùng. |
| `company-board` | "board", "ai đang làm gì", "tình hình agents" | Bảng terminal read-only từ Plane + work-items.json + list_sessions + gh pr list; cảnh báo lệch pha: done-chưa-merge, agent im >30 phút, PR mồ côi, outbox ứ đọng. |

Cả 3 degrade gracefully khi Plane tắt (protocol mục 1): check liveness bằng curl 3s, tắt thì làm việc trên registry + ghi outbox, không block.

## Verified

- Tự chạy các bước `/company:board` trong repo này lúc Plane OFF: bảng ra đúng 5 work item in_progress trong registry thật, khớp session sống (`wi-deeplinks` → session "Nối work-items vào side panel" đang chạy), bắt đúng cảnh báo 3 chip round-4b chưa start + 5 dòng outbox pending.
- Cả 3 skill được Claude Code nhận diện trong danh sách available skills sau khi ghi file.

## Chưa làm (chủ đích)

- Chưa chạy eval loop định lượng của skill-creator (skill dạng quy trình nội bộ, verify bằng chạy thật hợp hơn benchmark).
- Naming `/company:pm` dạng hai chấm không khả dụng cho user-level skill (colon là namespace của plugin) → dùng `company-pm`/`company-report`/`company-board` như đã dự phòng trong đề bài.
