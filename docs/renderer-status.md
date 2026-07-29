# Renderer status — Frontend/Render Engineer

_Cập nhật: 2026-07-04 (lần 2 — E2E với daemon thật ĐÃ CHẠY). File này do session
renderer sở hữu — PM không cần sửa._

## 🎉 PoC end-to-end đã chạy với data thật

`packages/renderer/src/events/daemonV1Adapter.ts` dịch stream v1 của daemon →
draft v0 theo đúng bảng mapping trong `packages/protocol/README.md`. Chạy:
daemon (`npm start` trong `packages/daemon`) + renderer (`npm run dev`) → mở
`http://localhost:5199/?ws=1` → các session Claude Code **thật** trên máy hiện
thành nhân vật (ảnh: `docs/media/renderer-demo-live-e2e.jpg` — 19 session thật,
trong đó session renderer đang Focusing, demo-app-docs đang Reading ở kệ sách,
analytics-funnel đang Running ở arcade, và ~13 cron obsi-sync lỗi 401 nằm idle —
đúng loại tín hiệu "cần can thiệp" mà sản phẩm nhắm tới).

Adapter là code tạm, xoá được ngay khi daemon emit draft v0 native (8 unit tests
riêng cho adapter, tổng 24 tests).

## Đã xong (branch `feat/renderer-skeleton`)

- **`packages/protocol/`** — event schema **DRAFT v0**: TypeScript types
  (`src/events.ts`) + JSON Schema (`schema/events.schema.json`). 8 event types:
  `session_started/ended`, `agent_spawned/despawned`, `agent_status_changed`
  (8 status), `tool_call_started/finished`, `agent_message`. Mỗi event có
  `agentId`/`parentId`/`sessionId`/`timestamp`. README có sẵn **bảng mapping từ
  daemon schema v1** → draft này; PM/pipeline toàn quyền sửa.
- **`packages/renderer/`** — Vite + TS + PixiJS v8:
  - Văn phòng isometric placeholder (sàn tile, 16 bàn, kệ sách, máy arcade, bàn
    họp, cửa vào) — vẽ bằng Graphics, có điểm swap texture atlas ghi trong README.
  - Nhân vật capsule + tên + badge trạng thái (Focusing / Reading / Running /
    Approval❗ / Blocked❗ / Error⚠ / Available / Done); badge đỏ nhấp nháy cho
    blocked/waiting_permission; speech bubble 4s cho `agent_message`.
  - Di chuyển giữa trạm theo tool (Read→kệ sách, Bash→arcade, Task→bàn họp,
    Write/Edit→bàn); alert status đóng băng nhân vật tại chỗ.
  - Root agent đi từ cửa vào; sub-agent pop-in ở bàn họp; dây mảnh nối
    sub-agent → agent cha khi còn sống.
  - **Mock event source** phát scenario ~46s (PM spawn 4 sub-agents, 1 agent chờ
    duyệt quyền, 1 agent lỗi rồi hồi phục) qua interface `EventSource` — đúng
    interface mà WebSocket client thật dùng (`WebSocketEventSource` đã có sẵn,
    bật bằng `?ws=1`). UI Play/Pause/Speed(0.5–4x)/Restart + FPS counter.
  - State machine thuần (`sim/reducer.ts`, immutable, không dính Pixi) — 16
    vitest tests pass. Typecheck sạch.
- **Perf**: 35 nhân vật đồng thời = **1.04ms/frame** (tick+render, đo bằng
  `?stress=30`) — dư xa ngân sách 16.7ms của 60fps.
- Demo screenshots: `docs/media/renderer-demo-*.jpg`.

## Cần PM / pipeline khớp lại

1. **Chốt schema** (PM là người chốt cuối): daemon v1 phẳng vs draft v0 — bảng
   dịch + adapter chạy được đã có sẵn, nên quyết lúc nào cũng không block ai.
2. **`agentId`/`parentId` cho sub-agent**: daemon hiện chỉ có `sessionId`.
   Renderer đã sẵn sàng vẽ sub-agent thành nhân vật riêng + dây nối cha-con —
   cần pipeline phát `agent_spawned` với `parentId` từ `isSidechain`/`agent-*.jsonl`.
3. **`waiting_permission` real-time** cần hook `PreToolUse` (câu hỏi mở #1 của
   semantic-mapping) — renderer đã có badge ❗ nhấp nháy chờ sẵn.
4. **Boot replay flood**: daemon đọc mọi transcript từ byte 0 → client mới nhận
   hàng trăm nghìn event lịch sử. Adapter tạm lọc "chỉ nhận event trong 10 phút
   gần nhất"; đề xuất daemon thêm mode "tail từ EOF" (hoặc replay có giới hạn
   thời gian) thì bỏ được filter này.
5. **`session_end`**: v1 chưa phát → nhân vật idle tích tụ, không bao giờ rời
   văn phòng. Trùng với open question của daemon README (inactivity timeout vs
   Stop hook). Renderer sẽ vẽ despawn ngay khi có event.
6. **`speak` với `meta.kind: "thinking"`**: adapter đang bỏ qua, chỉ hiện text —
   nếu PM muốn hiện thinking (icon 💭?) thì nói, đổi 1 dòng.

## Chưa làm (chủ đích, chờ bước sau)

- Art assets thật (đang chờ Art Director — swap point ghi ở README renderer).
- Zone theo `cwd`/repo (mock 1 session, 1 zone); click nhân vật xem transcript
  (Mission Control, roadmap bước 2).
