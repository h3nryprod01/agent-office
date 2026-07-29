# Replay / Time-lapse — Status (Frontend Engineer chip)

_Cập nhật: 2026-07-07. Branch `feat/replay` (worktree `.claude/worktrees/replay`). Renderer-only — KHÔNG đụng `packages/daemon`._

## ✅ Đã ship

1. **Event recorder** (`src/replay/recorder.ts`): ghi mọi event vào ring buffer 50k (trim amortized — overflow 25% rồi cắt, không trả O(n) mỗi event). Ghi cả live WS lẫn mock, chạy ngầm từ lúc mở trang, kể cả khi đang replay.
2. **Rebuild state tại T** (`src/replay/playback.ts`): `ReplayCursor.stateAt(t)` — event-sourcing thuần trên reducer sẵn có. Seek tiến = feed delta (incremental); seek lùi = rebuild từ đầu (O(n) trên ≤50k event, vài chục ms — có `ponytail:` comment về checkpoint nếu sau này cần).
3. **Timeline bar** (`src/ui/timelineBar.ts`, mount dưới giữa màn hình): ▶/⏸, tốc độ 1×/4×/16×/60×, scrubber kéo tới thời điểm bất kỳ, nút **● LIVE** quay về hiện tại. Tương tác playback nào cũng snapshot recorder rồi tách khỏi live stream — live state vẫn update ngầm bên dưới. Clock replay dùng delta `performance.now()` (giống MockEventSource) — tab nền throttle setInterval, cộng cứng theo tick sẽ chậm 10× (bug đã gặp và fix khi verify).
4. **Export/Import JSON**: 💾 download `{format:"agent-office-replay", version:1, exportedAt, events:[...]}`; 📂 hoặc kéo-thả file vào trang để nạp phiên khác. Import validate format, drop entry hỏng, sort lại theo timestamp. File sai → message ngắn, không crash.
5. **Time-lapse polish**: tốc độ ≥4× nhân vật teleport tới station (không walk tween, không bob), speech bubble tắt, badge trạng thái giữ nguyên. Side panel nhận virtual clock khi replay nên "đã bao lâu" đọc theo trục thời gian của recording. Scrub lùi về trước lúc spawn → puppet bị cull đúng (thêm check agent-vanished trong `AgentLayer.cullRemoved`).

## ✅ Verified (mock mode, vite trong worktree, port 5299)

- 11 test mới (`test/replay.test.ts`): recorder cap/trim, export→import roundtrip, reject file lạ, sort + drop entry hỏng, stateAt đúng biên, incremental == fresh rebuild, seek lùi. Tổng suite: **49 pass**, `tsc --noEmit` sạch.
- End-to-end trong browser: play 4× đúng nhịp (2s thực = 8s replay), 60× chạy hết rồi auto-pause, scrub tới 60% → replay state 1 agent trong khi live state 5 agents (tách stream đúng), LIVE quay về hiện tại, import 40 event từ chính file export, file rác báo "Không phải file replay Agent Office". FPS 120 khi live.

## Giới hạn đã biết

- **Persistence = export/import JSON thủ công**, đúng scope đã giao (không đụng daemon). Refresh trang là mất recording nếu chưa export.
- Ring buffer 50k: phiên rất dài sẽ rơi event cũ → replay bắt đầu giữa chừng (reducer tự tạo stub agent, không crash).
- Replay dùng chung slot/desk assignment với live (`nextSlot` không reset) — scrub qua lại nhiều lần nhân vật vẫn đúng station theo state, chỉ khác desk slot so với phiên gốc nếu puppet bị cull rồi spawn lại.
- Hoàn thành task lớn chưa có confetti — bỏ qua vì không "rẻ" (cần định nghĩa "task lớn" từ event stream; đề xuất để round polish sau).
- `#controls` (mock) dời lên `bottom: 64px` nhường chỗ timeline bar — 1 dòng CSS, chỉ ảnh hưởng mock mode.

## Cần PM quyết

1. **Format export** `agent-office-replay v1` (events nguyên bản protocol v0) — ok chưa, hay muốn thêm metadata (label phiên, người export)?
2. Ngưỡng teleport hiện là **≥4×** (1× vẫn walk + bubble). Muốn 1× replay giống hệt live, hay 4× cũng nên walk?
3. Confetti khi task lớn hoàn thành: làm ở round sau hay bỏ hẳn?
