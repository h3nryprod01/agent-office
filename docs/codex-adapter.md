# Codex Adapter — OpenAI Codex CLI rollout → event schema v1

_Nguồn dữ liệu: rollout JSONL thật dưới `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl` — đã đọc trực tiếp 245 file thật trên máy này (codex-cli 0.142.x, cả CLI lẫn Codex Desktop/vscode), không đoán format. Cùng nguyên tắc với `docs/semantic-mapping.md`: mọi dòng mapping phải trỏ về field có thật; chỗ nào suy luận sẽ ghi rõ._

## 1. Shape dữ liệu thật đã xác nhận

- Mỗi session (thread) Codex = **một file rollout riêng**, tên file chứa thread id (uuid v7). Mỗi dòng: `{"timestamp": iso8601, "type": <record type>, "payload": {...}}`.
- Record types thật (đếm trên 218 file, 113k dòng): `session_meta`, `turn_context`, `response_item`, `event_msg`, `compacted`, `inter_agent_communication`.
- `session_meta.payload`: `session_id`, `cwd`, `originator` ("Codex Desktop"), `cli_version`, `thread_source` (`"user"` | `"subagent"`), `source`. File resume ghi lại `session_meta` nhiều lần (~9 lần/file trung bình).
- **Sub-agent**: thread con có rollout file RIÊNG với `thread_source: "subagent"` và `source.subagent.thread_spawn.{parent_thread_id, depth, agent_nickname, agent_role}`. `parent_thread_id` chính là `session_id` của rollout file cha → parentId resolve trực tiếp, không cần registry/toolUseId như phía Claude Code. (Phía cha có `function_call` tên `spawn_agent`/`wait_agent`/`close_agent` và `event_msg` `sub_agent_activity`, nhưng file con là nguồn giàu tín hiệu hơn.)
- **Tool call**: `response_item.payload.type = "function_call"` (`name`, `arguments` = JSON string, `call_id`) hoặc `"custom_tool_call"` (`name`, `input` = plain string, `call_id`). Kết quả là dòng `"function_call_output"`/`"custom_tool_call_output"` khớp qua `call_id`. Tool names thật phổ biến: `exec_command`, `exec`, `apply_patch`, `write_stdin`, `update_plan`, `spawn_agent`, MCP tools…
- **Không có flag `is_error`** trong output. Lỗi suy ra từ preamble Codex ghi vào đầu output: `Process exited with code N` (function_call_output) hoặc `Exit code: N` (custom_tool_call_output). `output` có thể là string hoặc mảng block `{type, text}`.
- Text assistant hiển thị cho user: `event_msg.payload.type = "agent_message"` (`message` plain text). `response_item` type `"message"` là scaffolding role user/developer; `"reasoning"` bị mã hoá (`encrypted_content`) — không đọc được.
- `turn_context.payload.cwd` có thể đổi giữa các turn → phải cập nhật cwd theo.
- Web search: `response_item` type `"web_search_call"` (đã `status: "completed"`, có `action.query`) — chỉ xuất hiện 1 lần, không có cặp start/end.
- Bookkeeping (bỏ qua): `event_msg` `token_count` (chiếm ~46% số dòng!), `task_started`, `task_complete`, `turn_aborted`, `patch_apply_end`/`exec_command_end`/`mcp_tool_call_end` (echo của cặp response_item), `compacted`/`context_compacted` (nén ngữ cảnh).

## 2. Bảng ánh xạ → event schema v1

Tái dùng đúng các `EventType` hiện có (`session_start`/`session_end`/`speak`/`tool_call`), không thêm type mới. Mọi event từ nguồn này có `harness: "codex"` (field mới, additive, mặc định `"claude-code"` cho nguồn cũ — renderer dùng để đổi skin nhân vật).

| Codex record (field thật) | Event v1 | Ghi chú |
|---|---|---|
| `session_meta` (lần đầu trong file) | `session_start`, status `start` | `sessionId`/`agentId` = thread id; `cwd` từ payload; `meta.{originator, cliVersion, agentNickname}` |
| `session_meta` với `thread_source:"subagent"` | như trên + `parentId` = `source.subagent.thread_spawn.parent_thread_id` | Map thẳng vào khái niệm parentId/dây liên lạc cha–con của semantic-mapping §3 |
| `turn_context` | (không emit) | chỉ cập nhật `cwd` cho các event sau |
| `response_item` `function_call` / `custom_tool_call` | `tool_call`, status `start` | `tool` = `name`; `detail` từ `arguments.cmd/command/query/message` hoặc raw input; id = `<call_id>:start` |
| `response_item` `*_call_output` | `tool_call`, status `ok`/`error` | pair qua `call_id`; `error` khi output chứa exit code ≠ 0 (regex `Process exited with code N` / `Exit code: N`) — **suy luận từ text, không phải flag chuẩn** |
| `response_item` `web_search_call` | `tool_call` `web_search`, status `ok` | 1 event duy nhất (đã completed sẵn) — khớp zone "cửa sổ" #6 của semantic-mapping |
| `event_msg` `agent_message` | `speak`, status `ok` | `detail` = message truncate 140 ký tự; id = counter theo file (ổn định qua restart vì thứ tự dòng trong file ổn định) |
| (không có dòng "session closed") | `session_end` | tái dùng `SessionEndMonitor` inactivity timeout chung, y như nguồn Claude Code |

## 3. Khác biệt với nguồn Claude Code (điều renderer nên biết)

1. **Không có trạng thái "blocked chờ quyền" quan sát được**: session trên máy này chạy `approval_policy: never` + `sandbox: danger-full-access`, chưa thấy record xin phê duyệt nào trong data thật. Chấm đỏ Mission Control cho Codex là việc tương lai (cần data thật có approval prompt, hoặc kênh khác).
2. **Sub-agent rẻ hơn**: parentId có ngay trong `session_meta` của file con — không cần lazy resolution.
3. **`reasoning` bị mã hoá** → nhân vật Codex không có bong bóng "thinking", chỉ có `speak` từ `agent_message`.
4. Codex có `agent_nickname` (Lovelace, Franklin…) cho sub-agent — dùng luôn làm `agent` (tên hiển thị nhân vật) vì tên folder cwd trùng nhau giữa các sub-agent cùng repo; vẫn giữ trong `meta.agentNickname`.
5. **Backfill cutoff khi boot**: rollout file idle lâu hơn `backfillMaxAgeMs` (mặc định 5 phút — bằng session inactivity timeout) khi daemon thấy lần đầu sẽ tail từ EOF, không replay lịch sử. Lý do: session idle quá timeout sẽ `session_end` ngay sau backfill (nhân vật chết vô nghĩa) và có file lịch sử 96MB. An toàn vì Codex ghi lại `session_meta` mỗi lần resume (data thật ~9 lần/file); edge case process sống viết tiếp không resume được cover bằng synthetic `session_start` (`meta.inferred: true`). Env override: `CODEX_BACKFILL_MAX_AGE_MS`.

## 4. Verify

- **Data thật**: replay 218+ rollout files thật (113k+ dòng) qua `CodexSessionNormalizer` → 24.323 events, 0 vi phạm schema, 0 `unknown_tool` (call_id pairing khớp 100%), 202 sub-agent session resolve đúng `parentId`, nickname thật (Boyle, Sartre, Arendt…) thành tên nhân vật.
- **Boot cutoff**: daemon boot với toàn bộ lịch sử idle → 0 event backfill thừa (trước đó: ~20k event burst + parse file 96MB).
- **Live tail**: chạy daemon với cả 2 nguồn, chạy `codex exec` sinh rollout file mới → daemon bắt được `session_start` (codex) trong vòng 1 poll tick, song song với event claude-code trên cùng WebSocket.
- Unit tests: `packages/daemon/test/codex-normalize.test.js` (`npm test` trong `packages/daemon`).
