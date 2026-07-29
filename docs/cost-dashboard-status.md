# Cost dashboard — status (wi-cost-dashboard, R7)

"Bảng lương" của công ty agent: đội agent này tiêu bao nhiêu tiền, ở repo nào, agent nào, ngày nào.

> **Đã mở rộng bởi wi-cost-multiharness**: `/costs` giờ gộp cả Codex + Gemini và trả thêm `byHarness`. Tài liệu dưới đây mô tả nguồn Claude Code; xem [cost-multiharness-status.md](./cost-multiharness-status.md) cho 2 nguồn còn lại và các bẫy dedupe của chúng.

## Đã làm

- **Daemon** (`packages/daemon/src/usage-pricing.js` + `usage-costs.js`):
  - Parse `message.usage` từ transcript JSONL (`~/.claude/projects/**/*.jsonl`, gồm cả file sub-agent dưới `<sid>/subagents/`).
  - **Dedupe theo `message.id`**: transcript ghi 1 dòng cho mỗi content block của cùng một API response (quan sát thật: tới 9 bản sao cùng usage) — mỗi response chỉ tính MỘT lần.
  - Bảng giá theo model (USD/MTok), match theo family prefix + date suffix; **cache_read = 0.1× input, cache_write = 1.25× input** (bài học claude-usage-kit: không bao giờ tính cache_read theo giá input đầy đủ).
  - Model không có trong bảng → **unknown**: tokens vẫn đếm, USD = 0, tên model trả về trong `unknownModels` để người thật thêm giá — không đoán. Hiện tại unknown lớn nhất là `claude-fable-5` (model mới, chưa công bố giá lúc viết).
  - `GET /costs?window=24h|7d|30d` → `{window, totalUsd, tokensTotal, tokens{input,output,cacheWrite,cacheRead}, byRepo, byAgent(top 20), byDay, unknownModels}`. Window sai → 400.
  - **Lười + tiết kiệm RAM** (hậu OOM #17): stream từng dòng, không giữ nội dung transcript; cache aggregate theo (mtime, size) từng file; rescan thư mục tối đa 15s/lần; file mtime > 30 ngày bỏ qua hẳn. Đo thật: lần parse đầu toàn máy ~12s, RSS 136MB; request sau ~10ms.
- **Renderer** (`packages/renderer/src/ui/costs.ts`): nút "Chi phí · $X" góc trên phải → panel bảng per-repo / per-agent / per-ngày với bar div thuần (không chart library), chọn window 24h/7d/30d, cảnh báo model chưa có giá. Tên agent lấy từ `assignee` trong work registry khi khớp sessionId, không thì session id rút gọn.
- Đăng ký: 1 handler trong chuỗi `extraHttp` của `index.js`; `#costs` div trong `index.html`; CSS cuối `style.css`.

## Verify

- Test: daemon 77/77 (6 test mới: pricing match/unknown, dedupe, skip message không usage, torn JSON, windows, mtime cache, subagent file, HTTP handler), renderer 106/106 (11 test mới) + `tsc --noEmit` sạch.
- Chạy thật: daemon test port 8788 trên transcript thật của máy; spot-check tay session `50731c6b` (demo-app-docs) bằng script Python độc lập: **khớp từng số** (usd=101.9013, tokens=88,842,918).
- UI thật: mở panel trong Vite preview nối daemon 8788 — 3 bảng render đúng, bar tỉ lệ, đổi window 24h→7d cập nhật số + byDay đủ 8 ngày.

## Thêm giá cho model mới

Sửa `PRICING_TABLE` trong `packages/daemon/src/usage-pricing.js` — 1 dòng `[prefix, inputUsd/MTok, outputUsd/MTok]`; cache write/read tự suy ra (1.25× / 0.1×). Model đang chờ giá: `claude-fable-5`, `claude-sonnet-4-6`.

## Giới hạn biết trước (ponytail)

- `byAgent` cắt top 20 theo USD (payload gọn); tổng vẫn tính đủ mọi agent.
- Bucket theo giờ → cửa sổ 24h lệch tối đa 1 giờ ở mép.
- Chỉ nguồn Claude Code; rollout Codex chưa có usage tương đương (thêm sau nếu cần).
- Daemon launchd đang chạy code cũ — endpoint `/costs` chỉ sống sau khi merge + restart service (`launchctl kickstart -k gui/$UID/com.agentoffice.daemon`).
