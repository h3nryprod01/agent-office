# Codex Adapter — Status (Integration Engineer)

_Cập nhật: 2026-07-07 (vòng 2). Branch `feat/codex-adapter` (worktree `.claude/worktrees/codex-adapter`)._

## Vòng 1: DONE — PR #4 đã merge vào main

Adapter Codex CLI (nguồn thứ 2, `harness: "codex"`) — chi tiết format + mapping: `docs/codex-adapter.md`. Verify 100% bằng data thật (245 rollout files trên máy).

## Vòng 2: giải 3 câu hỏi mở của PR #4 — DONE, chờ review

Vì `decisions.md` chưa ghi quyết định PM cho 3 câu hỏi, Integration Engineer đề xuất và tự thực hiện 2/3 trong lane của mình (chỉ đụng file codex-* + 1 điểm đăng ký):

1. **Backfill cutoff (câu hỏi #2) — ĐÃ LÀM**: rollout file idle > 5 phút (mặc định = session inactivity timeout, override `CODEX_BACKFILL_MAX_AGE_MS`) khi thấy lần đầu → tail từ EOF. Nguyên lý: session idle quá timeout sẽ `session_end` ngay sau backfill — parse 96MB để sinh 218 nhân vật chết là vô nghĩa. An toàn nhờ Codex re-append `session_meta` mỗi lần resume (data thật ~9/file); edge case cover bằng synthetic `session_start` (`meta.inferred`). Đo thật: boot daemon từ 0 event backfill thừa (trước: ~20k burst).
   - _Nguồn Claude Code có cùng vấn đề burst khi boot — KHÔNG tự sửa (ngoài lane), PM cân nhắc áp cùng pattern._
2. **agentNickname làm tên nhân vật (câu hỏi #3) — ĐÃ LÀM**: `agent` = nickname (Boyle, Sartre, Arendt…) cho Codex sub-agent thay vì tên folder cwd (trùng nhau giữa sibling). Verify replay data thật.
3. **Trạng thái "chờ phê duyệt" cho Codex (câu hỏi #1) — KHÔNG LÀM, có chủ đích**: máy chạy `approval_policy: never` → 0 record thật để verify. Làm theo docs suy luận vi phạm nguyên tắc "data thật là linh hồn". Backlog: khi nào có session Codex bật approval, lấy record thật rồi map (tương đương hook_signal phía Claude Code).

Tests: daemon 19/19 pass (thêm codex-tailer.test.js + 2 case normalize mới). Replay data thật: 24.323 events, 0 vi phạm.
