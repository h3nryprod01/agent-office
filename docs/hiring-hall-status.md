# Hiring Hall — báo cáo work item `wi-hiring-hall`

_2026-07-08 · hiring-hall-engineer · branch `feat/hiring-hall` · session `afc3b2d2`_

## Làm gì

"Phòng tuyển dụng" trong office — UI của cặp skill user-level `company-hire` / `company-roster`:

1. **Quầy lễ tân clickable** — sprite `reception` (có sẵn từ makeover) đặt ở sàn trống cạnh lounge (`RECEPTION_DESK` 2.2,10.3), click → overlay **🪪 Tuyển dụng**.
2. **Panel roster thật** — `GET /roster` mới trên daemon đọc `~/.claude/company/roster.yaml` per request: phòng ban + trần budget/ngày + từng thành viên (role, ngày tuyển, tooltip source + scan verdict). Parser YAML **tối giản tự viết** (`packages/daemon/src/roster.js`) — không thêm dependency, giữ nguyên tắc "daemon chỉ có `ws`" (SPECS). Chịu được: inline/block member, quote chứa `:`/URL, comment, field lạ/thiếu; hỏng thì degrade roster rỗng, không 500.
3. **Form "Giao cho PM tuyển"** — POST /chat với template `"Dùng skill company-hire: tuyển <gap>. Báo cáo verdict scan + kết quả vào chat."` — đi qua PM + skill có sẵn (scan skillspector bắt buộc), **không spawn process riêng, không bypass**. Panel hiện "⏳ PM đang tuyển…" / "✅ PM xong turn" theo `chat_message` stream (tap raw frame có sẵn của main.ts, không mở WS mới).
4. **Walk-in chào sân** — daemon watch roster.yaml (fs.watch dir + debounce 300ms, chỉ emit khi **nội dung** đổi) → event additive `roster_updated` (meta.roster) → renderer diff thành viên → tên mới = nhân vật đi qua cửa vào, đứng chào 3s bubble "👋 <tên>", rồi biến mất. Render-only như CEO (label "· thành viên roster") — **không phải session sống**. Backlog replay/daemon restart không chào nhầm (guard `ts > mountTs` + baseline null không greet; removal không greet).

## Verify

- **Test**: daemon **90/90** (5 mới: parse fixture thật + GET /roster degrade + watcher emit-once + missing dir), renderer **146/146** (11 mới: diff/frame-guard/escape/prompt), `tsc --noEmit` sạch.
- **Verify thật (daemon worktree tạm cầm 8787, service khôi phục sau)**:
  - Panel mở từ click quầy lễ tân, hiện **roster thật 30→31 thành viên / 5 phòng** (có youtube-seo + CV scan SAFE từ đợt tuyển R8) — screenshot trong PR.
  - Giao PM tuyển thật gap **"thumbnail designer cho phòng media"** → PM chạy company-hire thật: check trùng roster ✓, rồi **báo trung thực "chưa tuyển được"** vì session chatbox `claude -p` bị chặn permission `gh`/web tool (hạn chế PM-chat có sẵn, không phải lỗi flow này) — panel chuyển trạng thái đúng, PM đề xuất 3 hướng trong chat.
  - Đóng vòng theo đúng Bước 1 company-hire ("skill đã cài sẵn → chỉ cần thêm roster"): thêm `canvas-design` vào phòng media → watcher bắn `roster_updated` → **nhân vật walk-in thật** vào office live 9-12 agent, label "canvas-design · thành viên roster", bubble "👋 canvas-design" (verify trong scene graph + screenshot); gỡ ra không chào (đúng), thêm lại chào (đúng).

## Bắt được 2 bug CSS có sẵn trên main (đã vá trong branch)

1. **`style.css:545` — `.orgchart .orgchart-toggle {` mất thân + dấu đóng** từ resolve conflict merge #19/#21. Vì CSS Nesting, dấu `{` treo nuốt **mọi rule phía sau** thành nested-rule chết: toàn bộ CSS costs panel + orgchart overlay **chưa từng chạy trên main**. Khôi phục thân rule (mirror `.costs-toggle`).
2. CSS sống lại làm lộ bug thứ hai: `display: flex` của overlay **đè thuộc tính `hidden`** → thêm `.hiring-overlay[hidden], .orgchart-overlay[hidden] { display: none }` (orgchart dính y hệt, chỉ chưa lộ vì bug 1).

## Giới hạn ghi nhận (không blocker)

- PM chatbox (`claude -p`) bị chặn `gh`/WebSearch/Bash permission → **tuyển end-to-end từ chatbox chưa tự động 100%**; PM degrade đúng kịch bản skill (báo thật + đề xuất). Muốn tuyển trọn vòng từ office: cần nới permission cho PM session hoặc duyệt qua approve gateway (#15) — việc của coordinator quyết.
- Walk-in chỉ spawn vào office **đang mở** (đúng chủ đích — nghi thức thị giác, không phải state).
- Parser YAML là subset (không anchor/multiline) — schema roster lớn hơn thì thay js-yaml, đã ghi chú trong code.

## Sau merge

**Bắt buộc `launchctl kickstart -k gui/$UID/com.agentoffice.daemon`** — service đang chạy code cũ, chưa có `GET /roster` + watcher (đã verify 404 sau khi khôi phục service).
