# wi-daemon-leak — status (2026-07-08)

**Trạng thái: DONE — PR #17 MERGED (`d562a67`), service đã restart & xác nhận ổn định.** Stability Engineer, session `3e3c43e0-6881-4a3d-ab2a-ae7504a3751d`.

## Root cause (1 câu)

`TranscriptTailer` không có backfill cutoff ở tầng đọc (mỗi boot đọc lại toàn bộ 2.5GB/4092 file transcript từ byte 0, vì offsets chỉ nằm in-memory) **và** `_tick()` async chạy trên `setInterval` 1s không có reentrancy guard — tick backfill chạy nhiều phút nên mỗi giây chồng thêm một tick mới cùng đọc lại những file chưa có offset, memory pileup không giới hạn → V8 heap OOM (SIGABRT) → launchd restart → offsets mất → lặp lại vô hạn.

## Bằng chứng (đo trên corpus thật của máy này)

- Corpus: `~/.claude/projects` = **2.5GB / 4092 file .jsonl**, file lớn nhất 75MB.
- Probe cô lập (chỉ `TranscriptTailer`, không normalizer/WS): heap cap 256MB → **OOM SIGABRT sau 3.3 giây**. Cùng chữ ký crash với production.
- Probe heap 2GB, đếm tick song song: `ticksInFlight` tăng ~1/giây không giới hạn — **72 tick song song, 3.3 triệu dòng emit trùng lặp sau 83 giây**, RSS dao động lên 2.1GB. Khớp "RSS 2.6GB sau 2.5 phút" đo trên production.
- PR #5 từng thêm cutoff này cho **codex-tailer** nhưng chưa bao giờ áp cho Claude tailer — trả lời câu hỏi trong work order: cutoff cũ skip cả đọc lẫn emit, nhưng chỉ ở nguồn codex.

## Fix (7 file, +189/−25, có 3 test mới)

1. `tailer.js` — cutoff giống codex: file idle >5 phút khi gặp lần đầu → tail từ EOF, không replay history. Session sống lại vẫn có `session_start` sạch (normalize.js emit theo dòng user/assistant đầu tiên nhìn thấy, đã có test).
2. `tailer.js` / `codex-tailer.js` / `hook-log-tailer.js` — guard `_ticking`: tick không bao giờ chồng nhau (cùng bug class ở cả 3 poller).
3. `index.js` + `agent-registry.js` + `session-end-monitor.js` — prune khi `session_end`: `normalizers` Map, map `toolUse→agent` của root session, entry của end monitor. Trước đây cả 3 giữ vĩnh viễn (leak chậm ~MB/tuần, không phải nguyên nhân OOM nhưng nằm trong danh sách nghi phạm của work order).

## Số liệu trước / sau

| Chỉ số | Trước | Sau |
|---|---|---|
| Tailer trần @ heap 256MB, corpus thật | OOM sau 3.3s | boot sạch |
| Tick song song | 72+ (tăng vô hạn) | 1 |
| Daemon thật @ heap 256MB, port 8788 (soak nhánh) | — (prod 768MB vẫn crash ~2.5') | RSS **phẳng 85–93MB suốt 16 phút** (960s), không leak; dừng bởi SIGTERM ngoài khi coordinator dọn worktree lúc merge (clean shutdown, KHÔNG OOM — log ghi `[daemon] shutting down`, không có stack V8 heap). Log: `soak-rss.log` |
| Service production sau restart (coordinator, heap 768MB) | ~872MB rồi crash trước mốc 22s | **RSS ~160MB, ổn định vượt mốc 22s từng crash** |
| Test | 68/68 | **71/71** (3 mới: cutoff / replay file active / tick reentrancy) |

## Đánh đổi chấp nhận

- History của session idle >5' lúc boot không được replay (tradeoff giống PR #5 bên codex; renderer vốn cũng không cần history đó — ring buffer chỉ giữ 100 event/session).
- Session resume sau khi normalizer bị prune: `tool_result` của tool_use cũ hiện `unknown_tool` (hiếm, chỉ ảnh hưởng text bubble).

## Sau merge (coordinator — ĐÃ LÀM)

1. ✅ Merge PR #17 (squash `d562a67`), xóa branch + worktree `.claude/worktrees/daemon-leak`.
2. ✅ Restart service `com.agentoffice.daemon` với code mới — RSS ~160MB, ổn định vượt mốc 22s từng crash (trước ~872MB).
3. Đang theo dõi RSS ~30' để xác nhận ổn định dài hạn (<150MB kỳ vọng). Guardrail `--max-old-space-size=768` trong plist giữ nguyên — giờ là guardrail thật thay vì bom hẹn giờ.
4. `AGENT_OFFICE_VERBOSE` giữ tắt là đúng (bài học 9GB log) — chỉ bật khi cần debug.
