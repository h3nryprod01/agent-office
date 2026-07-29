# wi-deeplinks — Daemon /work-items + side panel deep links

_Cập nhật: 2026-07-07 · branch `feat/work-item-links` · assignee deeplink-engineer_

## Đã làm

1. **Daemon `GET /work-items`** (`packages/daemon/src/ws-server.js`): đọc registry
   từ disk mỗi request (không cache), path qua option `workItemsPath` / env
   `WORK_ITEMS_PATH`, default `<cwd>/.claude/memory/work-items.json`. File
   thiếu / JSON hỏng / sai shape → `{version:1, items:[]}` + `console.warn`,
   không bao giờ 500. Logic tail/buffer không đụng.
2. **Side panel mục "Work item"** (`packages/renderer/src/ui/workItems.ts` +
   `sidePanel.ts`): match theo `sessionId` (exact) → `assignee` vs name/role
   (2 chiều, case-insensitive) → segment cuối của `branch` nằm trong `cwd`.
   Link row: **Plane** (null → nút mờ + tooltip "Plane offline"), **Obsidian**
   (`obsidian://open?vault=2nBrain&file=<note>`, null → ẩn), **PR** (null → ẩn).
   Registry refetch mỗi lần mở panel (reset trong `show()`), không polling.
3. **Kanban mini** (`packages/renderer/src/ui/board.ts`): khung "Board · N làm
   · N kẹt · N xong" góc trái, click mở list item + link row (tái dùng
   `workItemLinksHtml`). Fetch lúc mount + mỗi lần mở, không polling. Mock mode
   → ẩn.

## Deviation so với spec

- Spec ghi `obsidian://open?vault=AI-Memory&...` — **sai vault name**. Đã verify
  trên máy: vault Obsidian (folder chứa `.obsidian`) là **`2nBrain`**; basic-memory
  project "ai-memory" trỏ vào TRONG vault đó, notes nằm ở folder `AI-Memory/`.
  → dùng `vault=2nBrain`, và `obsidianNote` trong registry nên là **path tương
  đối so với vault root** (vd `AI-Memory/Projects/x.md`).

## Verify

- Daemon: 27/27 test (`npm test`, gồm 3 test mới: file ok / thiếu / hỏng+sai shape).
- Renderer: 56/56 test (`vitest`, gồm 7 test mới cho match + link render + escape),
  `tsc --noEmit` sạch.
- Chạy thật: daemon từ worktree với `WORK_ITEMS_PATH` trỏ registry thật →
  `curl /work-items` trả 5 items; mở `?ws=1` bằng Chrome DevTools MCP: board hiện
  "5 làm · 0 kẹt · 0 xong", overlay list 5 items với nút Plane mờ (Plane đang tắt),
  side panel hiện mục "Work item" (trạng thái no-match cho session không có trong
  registry). Không console error từ code mới (1 lỗi 404 là favicon).

## Ghi chú cho coordinator

- Registry entry match tốt nhất khi coordinator điền `sessionId` lúc giao việc —
  heuristic assignee/branch chỉ là fallback (name agent hiện = tên repo nên
  assignee ít khi match).
- Perf: toàn bộ là DOM ngoài canvas, fetch on-demand — không đụng render loop 60fps.
