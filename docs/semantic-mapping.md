# Semantic Mapping — sự kiện Claude Code → nhân vật trong Agent Office

_Nguồn dữ liệu: JSONL transcript thật dưới `~/.claude/projects/**/*.jsonl` (đã đọc trực tiếp nhiều file trên máy này để lấy field name thật, không đoán), cộng với cấu trúc hook chuẩn của Claude Code (`PreToolUse`/`PostToolUse`/`Stop`/`SessionStart`/`Notification`) và định nghĩa subagent trong `~/.claude/agents/*.md`._

**Nguyên tắc bắt buộc:** mọi dòng trong bảng dưới phải trỏ được về một field/sự kiện có thật. Nếu không tìm thấy field thật, ghi rõ ở cột "Nguồn" là suy luận/giả định — không giấu.

---

## 1. Shape dữ liệu thật đã xác nhận

Đọc trực tiếp từ transcript trên máy (`~/.claude/projects/.../*.jsonl`):

- Mỗi dòng là 1 JSON object, field `type` ∈ `{"user", "assistant", "system", "attachment", "queue-operation", "last-prompt"}`.
- Message của assistant: `message.role = "assistant"`, `message.content` là mảng block gồm `{"type": "thinking", ...}`, `{"type": "text", "text": ...}`, `{"type": "tool_use", "id", "name", "input", "caller": {"type": "direct"}}`.
- Tool gọi thấy trong dữ liệu thật: `Bash`, `Read`, `Write`, `Edit`, `Skill`, `ToolSearch`, `AskUserQuestion`, và các `mcp__<server>__<tool>`.
- Kết quả tool nằm trong message `role: "user"` tiếp theo, block `{"type": "tool_result", "tool_use_id", "content", "is_error"?}`. Ngoài ra có field song song `toolUseResult` ở cấp top-level của dòng JSONL (không nằm trong `message`) — chứa version đã parse sẵn (vd exit code, success flag).
- **Permission bị từ chối** có shape cụ thể: `tool_result.is_error = true`, `content = "Permission to use Bash with command <cmd> has been denied."`. Đây là trạng thái **sau khi** quyết định đã xảy ra — file JSONL không ghi lại khoảnnh "đang chờ" (pending), vì dòng chỉ được ghi khi turn hoàn tất. Điều này ảnh hưởng trực tiếp tới thiết kế: **muốn có tín hiệu "blocked" real-time (không phải hồi tố), daemon phải lắng nghe hook `PreToolUse` xin quyền, không thể chỉ tail transcript.**
- Sự kiện hệ thống thật thấy trong data: `type: "system"` với `subtype` ∈ `{"turn_duration", "away_summary", "local_command", "compact_boundary", "api_error", "stop_hook_summary", "model_refusal_fallback"}`.
  - `stop_hook_summary` liệt kê từng hook đã chạy khi Stop: `hookInfos: [{command, durationMs}]`, `hookErrors`, `preventedContinuation`. Đây là bằng chứng trực tiếp hook `Stop` tồn tại và có thể quan sát được qua transcript.
  - `compact_boundary` đánh dấu nén ngữ cảnh (`compactMetadata.trigger: "auto"|"manual"`).
- Mỗi dòng có `cwd` (đường dẫn project thật) và `gitBranch` — đây là cơ sở thật để suy ra "zone/phòng ban" (mỗi cwd/repo = một khu vực văn phòng) và context của agent.
- **Sub-agent thật sự tồn tại trên đĩa** dưới dạng file riêng: `<project>/<sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl` (+ `agent-<agentId>.meta.json` chứa `{"agentType": "workflow-subagent"}`), song song với `<runId>/journal.jsonl` ghi log điều phối. File workflow gốc `<sessionId>/workflows/<runId>.json` chứa script định nghĩa từng agent con và role của nó bằng free-text prompt (không có field `role` chuẩn hoá).
- Trong transcript chính (không phải workflow), field đánh dấu 1 dòng thuộc sub-agent là `isSidechain: true` + `agentId`, `promptId` — xác nhận có thật (đếm được hàng nghìn dòng `isSidechain: true` trên máy này).
- Không bắt được lời gọi `tool_use.name == "Task"` nào trong data hiện có trên máy này (setup của user dùng workflow/devfleet thay vì Task tool cổ điển) — mapping cho `Task` bên dưới dựa trên **contract chuẩn đã công bố** của Claude Code (`name: "Task"`, `input: {subagent_type, description, prompt}`), đánh dấu rõ là suy luận từ tài liệu, không phải quan sát trực tiếp trên máy này.
- Vai trò agent (`coder`/`tester`/`reviewer`/`PM`...) **không có field chuẩn hoá** trong transcript. Nguồn thật duy nhất để suy luận role: front-matter của file trong `~/.claude/agents/*.md` (vd `name: code-reviewer`, `description: ...`, `tools: [...]`, `model: sonnet`) khi agent được gọi qua Task/subagent_type khớp tên file đó; hoặc suy từ nội dung prompt hệ thống của workflow script (free text, không có field).

---

## 2. Bảng ánh xạ chính

| # | Sự kiện Claude Code (field thật) | Hành động nhân vật | Vị trí/zone văn phòng | Chỉ báo trạng thái |
|---|---|---|---|---|
| 1 | `tool_use.name = "Read"` | Ngồi bàn, cầm tài liệu lên đọc (pose "reading") | Bàn riêng của agent (own desk) | Chấm xanh dương nhạt, icon 📄 nhỏ trên đầu |
| 2 | `tool_use.name = "Write"` | Gõ bàn phím nhanh, giấy mới xuất hiện trên bàn | Bàn riêng | Chấm xanh lá (active), icon ✏️ |
| 3 | `tool_use.name = "Edit"` | Gõ bàn phím + gạch xoá trên giấy đang có (pose khác Write để phân biệt sửa vs tạo mới) | Bàn riêng | Chấm xanh lá, icon 🖊️ |
| 4 | `tool_use.name = "Bash"` | Đứng dậy, đi tới máy trạm/terminal góc phòng, gõ lệnh | Trạm "server room" / góc máy chủ riêng | Chấm vàng (đang chạy), icon `>_` nhấp nháy khi lệnh còn chạy |
| 5 | `tool_use.name = "Task"` (contract chuẩn Claude Code — chưa quan sát trực tiếp trên máy này, suy luận từ tài liệu) | Đi tới bảng trắng, viết brief rồi "gọi" một nhân vật mới xuất hiện | Meeting room / phòng giao việc | Chấm tím trên agent cha (đang chờ subagent), nhân vật con pop-in kèm hiệu ứng "poof" |
| 6 | `tool_use.name = "WebFetch"` / `"WebSearch"` | Ra khỏi bàn, đứng trước "cửa sổ lớn" nhìn ra ngoài (ẩn dụ internet) | Zone cửa sổ / "phòng nghiên cứu" gần lối vào | Chấm xanh dương đậm, icon 🔍 |
| 7 | `tool_use.name` khớp `mcp__*` (bất kỳ MCP tool nào) | Đi tới máy fax/quầy liên lạc ngoài (ẩn dụ gọi hệ thống ngoài) | "Mailroom" — quầy liên lạc riêng, tách khỏi bàn làm việc | Chấm màu tím nhạt, icon 🔌 + tooltip tên server MCP (lấy từ tiền tố `mcp__<server>__`) |
| 8 | `tool_use.name = "Skill"` (`input.skill`) | Đi tới tủ hồ sơ, lấy ra một "cẩm nang" cụ thể rồi mang về bàn | Filing cabinet / tủ tài liệu | Chấm xanh dương, icon 📘 kèm tên skill |
| 9 | `tool_use.name = "AskUserQuestion"` | Quay ra phía người xem, giơ tay, dấu hỏi lớn trên đầu | Tại chỗ (không di chuyển) | Chấm cam, icon ❓ to, có thể kèm rung nhẹ để thu hút chú ý |
| 10 | `tool_result.is_error = true` với content chứa `"has been denied"` (permission denied) | Đứng khựng lại trước cửa, tay đưa ra chặn, biểu cảm bối rối | Ngay tại vị trí đang thao tác (không đổi zone) | **Chấm đỏ + dấu chấm than ❗ nhấp nháy — ưu tiên cao nhất, đây là trạng thái "Mission Control" phải nổi bật nhất** |
| 11 | `tool_result.is_error = true` (lỗi khác, không phải permission) | Cúi xuống nhìn giấy, gãi đầu (pose "confused") | Tại chỗ | Chấm cam đậm, icon ⚠️ |
| 12 | Hook `PreToolUse` (yêu cầu quyền, chưa có quyết định — chỉ quan sát được real-time qua hook, KHÔNG thấy trong transcript tail vì dòng transcript chỉ ghi sau khi turn xong) | Đứng trước cửa có biển "cần phê duyệt", tay gõ cửa | Ngay tại vị trí thao tác | **Chấm đỏ đặc + icon ❗ + viền nhân vật nhấp nháy — trạng thái quan trọng nhất toàn bộ sản phẩm (roadmap "Mission Control")** |
| 13 | Hook `PostToolUse` | (thoáng qua) nhân vật gật đầu, đặt vật xuống bàn | Tại chỗ | Chấm xanh lá nhạt trong 1 khung hình rồi chuyển tiếp sang trạng thái kế |
| 14 | Hook `Stop` / system event `subtype: "stop_hook_summary"` (field thật: `hookInfos[].command`, `durationMs`, `hookErrors`, `preventedContinuation`) | Đứng dậy, dọn bàn, ngồi lại ghế nghỉ (idle) | Bàn riêng | Chấm xám "Available". Nếu `hookErrors` không rỗng → chấm cam nhỏ cảnh báo hook lỗi |
| 15 | Hook `SessionStart` | Nhân vật mới "đi vào cửa văn phòng", ngồi xuống bàn được gán | Từ cửa ra vào → bàn riêng (animation di chuyển) | Chấm xanh lá, hiệu ứng "walk in" |
| 16 | Hook `Notification` (agent cần chú ý — vd đợi lâu không phản hồi) | Vẫy tay / bật đèn bàn làm việc sáng lên | Tại chỗ | Chấm vàng nhấp nháy, icon 🔔 |
| 17 | Agent đang chờ user trả lời (turn kết thúc bằng `stop_reason` không phải `tool_use`, hoặc `AskUserQuestion` đang treo) | Ngồi yên, quay mặt ra, tay khoanh | Bàn riêng | Chấm xám nhạt "Available", có thể thêm bong bóng chat 💬 |
| 18 | Agent đang chạy (đang có `tool_use` chưa nhận `tool_result` tương ứng — turn còn mở) | Theo đúng hành động ở dòng #1–8 tương ứng loại tool | Theo zone tương ứng | Chấm xanh lá "Focusing", icon xoay tròn nhỏ (spinner) cạnh nhân vật |
| 19 | System event `subtype: "compact_boundary"` (`compactMetadata.trigger`) | Nhân vật chớp mắt, "trí nhớ" hiện lên rồi mờ dần (ẩn dụ nén ngữ cảnh) | Tại chỗ | Chấm xanh dương nhạt thoáng qua, icon 🧠, tooltip hiển thị `preTokens` |
| 20 | System event `subtype: "away_summary"` | Nhân vật để lại "ghi chú giấy" trên bàn trước khi biến mất khỏi văn phòng | Bàn riêng → rời khỏi zone | Chấm xám, icon 📝 tóm tắt nội dung `content` |
| 21 | System event `subtype: "local_command"` (slash command người dùng gõ, vd `/btw`) | Có "tiếng chuông" từ ngoài, nhân vật ngẩng đầu nhận lệnh mới | Tại chỗ | Flash ngắn viền vàng quanh nhân vật |
| 22 | System event `subtype: "api_error"` | Nhân vật đứng sững, dấu X đỏ trên đầu | Tại chỗ | Chấm đỏ, icon ✖️ — mức độ ưu tiên cao (gần bằng permission-blocked) |

---

## 3. Nhiều agent / sub-agent chạy song song

**Nguồn thật:** field `isSidechain: true` + `agentId` trong transcript chính, và với workflow multi-agent, file JSONL riêng biệt mỗi agent tại `subagents/workflows/<runId>/agent-<agentId>.jsonl` (đã đếm >10.000 dòng `isSidechain: true` trên máy này, và liệt kê được hàng chục file `agent-*.jsonl` song song trong một `runId`).

Quy tắc hiển thị:

- Mỗi `agentId` mới xuất hiện lần đầu → nhân vật mới **"pop in"** giữa văn phòng (hiệu ứng khói/hiện dần), không phải "đi từ cửa vào" như session gốc — để phân biệt trực quan "được sinh ra bởi agent khác" và "user tự mở session".
- Vẽ một đường kẻ mảnh (dây liên lạc) từ nhân vật con về bàn của agent cha (`parentUuid`/agent đã gọi `Task`/workflow) trong lúc subagent còn hoạt động — giúp trả lời "ai đang chờ ai" nhanh hơn terminal.
- Khi subagent kết thúc (dòng cuối trong file `agent-<agentId>.jsonl`, hoặc file `journal.jsonl` của workflow ghi hoàn tất) → nhân vật "biến mất" (fade out), dây liên lạc biến mất theo.
- Nếu nhiều agent cùng làm trong một `cwd`/repo → xếp chung một zone/phòng ban (đặt tên phòng theo tên thư mục repo, lấy từ `cwd`). Agent khác `cwd` → phòng ban khác, để "tôi cần can thiệp ở đâu" đọc được ngay qua vị trí trên bản đồ mà không cần click vào từng nhân vật.
- Giới hạn thực tế: transcript **không có field `role` chuẩn hoá cho subagent**. Không tự vẽ nhãn "Tester"/"PM" nếu không suy ra được — tránh bịa dữ liệu (vi phạm nguyên tắc "data thật là linh hồn").

## 4. Suy luận vai trò (role) — chỉ khi có căn cứ

Vai trò **không phải field thật** trong transcript. Suy luận theo thứ tự ưu tiên, và khi hiển thị UI **phải phân biệt được "suy luận" và "chắc chắn"** (vd nhãn mờ hơn hoặc icon (?) nhỏ cạnh tên vai trò suy luận):

1. **Chắc chắn nhất:** nếu `Task`/workflow gọi tên khớp một file trong `~/.claude/agents/<name>.md`, đọc frontmatter `name`/`description` của file đó làm nhãn vai trò (vd `code-reviewer` → "Reviewer", `tdd-guide` → "QA/Tester", `planner` → "PM/Planner"). Đây là dữ liệu có thật trên đĩa, không phải đoán.
2. **Trung bình:** nếu không khớp file agent nào, suy từ pattern tên/mô tả (free text) trong prompt gọi subagent hoặc workflow script (vd script `demo-app-redesign-qa` có "Review" / "Verify" phases → gán tạm "Reviewer" / "Verifier"). Đánh dấu suy luận (icon mờ).
3. **Không suy luận được:** hiển thị nhãn trung tính "Agent" + `agentId` rút gọn, không bịa vai trò.
4. `cwd`/`gitBranch` của mỗi dòng transcript dùng để gán **zone** (không phải vai trò) — ví dụ agent làm trong nhánh `feat/video-dia` xuất hiện ở khu vực gắn nhãn tên nhánh/repo đó.

## 5. Ưu tiên hiển thị trạng thái "cần can thiệp" (Mission Control — roadmap bước 2)

Đây là câu hỏi sản phẩm phải trả lời nhanh hơn terminal, nên độ ưu tiên hiển thị (khi nhiều trạng thái xảy ra cùng lúc, trạng thái ưu tiên cao hơn thắng và quyết định màu chấm + có che các icon phụ):

1. **Blocked chờ phê duyệt quyền** (hook `PreToolUse` đang treo, hoặc suy ra ngay sau khi thấy `tool_result` "has been denied" mà agent vẫn đang cố lại) — chấm đỏ đặc, ❗, hiệu ứng nhấp nháy viền, và **đây là lý do bắt buộc phải có kênh hook real-time** (Notification/PreToolUse) chứ không chỉ tail transcript — vì transcript chỉ lộ trạng thái này *sau khi* đã bị từ chối, không phải *trong lúc* đang chờ.
2. Lỗi API / lỗi tool không phục hồi được (`api_error`, `is_error` liên tục lặp lại) — chấm đỏ, ✖️.
3. Đang chạy việc dài (Bash chưa trả kết quả quá N giây) — chấm vàng, có thể chuyển sang cam nếu vượt ngưỡng thời gian cấu hình được.
4. Đang chờ user trả lời (AskUserQuestion treo, hoặc turn kết thúc không có tool_use tiếp theo) — chấm cam nhạt.
5. Đang làm việc bình thường (tool_use có tool_result trong thời gian hợp lý) — chấm xanh lá.
6. Idle / Stop / away — chấm xám.

---

## Câu hỏi mở cho PM

1. **Kênh real-time cho "blocked chờ quyền":** transcript JSONL không lộ được trạng thái pending permission — chỉ lộ kết quả denied sau khi xong. Để có chấm đỏ ❗ *đúng lúc đang treo* (không phải hồi tố vài giây sau), daemon cần hook riêng (`PreToolUse` gửi sự kiện qua stdin/exit code hoặc ghi file/socket) chạy song song với việc tail transcript. Xác nhận: có OK để scope PoC (Aquarium, bước 1 roadmap) chỉ tail transcript và chấp nhận "blocked" là tín hiệu hồi tố (delay vài giây), rồi để bước 2 (Mission Control) mới thêm hook thật?
2. **Vai trò subagent:** vì không có field `role` chuẩn hoá, việc gán "Coder/Tester/PM/Reviewer" phụ thuộc vào việc agent đó có khớp tên file trong `~/.claude/agents/*.md` hay không. Với setup hiện tại của user (nhiều multi-agent chạy qua workflow script tự viết, không phải `Task` tool chuẩn), phần lớn sẽ rơi vào nhãn "Agent" trung tính. Có chấp nhận việc phần lớn nhân vật con hiển thị nhãn chung ở PoC đầu, và việc gắn vai trò chi tiết là cải tiến sau (cần parse thêm workflow script)?
3. **Trên máy này chưa quan sát được `tool_use.name == "Task"` thật** (chuẩn Claude Code) — chỉ thấy cơ chế workflow/devfleet riêng của user. Mapping cho `Task` (#5 trong bảng) dựa trên tài liệu công khai, chưa verify bằng data thật. Cần verify khi có session nào đó thật sự dùng Task tool chuẩn (không qua devfleet) trước khi khoá cứng animation "pop-in" đó.
4. **Zone theo `cwd`:** nhiều agent cùng project nhưng khác git worktree (`--claude-worktrees-*`) có `cwd` khác nhau dù là "cùng một project" về mặt khái niệm. Có nên gộp chung 1 zone theo tên repo gốc (bỏ hậu tố worktree) hay tách riêng — ảnh hưởng trực tiếp tới cách vẽ bản đồ văn phòng.
