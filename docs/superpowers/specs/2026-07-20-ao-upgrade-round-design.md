# AO Upgrade Round — Task Ancestry · Budget Hard-Stop · Zalo Channel

- **Ngày:** 2026-07-20
- **Trạng thái:** Design đã duyệt, trước writing-plans
- **Bối cảnh:** brainstorm sau khi port AO sang Ubuntu (commit `afa57a3`), đọc `paperclipai/paperclip` (74k sao) để mượn ý tưởng.

## Định vị (vì sao đúng 3 cái này)

Paperclip là incumbent trưởng thành cùng hạng mục "công ty đa agent" (company/org/goal/task-ancestry/budget/approval/adapter/plugin). AO **không** xây lại control plane đó — đó là ném công sức vào thứ đã 74k sao. AO đặt cược vào cái paperclip KHÔNG có: **văn phòng 3D + OS-notification + local-first + kênh Việt**. Vòng nâng cấp này chỉ mượn **ý tưởng làm mạnh chính bề mặt AO**, cộng một bản địa hóa. Ba cái được chọn là ROI cao nhất cho niche đó.

## Ràng buộc chung (đã kiểm bằng code hiện tại, KHÔNG đoán)

1. **AO chỉ điều khiển agent qua cổng approval** (`packages/daemon/src/approvals.js` — `POST /approval-request` / `/approval-response`, giữ dialog quyền của Claude Code) và `POST /chat/stop` (`chat-session.js`). **KHÔNG kill cứng tiến trình.** ⇒ mọi "cưỡng chế" đều là *giữ approval*, không phải giết agent.
2. **`parentId` hiện có = agent cha** (sub-agent → root), KHÔNG phải task-cha. Task ancestry cần link MỚI trên work-item.
3. **Cầu Telegram** (`packages/daemon/src/telegram.js`: `isAllowed`/`nextOffset`/`askPm`, secret qua `EnvironmentFile` 600) là khuôn mẫu cho Zalo.
4. **Chi phí tính ở** `usage-costs.js` / `usage-parsers.js` / `usage-pricing.js`, per-harness. Một số model giá = `unknown` (USD của non-Claude bị đếm thiếu). Ngưỡng ngân sách phải xử lý `unknown-price`: đếm được token nhưng KHÔNG cưỡng chế USD được cho model đó → chỉ alert.

## Non-goals (cả vòng)

- KHÔNG xây lại control plane của paperclip (governance/RBAC/policy engine).
- KHÔNG plugin system, KHÔNG multi-user auth (AO single-operator local-first).
- KHÔNG adapter boundary lần này — hoãn tới khi có nhu cầu thật chạy OpenClaw/Hermes làm worker.
- KHÔNG để agent tự khai task-cha (tránh rác); KHÔNG kill cứng tiến trình.

---

## Feature A — Task Ancestry (làm ĐẦU TIÊN)

### Mục đích
Mọi việc trả lời được "tại sao tôi làm cái này" bằng chuỗi cha lên tới company goal. Đây là ý tưởng số 1 của paperclip, và AO hiện thực nó ở chỗ paperclip không có: **gắn vào gương mặt agent trong office 3D**, không phải một dòng text trong dashboard.

### Data model
- Work-item thêm trường `parentItemId?: string` (nối tới work-item khác). Gốc chuỗi là company goal đọc từ `goals.md` (đã được `projects.js`/`templates.js` biết tới).
- Mở rộng cơ chế `fromIdea` sẵn có: khi PM tạo việc từ một việc/ý tưởng, set `parentItemId`.

### Components
- `packages/renderer/src/sim/` — selector THUẦN `ancestryOf(itemId, itemsById): Item[]` trả chuỗi `[việc → cha → … → goal]`. Pure, test được không cần WebGL.
- Office 3D: hover agent → panel **"Vì sao"** tái dùng `toBusiness`/`statusLabelVi` (de-jargon đã có) để hiển thị chuỗi.

### Data flow
work-item (`parentItemId`) → reducer dựng `itemsById` → `ancestryOf` fold ngược lên goal → panel render khi hover/select agent gắn với item đó.

### Quyết định
- MVP: **PM gắn cha thủ công** khi giao việc (mở rộng nút "Giao cho PM"). Không auto-infer, không bắt agent tự khai.
- `ancestryOf` phải chống **cycle** (A→B→A) và **orphan** (`parentItemId` trỏ item đã xóa) — dừng an toàn, không lặp vô hạn.

### Testing
Unit thuần cho `ancestryOf`: chuỗi tới goal; parent thiếu → dừng ở item cuối tìm được; **cycle → không treo**; item không cha → chuỗi 1 phần tử. Mutation-test: bỏ cycle-guard → test cycle phải fail.

### Out of scope
Agent tự khai cha; auto-inference; sửa nhiều-cha (một cha đủ cho MVP).

---

## Feature C — Budget Hard-Stop (làm THỨ HAI)

### Mục đích
Chặn "đốt token ngầm" khi chạy tự hành. Paperclip coi budget là control-plane feature cốt lõi; AO làm bản tối giản dùng đúng cổng đã có.

### Config
Ngưỡng USD/company trong `project.json` (ví dụ `budgetUsd`). Không có ngưỡng → tính năng tắt (mặc định).

### Logic
`usage-costs.js` đã cộng dồn chi phí per-harness → thêm cờ dẫn xuất `over_budget = totalUsd >= budgetUsd`.

### Enforcement
Khi `over_budget`: `approvals.js` **hold** mọi `POST /approval-request` mới (chuyển sang chờ người duyệt vượt) + bắn alert "Vượt ngân sách" qua `notifier.js` (đã cross-platform sau port).

### Suy biến (nói thẳng trần)
- Agent KHÔNG đi qua cổng approval → chỉ alert được, không phanh được.
- Model giá `unknown` (Codex/Gemini) → USD đếm thiếu ⇒ ngưỡng USD không cưỡng chế chính xác cho phần đó; bổ sung cảnh báo theo token nếu cần, nhưng V1 chỉ enforce trên tổng USD đã biết.

### Quyết định
**Hold-for-human**, KHÔNG deny cứng: over-budget thì việc mới kẹt ở "chờ bạn duyệt vượt", bạn quyết cho chạy tiếp hay dừng. Dùng đúng cổng approval sẵn có, an toàn hơn deny mù.

### Testing
`over_budget` fold khi cost qua ngưỡng (biên: đúng bằng ngưỡng = over); gateway hold khi over, cho qua khi dưới. Mutation: đảo dấu so sánh → test biên fail.

### Out of scope
Kill cứng tiến trình; sub-budget per-agent (company-level trước); dự báo chi phí.

---

## Feature B — Zalo Channel cho PM (làm CUỐI)

### Mục đích
PM/công ty chạm tới được qua **Zalo** — bản địa hóa cho khách #1 người Việt. Mở rộng đúng pattern cầu chat, KHÔNG kéo cả OpenClaw vào.

### Component
`packages/daemon/src/zalo.js` song song `telegram.js`, tái dùng cùng `chatManager`/`askPm`. Wiring ở `index.js` giống `pollUpdates` (gate theo env, thiếu env → no-op im lặng).

### Đặc thù Zalo OA (rủi ro thật, khác Telegram)
- Zalo OA = **webhook inbound** + **Message API outbound** (khác long-poll `getUpdates` của Telegram).
- **OA access token HẾT HẠN định kỳ** → cần refresh-token flow. Đây là chi phí thật so với bot-token Telegram vĩnh viễn.
- **Prerequisite từ khách:** tài khoản Zalo OA + app credentials. Không có → tính năng vô dụng (nêu rõ trong doc cài đặt).
- **Quyết định (user 2026-07-20): ship dạng PLACEHOLDER.** Installer tạo sẵn ô env Zalo (comment, giống khối Telegram trong `install-daemon-service-linux.sh`) để khách tự điền OA token/secret SAU. Thiếu env → `zalo.js` no-op im lặng, daemon chạy bình thường. Code + test đầy đủ nhưng dormant cho tới khi khách cấu hình. Không có mock/stub giả trạng thái "đã kết nối".

### Security
`isAllowed` theo Zalo user id = biên giới tin cậy (endpoint webhook công khai) — **bắt buộc mutation-test** như `telegram.js`. Secret (OA token, app secret) qua `EnvironmentFile` 600, NGOÀI repo.

### Testing
`isAllowed` (chuỗi vs số, sai id, sự kiện lạ); parse webhook payload; refresh-token (token hết hạn → refresh → gửi lại). Mutation-test biên giới tin cậy.

### Out of scope
Các kênh OpenClaw khác (WhatsApp/iMessage/…); chạy OpenClaw làm gateway; inbound đa-user.

---

## Thứ tự thi công: A → C → B (lý do)

- **A** cao nhất + thuần renderer/sim → ít rủi ro daemon, khác biệt hóa mạnh nhất.
- **C** nhỏ + tái dùng cổng approval đã có.
- **B** phụ thuộc khách có OA + refresh-token phức tạp nhất → chốt cuối.

Mỗi feature là một đơn vị độc lập: có thể spec → plan → thi công → verify riêng, không chặn nhau.
