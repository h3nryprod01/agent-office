# Cost đa-harness — status (wi-cost-multiharness)

`/costs` trước đây chỉ đọc transcript Claude Code → **mù 2/3 harness**. Từ giờ nó gộp cả **Codex** và **Gemini CLI**, và trả thêm `byHarness`. Đây là điều kiện cần để dùng Agent Office tính P&L cho đơn hàng thật (team marketing BĐS).

_Nguyên tắc: data thật là linh hồn. Mọi con số dưới đây đọc từ file thật trên máy này (249 rollout Codex + session Gemini thật). Không có giá nào bị bịa._

## 0. Khảo sát data thật (làm TRƯỚC khi viết code)

### Gemini — CÓ token thật

`~/.gemini/tmp/<slug>/chats/session-*.json`, field `tokens` trên mỗi message `gemini`:

```json
{"model":"gemini-3-flash-preview",
 "tokens":{"input":5205,"output":32,"cached":2683,"thoughts":162,"tool":0,"total":5399}}
```

Hai bất biến **đã kiểm trên mọi message thật**:

- `total == input + output + thoughts + tool` (đúng 100% mẫu)
- `cached < input` → **`cached` là TẬP CON của `input`**, không cộng thêm.

Suy ra ánh xạ: `cacheRead = cached`; `input(billable) = input − cached + tool`; `output = output + thoughts` (thoughts = reasoning, tính giá output). `tool` (= `toolUsePromptTokenCount`, phía prompt) **= 0 ở toàn bộ data thật**, vẫn cộng vào input cho khớp `total`.

`cwd` KHÔNG nằm trong file chat (chỉ có `projectHash`) → đọc `.project_root` cạnh `chats/`.

### Codex — CÓ token thật (câu trả lời là CÓ, không phải "unknown")

`~/.codex/sessions/**/rollout-*.jsonl`, record `event_msg` / `payload.type == "token_count"`:

```json
{"info":{"last_token_usage":  {"input_tokens":26004,"cached_input_tokens":4992,"output_tokens":345,
                               "reasoning_output_tokens":104,"total_tokens":26349},
         "total_token_usage": {"...":"cộng dồn cả session"}}}
```

Bất biến đã kiểm: `total_tokens == input_tokens + output_tokens`, `cached_input_tokens ⊂ input_tokens`, `reasoning_output_tokens ⊂ output_tokens`. Không có bộ đếm cache-creation → `cacheWrite = 0`.

**Cái bẫy double-count (quan trọng nhất của work item này):** Codex phát lại một event `token_count` mang **y hệt** `last_token_usage` khi chỉ có `rate_limits` đổi — và ở những event đó `total_token_usage` **đứng yên**. Cộng thẳng `last_token_usage` sẽ thổi phồng hoá đơn.

Quy tắc chốt: **bỏ qua event nào có `total_token_usage.total_tokens` bằng event được nhận trước đó.** Đo trên toàn bộ 249 file thật:

| Kết quả | Số file |
|---|---|
| Tổng `last_token_usage` (sau khi bỏ phát lại) **khớp chính xác** tổng cộng dồn của chính Codex | **243 / 244** |
| Lệch | 1 |
| Event phát lại bị loại | 1.467 |
| File có `total` giảm (reset) | 0 |

File lệch duy nhất: event đầu tiên báo `total = 0` trong khi `last = 16028` — token có thật nhưng Codex không gộp vào bộ đếm; ta **đếm** chúng. `total` giảm được coi là mốc mới (reset), không phải bản sao — chưa file nào rơi vào, nhưng luật đã có.

Model **không** nằm trong `token_count` → lấy từ `turn_context.model` gần nhất (57.689/57.689 event thật đều có `turn_context` đứng trước). `info: null` (48 event, chỉ refresh rate-limit) → bỏ.

### Giá model — KHÔNG BỊA

`usage-pricing.js` chỉ có giá họ Claude. Toàn bộ model Codex + Gemini quan sát được **chưa có giá công bố trong bảng**:

| Harness | Model thật thấy trên máy | Trạng thái |
|---|---|---|
| Codex | `gpt-5.5`, `gpt-5.1-codex-max`, `gpt-5.3-codex`, `gpt-5.4-mini`, `gpt-5.2-codex` | `unknown` → USD 0 |
| Gemini | `gemini-3-flash-preview`, `gemini-2.5-flash`, `gemini-2.5-pro` | `unknown` → USD 0 |

Chúng vào thẳng `unknownModels` (pattern có sẵn): **token vẫn đếm đủ, USD = 0, tên model lộ ra để người thật điền giá**. Không dòng code nào đoán giá.

> **Hệ quả nghiệp vụ cần biết:** `totalUsd` hiện vẫn CHỈ phản ánh Claude Code. Muốn P&L agency đúng bằng tiền, phải thêm giá Codex/Gemini vào `PRICING_TABLE`. Token thì đã đúng cho cả 3.

## 1. Đã làm

- **`packages/daemon/src/usage-parsers.js` (mới)** — 3 parser, mỗi harness một chiến lược dedupe:
  - `parseClaudeFile` — dedupe theo `message.id` (giữ nguyên hành vi cũ).
  - `parseCodexFile` — dedupe theo luật "total phải tiến" ở trên.
  - `parseGeminiFile` — file bị **ghi đè toàn bộ** mỗi message, nên chống double-count bằng **cấu trúc**: mtime đổi → **thay thế** nguyên mảng bucket của file đó, không cộng dồn. Set `message.id` chặn nốt trường hợp rewind replay trong một lần parse.
  - Cả 3 quy về đúng 4 bộ đếm `input / output / cacheWrite / cacheRead`, luôn thoả `tokens == tổng 4 bộ đếm`. `input` = phần **không cached**; phần cached nằm riêng ở `cacheRead`, **không đếm hai lần**.
- **`usage-costs.js`** — quét 3 gốc (`~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/tmp`), thêm `byHarness` vào payload; `byAgent` thêm field `harness`.
- **Kỷ luật OOM giữ nguyên**: JSONL stream từng dòng; cache theo `(mtime, size)`; rescan ≤ 1 lần/15s; file mtime > 30 ngày không parse. Gemini là ngoại lệ *phải* đọc cả file (nó là 1 JSON document) — file thật vài KB.
- **Renderer** (`ui/costs.ts`): thêm bảng **"Theo harness"** trên cùng panel. `byHarness` để optional → daemon cũ (launchd chưa kickstart) vẫn render được, không crash.

## 2. Verify

- **Test**: daemon **131/131** (8 test mới trong `test/usage-parsers.test.js`), renderer **190/190** (3 test mới), `tsc --noEmit` sạch.
- **Fixture là data THẬT**: `test/fixtures/codex-rollout.jsonl` là 8 dòng bê nguyên từ rollout thật (chỉ đổi `cwd` thành path giả để `deriveRepo` chạy được), cố ý giữ **đúng cặp phát lại thật** và **một event `info: null` thật**. Gemini dùng lại fixture session thật của tailer.
- **Test chống double-count có thật ý nghĩa**: chạy lại fixture Codex sau khi **xoá** dòng phát lại → tổng **không đổi** (270.237). Gemini: ghi đè file bằng 2 message cũ + 1 message mới → tổng ra 18.868 chứ không phải 17.868×2 + 1.000.
- **Chạy sống**: `DAEMON_WS_PORT=8788 node src/index.js`, `GET /costs?window=24h` thấy **đủ 3 harness**, 0 lỗi, SIGTERM sạch.
- **Spot-check tay 1 session Gemini thật** (sinh mới bằng `gemini -p` trên 0.29.5, `session-2026-07-10T05-52-39543942.json`):

  | | tay | daemon |
  |---|---|---|
  | tokens | 10.599 | 10.599 |
  | input | 10.579 | 10.579 |
  | output (`output`+`thoughts`) | 20 | 20 |
  | cacheRead | 0 | 0 |

- **Cross-check Codex bằng script độc lập** (không dùng lại `usage-parsers.js`): `{tokens: 9.905.915, input: 825.151, output: 47.676, cacheRead: 9.033.088}` — **khớp từng số** với `byHarness.codex` của daemon.

## 3. Giới hạn biết trước (ponytail)

- **`byAgent` cắt top 20 theo USD** ⇒ vì Codex/Gemini đang USD = 0, session của chúng **không bao giờ lọt** vào "Theo agent" khi đã có ≥ 20 session Claude có giá. `byHarness` và `totalUsd`/`tokensTotal` vẫn đủ. Sửa được sau bằng top-N *theo từng harness*, nhưng đó là quyết định sản phẩm → chưa tự ý làm.
- **`totalUsd` = chỉ Claude Code** cho tới khi có giá Codex/Gemini (xem mục 0).
- Hệ số cache trong `usage-pricing.js` là luật Anthropic (`1.25×` / `0.1×` input) — trùng luôn mức cached-input `0.1×` của OpenAI. **Cache ngầm của Gemini ~`0.25×`** → dòng giá Gemini đầu tiên phải mang hệ số riêng (thêm phần tử thứ 4 vào tuple). Đã ghi comment `ponytail:` tại chỗ, chưa xây vì chưa có dòng nào.
- Gemini re-parse cả file JSON mỗi lần mtime đổi. Vài KB nên rẻ. File hàng chục MB → chuyển sang parse tăng dần theo `lastUpdated`.
- Bucket theo giờ → cửa sổ 24h lệch tối đa 1 giờ ở mép (kế thừa từ wi-cost-dashboard).

## 4. Thêm giá cho model mới

Sửa `PRICING_TABLE` trong `packages/daemon/src/usage-pricing.js`: 1 dòng `[prefix, inputUsd/MTok, outputUsd/MTok]`. Đang chờ giá: `gpt-5.5`, `gpt-5.1-codex-max`, `gpt-5.3-codex`, `gpt-5.4-mini`, `gpt-5.2-codex`, `gemini-3-flash-preview`, `gemini-2.5-flash`, `gemini-2.5-pro`, `glm-5.2`, `glm-4.7`, `claude-fable-5`.
