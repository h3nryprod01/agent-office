# Agent Office — Specs tổng hợp

_Cập nhật: 2026-07-08. Nguồn chân lý trạng thái: `.claude/memory/activeContext.md` + Plane AGOF; file này là bức tranh tổng thể, cập nhật theo mốc lớn._

## Sản phẩm là gì

Simulator web chạy local, biến các **Claude Code / Codex CLI agent thật** đang chạy trên máy thành nhân vật hoạt hình trong văn phòng isometric pixel-art (kiểu Gather/Teamflow). Không phải mô phỏng giả lập — mọi nhân vật, trạng thái, hành động đều từ data thật, real-time.

**Câu hỏi sản phẩm phải trả lời nhanh hơn terminal: "Tôi cần can thiệp ở đâu?"**

## Kiến trúc

```
NGUỒN DATA (đọc, không xâm lấn)
  ~/.claude/projects/**/*.jsonl        transcript Claude Code (root + sub-agent + workflow)
  ~/.codex/sessions/**/rollout-*.jsonl Codex CLI (harness thứ 2)
  ~/.claude/agent-office-hook-events.jsonl  PreToolUse/PostToolUse hook (project-local pilot)
        │ tail + normalize (dedupe, parentId resolve, repo derive từ cwd kể cả worktree)
        ▼
DAEMON — packages/daemon (Node thuần, KHÔNG dependency ngoài `ws`)
  • launchd service com.agentoffice.daemon (RunAtLoad + KeepAlive, heap cap 768MB,
    log ~/Library/Logs/agent-office-daemon.log) — scripts/install-daemon-service.sh
  • WS ws://127.0.0.1:8787 — event schema v1 (additive-only), per-session ring buffer
    (100/session, LRU evict >50 session), session_end theo inactivity 5' 
  • HTTP cùng port: GET /transcript · GET /work-items · GET /costs?window=24h|7d|30d
    · POST /chat · POST /approval-request|/approval-response
        ▼
PROTOCOL — packages/protocol (draft v0 + daemonV1Adapter phía renderer)
        ▼
RENDERER — packages/renderer (Vite + TS + PixiJS v8, DOM panels, KHÔNG chart/graph lib)
  • live mode mặc định; ?mock=1 = scenario dev; auto-reconnect backoff + label offline
  • 60fps @ 30+ nhân vật là ràng buộc cứng
```

## Tính năng đã ship (PR #1–#21 merged)

**Văn phòng & nhân vật** — pixel-art isometric; skin theo vai + harness (exec-navy cho PM/CEO, robot-steel cho Codex); 8 trạng thái/skin (idle, walk, typing, reading, blocked giơ tay, error gục bàn, talking); trạm ngữ nghĩa: bàn làm việc = coding, kệ sách = đọc file, máy arcade = chạy lệnh, bàn họp = giao việc sub-agent (mapping: `docs/semantic-mapping.md`); decor Teamflow-style + bàn CEO.

**Multi-office** — tab per repo (derive từ cwd, resolve worktree về repo gốc) + tab All; badge số nhân vật + chấm đỏ alert; **hàng đợi can thiệp XUYÊN office** (click alert → chuyển tab + pan camera).

**Mission Control** — click nhân vật → side panel (trạng thái, tool đang chạy, timeline, transcript thật qua GET /transcript, work item + deep link **Plane / Obsidian / PR**); hàng đợi "cần can thiệp" xếp theo mức khẩn; `waiting_permission` real-time qua hook (grace window 2s chống nhiễu).

**Điều hành từ office**
- **Chatbox → PM stateless per repo**: mỗi tin = 1 turn `claude -p --resume` thật, PM spawn lazy đúng cwd repo của tab; PM đọc work-items/git/Plane để trả lời; nhân vật PM ngồi bàn CEO.
- **Voice**: mic Web Speech (vi-VN) vào chatbox + TTS đọc reply.
- **Duyệt permission trong office** (pilot, GO có điều kiện): PermissionRequest hook gateway → nút ✓/✗ trên queue; fail-open tuyệt đối về "ask", không bao giờ auto-approve.
- **CEO avatar**: nhân vật của bạn; agent chờ duyệt đi bộ đến xếp hàng trước bàn CEO.
- **macOS notification** khi agent kẹt >30s (terminal-notifier click-to-open, dedup per đợt kẹt, `AGENT_OFFICE_NOTIFY=0` tắt).

**Quan sát & sổ sách**
- **Replay/time-lapse**: ghi event trong trình duyệt, scrubber 1×–60×, export/import JSON.
- **Cost dashboard**: parse `message.usage` từ transcript (dedupe theo message.id — transcript ghi tới 9 bản/response; cache_read 0.1× input; model lạ = unknown không đoán) → panel chi phí per repo/agent/ngày.
- **Board mini** (đếm work item) trên tường.

## Lớp "công ty đa agent" (Company Protocol v1 — docs/company-protocol.md)

- **Work item**: Plane self-host (workspace mission-control, project **AGOF**) = nguồn chân lý; registry `.claude/memory/work-items.json` = cầu nối sang office UI; outbox `.claude/memory/plane-outbox.jsonl` khi Plane tắt (replay idempotent). Plane MCP lệch version → dùng REST trực tiếp.
- **PM stateless**: não nằm ở Plane + registry + repo memory; bất kỳ session nào cũng thành PM.
- **Giao thức báo cáo 5 mục** (Did/Verified/Links/Blockers/Next) bắt buộc với mọi agent được giao việc; ngưỡng <30 phút thì miễn nghi thức.
- **Skill user-level** (dùng cho mọi dự án): `company-pm`, `company-report`, `company-board`.
- Kỷ luật thi công: worktree riêng bắt buộc, phân vùng file khi giao việc, squash-merge qua PR, coordinator đối chiếu thật trước khi đóng item.

## Vận hành

- Daemon: launchd, tự hồi sinh (verified kill -9), shutdown sạch (force-exit backstop 2s).
- Standup 9h sáng (PR #20, đang mở): LaunchAgent gọi `claude -p` (Haiku) tổng hợp → note Obsidian vault 2nBrain.
- Renderer dev: `npm --prefix packages/renderer run dev` (port 5199). KHÔNG chạy daemon qua npm — service sở hữu 8787.
- Test hiện tại trên main: daemon 77/77 · renderer 106/106 · tsc sạch.

## Đang bay (PR mở / chip đang chạy)

- PR #22 anim round 3 (walk cycle, easing, z-sort, shadow + fix vị trí CEO) — merge trước makeover.
- PR #19 org chart sống (cây parentId, click pan) · PR #20 standup.
- Chip Office makeover (phase 1 assets đang chạy; phase 2 sau #22): tường + phòng, agent ngồi ghế, props dày, **bảng tường render work-items + costs THẬT**, ánh sáng ấm.

## Backlog & mốc sau

Wild cards đã duyệt: building view (tòa nhà, mỗi tầng 1 repo), timelapse export video, ambient sound. R8 (open-source, đóng gói `npx agent-office`) — quyết sau khi tự dùng. Backlog kỹ thuật: sub-agent hook attribution, hook/gateway nâng global, PM re-read registry mỗi turn, giá model fable-5 vào PRICING_TABLE.

## Lịch sử quyết định & chi tiết

`.claude/memory/decisions.md` (bảng đầy đủ) · `docs/*-status.md` (báo cáo từng work item) · Plane AGOF (issue + comment 5 mục).
