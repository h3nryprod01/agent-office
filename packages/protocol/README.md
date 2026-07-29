# @agent-office/protocol

> **STATUS: DRAFT (v0).** Đây là schema do renderer đề xuất để hai bên phát triển
> song song mà không chờ nhau. **PM/pipeline có toàn quyền sửa** — renderer được
> thiết kế để đổi theo với chi phí thấp (mọi chỗ tiêu thụ event đi qua một
> reducer duy nhất, `packages/renderer/src/sim/reducer.ts`).

Event contract giữa data pipeline (`packages/daemon`) và renderer
(`packages/renderer`). Một event = một message JSON trên WebSocket.

- TypeScript types: [`src/events.ts`](src/events.ts)
- JSON Schema (validate payload runtime/CI): [`schema/events.schema.json`](schema/events.schema.json)

## Nguyên tắc thiết kế

1. **Mỗi event tự đủ để vẽ** — có `agentId`, `parentId`, `sessionId`, `timestamp`.
   Renderer không phải join 2 event để render 1 frame.
2. **Không bịa dữ liệu** — `role` chỉ có giá trị khi pipeline suy ra được từ nguồn
   thật (`~/.claude/agents/*.md`), còn lại là `null` (theo nguyên tắc trong
   `docs/semantic-mapping.md`).
3. **Dễ đổi**: thêm field mới = non-breaking (renderer bỏ qua field lạ). Đổi
   tên/xóa field hoặc đổi ngữ nghĩa = bump `v`.

## Các event

| Type | Khi nào | Payload riêng |
|---|---|---|
| `session_started` | Session Claude Code mới xuất hiện | `cwd`, `label` |
| `session_ended` | Session kết thúc (Stop hook / timeout) | `reason` |
| `agent_spawned` | Nhân vật mới (root agent hoặc sub-agent, phân biệt qua `parentId`) | `name`, `role` |
| `agent_despawned` | Sub-agent xong việc, biến mất | `reason` |
| `agent_status_changed` | Trạng thái nhân vật đổi | `status`, `detail` |
| `tool_call_started` | Bắt đầu tool call (để animate ngay, không chờ kết quả) | `tool`, `toolUseId`, `detail` |
| `tool_call_finished` | Tool call xong | `tool`, `toolUseId`, `ok`, `detail` |
| `agent_message` | Text ngắn cho speech bubble | `text` |

`status` ∈ `working / reading / running_command / waiting_permission / blocked / error / idle / done`.

Quy ước id: **root agent của session có `agentId === sessionId`**, `parentId: null`.
Sub-agent dùng `agentId` thật từ transcript, `parentId` = agent đã spawn nó.

## Mapping từ daemon event stream v1 hiện tại

Daemon (`packages/daemon/src/event-schema.js`) đang phát schema phẳng
`{type: session_start|session_end|speak|tool_call, sessionId, tool, status, detail, ...}`.
Bảng dịch v1 → draft này (có thể làm bằng một adapter mỏng ở daemon hoặc ở renderer):

| Daemon v1 | Protocol draft v0 |
|---|---|
| `session_start` | `session_started` + `agent_spawned` (root, `agentId = sessionId`) |
| `session_end` | `session_ended` + `agent_despawned` |
| `speak` | `agent_message` (cắt ngắn cho bubble) |
| `tool_call` `status:"start"` | `tool_call_started` + `agent_status_changed` (suy status từ tool: Read/Grep/Glob→`reading`, Bash→`running_command`, còn lại→`working`) |
| `tool_call` `status:"ok"` | `tool_call_finished` (`ok: true`) |
| `tool_call` `status:"error"` | `tool_call_finished` (`ok: false`) + `agent_status_changed` (`error`, hoặc `waiting_permission`/`blocked` nếu detail chứa "has been denied") |
| _(chưa có nguồn)_ | `waiting_permission` real-time cần hook `PreToolUse` — xem câu hỏi mở #1 trong `docs/semantic-mapping.md` |

Những gì draft này **thêm** so với v1 và cần pipeline quyết:

- `agentId`/`parentId` tách khỏi `sessionId` — để vẽ sub-agent (`isSidechain`,
  `agent-*.jsonl`) thành nhân vật riêng có dây nối về agent cha.
- `agent_status_changed` là event tường minh thay vì để renderer tự suy — pipeline
  là nơi hiểu transcript, renderer chỉ vẽ. Nếu PM muốn giữ v1 và để renderer tự
  suy status thì cũng được — chỉ cần sửa adapter, không đụng phần vẽ.
