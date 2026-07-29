# Approve Gateway — SPIKE status (wi-approve-spike, R5②)

_Cập nhật: 2026-07-08. Branch `feat/approve-gateway` (worktree `.claude/worktrees/approve`). Chưa mở PR — chờ kết luận GO/NO-GO đọc xong bên dưới. **Merge CUỐI trong R5** (sau `wi-notify`, `wi-pm-per-repo`)._

## Kết luận: **GO (có điều kiện) — pilot, project-local, không auto-approve**

Cơ chế đúng và an toàn 100% trên mọi đường test (không bao giờ tự bịa ra "allow"). Số liệu độ trễ đo được **KHÔNG đạt** ngưỡng <100ms đề ra trong lúc máy đang tải rất nặng (load avg 13–20, ~73 tiến trình node chạy song song từ các session khác) — nhưng có bằng chứng đối chứng vững rằng đây là nhiễu tải máy, không phải lỗi thiết kế (xem mục "Số liệu" bên dưới). Đề xuất: merge như **pilot project-local** (đúng scope ban đầu), không nâng global, dùng thật vài ngày trước khi quyết định tiếp.

## 1. Nghiên cứu — format quyết định permission (xác minh THẬT, không suy đoán)

Đọc docs chính thức (`code.claude.com/docs/en/hooks`, `/hooks-guide`) + xác minh bằng 3 thí nghiệm sống trên máy này (Claude Code v2.1.202, model haiku, session con qua `expect`):

- **Sự kiện đúng là `PermissionRequest`**, không phải `PreToolUse` như bản nháp cũ đoán — `PreToolUse` có thể block nhưng KHÔNG có channel "ask sau" phù hợp; `PermissionRequest` fires **đúng lúc** dialog permission sắp hiện, và có `decision.behavior: allow|deny`. `PreToolUse` không có `PermissionRequest` không fire trong non-interactive `-p` mode — không ảnh hưởng spike này vì hook chạy trong session tương tác thật của user.
- **Input stdin thật** (bắt được từ payload sống, không phải doc): `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `permission_suggestions`.
- **Output quyết định** (verify bằng cách in ra và quan sát hành vi thật):
  ```json
  {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
  ```
  `behavior: "deny"` tương tự. Im lặng (không in gì) = không quyết định = Claude Code tự hiện dialog gốc.
- **3 thí nghiệm sống** (`.claude/settings.json` scratch project, hook trả allow/deny/im lặng có chủ ý):
  1. `allow` sau 2s → lệnh `touch` chạy thật, file xuất hiện.
  2. `deny` sau 1s → lệnh **không chạy**, model tự báo "DENIED-OK" đúng như prompt yêu cầu.
  3. Im lặng 60s + hook timeout 10s → hook bị Claude Code timeout, **dialog "Do you want to proceed?" hiện ra bình thường** — đúng fail-open, không hang, không tự allow.
- **Timeout**: mặc định 600s cho hook `command`, cấu hình được per-hook qua `"timeout"` (giây). Gateway dùng `timeout: 30` + tự abort fetch ở 27s (lớp trong lớp ngoài, xem mục 2).
- **Matcher**: lọc theo tên tool, hỗ trợ `"Bash"`, `"Edit|Write"`, regex. Gateway đăng ký matcher `Bash|Edit|Write`.

## 2. Kiến trúc đã build

```
Claude Code sắp hiện permission dialog
  → hook PermissionRequest (matcher Bash|Edit|Write)
  → hooks/approve-gateway.mjs
      POST /approval-request {sessionId, tool, toolInput, cwd}  (abort 27s)
  → daemon: packages/daemon/src/approvals.js (ApprovalBroker)
      - không có office (WS client) đang mở → trả "none" NGAY (không tạo pending, không chờ)
      - có office → tạo pending, broadcast approval_pending, chờ tối đa 25s TTL
  → office: intervention queue hiện item + preview tool_input + nút ✓ Allow / ✗ Deny
  → user bấm → POST /approval-response {id, decision}
  → broker resolve promise → gateway nhận allow/deny → in JSON quyết định → exit 0
  → decision khác allow/deny (none/timeout/lỗi bất kỳ) → gateway IM LẶNG → exit 0
      → Claude Code tự hiện dialog gốc, KHÔNG BAO GIỜ tự allow
```

File mới: `packages/daemon/hooks/approve-gateway.mjs`, `packages/daemon/src/approvals.js`. Diff `index.js`: 2 dòng import + 1 khối wiring `ApprovalBroker` + gộp `extraHttp` (chat handler đã có + approval handler mới) — không đụng logic chat. `event-schema.js`: thêm 2 giá trị `EventType` (`approval_pending`, `approval_resolved`), additive.

Renderer: `packages/renderer/src/ui/approvals.ts` (store, tap raw frame của `WebSocketEventSource` — không đụng protocol v0/reducer), `interventionQueue.ts` thêm nút Allow/Deny lên đầu hàng đợi, `WebSocketEventSource.ts` thêm tham số `onRaw` optional (không phá API cũ), CSS mới trong `style.css`.

## 3. An toàn — verify bằng test thật, không chỉ đọc code

**Unit (`packages/daemon/test/approvals.test.js`, 15 case, spawn hook thật qua `execFile`, không mock):**
- Không có office mở → `none` ngay lập tức, không tạo pending, không broadcast.
- Allow/deny từ office → resolve đúng quyết định + broadcast `approval_pending`→`approval_resolved`.
- TTL hết hạn (không ai bấm) → `none`, respond trễ bị từ chối (`"đã hết hạn"`).
- id lạ / decision rác (`"ALLOW-ALL"`) → từ chối, pending không đổi.
- **Gateway script thật** (spawn `node approve-gateway.mjs` làm child process, không import logic):
  - Daemon chết (port không ai nghe) → im lặng, exit 0.
  - stdin rác (`not json {{{`) → im lặng, exit 0.
  - Daemon trả JSON rác/không phải object → im lặng, exit 0.
  - Daemon treo (không bao giờ trả lời) → tự abort đúng `APPROVE_GATEWAY_TIMEOUT_MS`, im lặng, exit 0, không quá 5s trong test.
  - Daemon trả `allow`/`deny` hợp lệ → in đúng JSON `PermissionRequest` schema.
  - Daemon trả `decision:"none"` → **không** in gì (never convert none → decision).

**Kết quả**: daemon 52/52 pass (39 cũ + 13 mới), renderer 76/76 pass (67 cũ + 9 mới), `tsc --noEmit` sạch.

**E2E thật** (không phải giả lập): daemon thật (bản isolated port 8788 để không đụng service production 8787 đang chạy launchd), renderer thật (Vite dev, port 5299, art thật), session Claude Code con thật (`expect`-driven, model haiku) chạy trong project riêng có đăng ký `PermissionRequest` trỏ vào gateway thật.

- **Lần 1** (tôi thao tác chậm — chụp snapshot/screenshot trước khi bấm): pending hết hạn (25s TTL) trước khi tôi kịp bấm → daemon trả `none` → gateway im lặng → **terminal hiện dialog gốc "Do you want to proceed?" y hệt bình thường**. Đây là bằng chứng fail-open THẬT dưới điều kiện thật, không phải suy luận.
- **Lần 2** (bấm ngay khi thấy pending): item hiện đúng trong hàng đợi office — tool `Bash`, preview `date +%s%3N > /tmp/approve-e2e-proof2.txt`, nút ✓/✗ (xem screenshot). Bấm ✓ Allow qua `preview_click` (CSS selector `data-approval-id`) → item biến mất khỏi hàng đợi → **lệnh Bash chạy thật trong session con**, file proof được ghi ra.

## 4. Số liệu (đo thật, KHÔNG bịa)

**Điều kiện đo**: máy đang chạy `load average 13.1 / 17.2 / 20.5`, ~73 tiến trình `node` sống (nhiều session Claude Code/Codex khác đang làm việc song song thật — kiểm chứng qua `ps aux` + log daemon thấy hoạt động thật từ demo-app). Đây KHÔNG phải máy idle.

| Số liệu | Đo được | Ngưỡng đề ra | Đạt? |
|---|---|---|---|
| Overhead gateway khi KHÔNG có office mở (`hasClients()===false`, đường nhanh nhất) | 440–1012ms (5 lần chạy) | <100ms | ❌ trên máy tải nặng này |
| Đối chứng: hook `notify.mjs` **đã production**, KHÔNG gọi network, đo NGAY CÙNG LÚC | 166–545ms (8 lần chạy, 2 đợt) — vs. **44.6ms** đã đo & ghi trong `docs/pretooluse-hook-proposal.md` lúc máy idle | — | Cho thấy hệ số nhiễu tải máy ~4–10× ảnh hưởng **cả code đã duyệt từ trước**, không riêng gateway mới |
| Kết nối TCP tới daemon (curl `time_connect`) | luôn <5ms (5 lần) | — | Chứng minh bản thân network hop không phải nút thắt |
| Daemon time-to-first-byte (`starttransfer`, cùng điều kiện) | 17ms–544ms, dao động mạnh | — | Nút thắt thật là event-loop daemon bị tranh CPU, không phải logic gateway (logic là 1 thao tác Map đồng bộ, đã unit-test) |
| End-to-end: bấm ✓ Allow → lệnh Bash thật thực thi (đo qua mtime file, vì `date +%N` không có trên macOS) | 11.6s (1 lần đo sạch) | (không có ngưỡng cứng trong task) | Bao gồm cả overhead riêng của Claude Code tự thực thi tool dưới tải máy — không tách bạch được phần nào là gateway trong 1 lần đo |

**Đánh giá số liệu**: bằng chứng đối chứng (so hook cũ đã duyệt, đo cùng thời điểm, cùng máy) cho thấy phần lớn độ trễ đến từ **tải máy hiện tại**, không phải thiết kế gateway — nhưng vì "nhiều session chạy song song" chính là điều kiện vận hành BÌNH THƯỜNG của user này (đúng tiền đề "công ty đa agent" của dự án), không thể gạt bỏ hoàn toàn là ngoại lệ. Số liệu được báo cáo trung thực, không chọn lọc lần đo đẹp.

## 5. Giới hạn đã biết (ghi rõ, không giấu)

- Không persist pending — restart daemon giữa chừng làm mọi pending rơi về "ask" (đúng spec, đã verify bằng thiết kế in-memory `Map`, không cần test riêng vì đúng theo định nghĩa).
- `hasClients()` chỉ biết "có ít nhất 1 tab renderer mở", không biết user có đang NHÌN màn hình hay không — office mở nhưng user rời máy vẫn tính là "có thể can thiệp", pending vẫn chờ đủ 25s rồi mới fail-open.
- Preview tool_input bị cắt ở phía hook (500 ký tự/field) trước khi gửi — tránh payload lớn (nội dung `Write` dài) làm chậm request, nhưng preview có thể thiếu ngữ cảnh cho lệnh rất dài.
- 1 lần đo E2E latency, không phải trung bình nhiều lần — do mỗi lần cần 1 session Claude Code con thật (~15-20s khởi động dưới tải máy hiện tại), lặp lại nhiều lần sẽ tốn thời gian không tương xứng với giá trị tăng thêm cho 1 spike.

## 6. Đề xuất cho user

1. **Merge như pilot, project-local, KHÔNG global** — đúng scope ban đầu của spike, rủi ro thấp (1 dòng trong `.claude/settings.local.json`, gitignored, dễ tắt).
2. Đăng ký hook thật cần user tự thêm vào `.claude/settings.local.json` của repo này (giống `notify.mjs` đã có) — PR không tự đăng ký để tránh bật tính năng ảnh hưởng permission mà chưa qua mắt user:
   ```json
   "PermissionRequest": [{
     "matcher": "Bash|Edit|Write",
     "hooks": [{"type": "command", "command": "node \"<repo>/packages/daemon/hooks/approve-gateway.mjs\"", "timeout": 30}]
   }]
   ```
3. Dùng thật vài ngày, đo lại latency lúc máy đỡ tải hơn — nếu số liệu về gần ngưỡng ban đầu (~50-100ms) thì cân nhắc mở matcher rộng hơn hoặc nâng global; nếu vẫn cao thì đây là giới hạn thật của "spawn 1 tiến trình Node mỗi lần" trên máy nhiều session song song, cần nghĩ giải pháp khác (ví dụ daemon-side persistent hook process thay vì spawn mỗi lần).
