# Company Protocol v1 — hợp đồng giữa coordinator, agents, và Agent Office

Giao thức chung cho mô hình "công ty đa agent phục vụ 1 solo dev". Mọi skill (`/company:pm`, `company:report`, `/company:board`) và UI (Agent Office side panel) đều đọc/ghi theo hợp đồng này. Nguyên tắc gốc không đổi: **data thật + real-time; mọi thứ phải trả lời nhanh hơn terminal câu hỏi "tôi cần can thiệp ở đâu?"**

## 1. Work item — nguồn chân lý

- **Plane** (self-host, `localhost:8080`, workspace `mission-control`) là nguồn chân lý trạng thái task. Mỗi việc giao cho một agent = **1 Plane issue**: title = việc, description = bối cảnh + vùng file được đụng + tiêu chí xong, state chuẩn `Backlog → In Progress → Done / Blocked`.
- **Ngưỡng "vào công ty"**: việc ước < 30 phút, 1 session tự làm xong → KHÔNG tạo issue, không nghi thức. Chỉ việc giao đi (chip/session khác) hoặc nhiều bước mới tạo issue.
- **Fallback khi Plane tắt**: ghi vào registry file (mục 2) với `planeIssueId: null` + thêm dòng vào `.claude/memory/plane-outbox.jsonl` (mỗi dòng = 1 thao tác Plane chưa sync: create/update/comment). Session nào thấy Plane sống thì replay outbox rồi xóa dòng đã sync.

## 2. Work registry — cầu nối sang Agent Office

File `.claude/memory/work-items.json` trong repo của dự án, coordinator ghi khi giao việc, agent cập nhật khi có link mới:

```json
{
  "version": 1,
  "items": [
    {
      "id": "wi-<ngắn, duy nhất>",
      "title": "Dựng Mission Control MVP",
      "assignee": "mission-control",        // tên agent/chip
      "sessionId": "<claude session id nếu biết>",
      "branch": "feat/mission-control",
      "planeIssueId": "AGOF-12 | null",
      "planeUrl": "http://localhost:8080/... | null",
      "pr": "https://github.com/... | null",
      "obsidianNote": "ai-memory/... | null",
      "status": "in_progress | done | blocked",
      "updatedAt": "<ISO>"
    }
  ]
}
```

Daemon serve file này qua `GET /work-items` (đọc mỗi request, không cache); side panel render mục "Work item" với deep link: Plane URL, `obsidian://` , PR. Click nhân vật là mở được vùng dữ liệu của nó — đó là toàn bộ mục đích của registry.

## 3. Giao thức báo cáo (bắt buộc trong prompt mọi agent được spawn)

Agent xong việc (hoặc bị kẹt) phải làm theo thứ tự:

1. **Cập nhật work item**: Plane issue → Done/Blocked + comment đúng 5 mục (mỗi mục ≤ 2 dòng):
   - `Did:` làm gì
   - `Verified:` verify bằng cách nào (test số liệu, chạy thật, screenshot)
   - `Links:` PR / commit / file
   - `Blockers:` gì đang chặn (hoặc "none")
   - `Next:` đề xuất bước sau (hoặc "none")
   Plane tắt → ghi comment này vào outbox + cập nhật `work-items.json`.
2. **Nhắn coordinator**: `send_message` tới session điều phối (nếu còn sống) với đúng 5 mục trên. Coordinator chết → bỏ qua, registry + Plane đã đủ (PM stateless sẽ đọc lại).
3. **Tri thức tái dùng** (chỉ khi có): insight dùng lại được ngoài repo này → 1 note Obsidian qua basic-memory, link vào `obsidianNote` của work item. Không ghi trùng những gì đã nằm trong repo docs.

Coordinator **không tin lời báo cáo** — đối chiếu PR/commit/test thật trước khi đóng issue.

## 4. PM stateless (quyết định đã chốt 2026-07-07)

Không có "PM session sống lâu". Bất kỳ session nào chạy `/company:pm` sẽ:
1. Đọc state: Plane issues (hoặc registry khi Plane tắt) + `work-items.json` + `.claude/memory/activeContext.md` + `git log`/PR + sessions đang chạy.
2. Đối chiếu — issue Done mà chưa merge? PR mở chưa review? Agent im quá lâu?
3. Hành động: review/merge, giao việc mới (tạo issue + registry entry + spawn chip/sub-agent với prompt tiêm mục 3 + kỷ luật mục 5), cập nhật activeContext.
4. Kết thúc turn hoặc set loop — chết không mất gì vì toàn bộ não nằm trong Plane + registry + repo memory.

## 5. Kỷ luật thi công (bài học đã trả giá 3 lần)

- Mỗi agent làm trong **git worktree riêng** (`.claude/worktrees/<tên>`), không bao giờ checkout trong thư mục gốc chung; luôn `git branch --show-current` trước khi commit.
- Coordinator phân **vùng file** khi giao việc (ghi trong issue); ai cần sửa ngoài vùng → nói trong PR, không tự ý.
- Merge: squash qua PR; docs/demo merge cuối; xóa branch + worktree sau merge (worktree phải clean và session đã tắt).
- Quyết định mới → append `.claude/memory/decisions.md` (`| date | quyết định | lý do |`).
