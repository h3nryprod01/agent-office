# Task Ancestry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho mỗi agent trong office 3D trả lời được "tại sao tôi làm việc này" — chuỗi work-item cha lên tới gốc — bằng cách đọc `parentItemId` và render trong panel work-item đã có.

**Architecture:** Renderer-only. `/work-items` của daemon là passthrough (`ws-server.js#readWorkItems` trả `work-items.json` nguyên văn) → thêm `parentItemId` vào file là chảy thẳng ra renderer, KHÔNG đụng daemon. Link agent→work-item đã có (`matchWorkItem`). Panel đã wired (`workItemSectionHtml` được side panel gọi). Việc còn lại: thêm field vào type, selector thuần `ancestryOf`, và một khối HTML "Vì sao" nhét vào hàm render sẵn có.

**Tech Stack:** TypeScript, Vitest. Tất cả thay đổi trong `packages/renderer/src/ui/workItems.ts` + test `packages/renderer/test/workItems.test.ts`.

## Global Constraints

- KHÔNG đụng daemon (`/work-items` passthrough — verified `ws-server.js:180`). `parentItemId` set trong `work-items.json` ngoài băng (company-pm hoặc sửa tay); renderer chỉ ĐỌC + hiển thị.
- `ancestryOf` phải THUẦN (không DOM, không I/O) — test được headless.
- Chống **cycle** (A→B→A không treo) và **orphan** (`parentItemId` trỏ item đã xóa → dừng an toàn).
- Escape mọi text người-nhập bằng `esc()` đã có trong file (chống XSS trong panel HTML).
- Tái dùng, KHÔNG phát minh: `matchWorkItem`, `workItemSectionHtml`, `esc` đã có trong `workItems.ts`.
- Chạy test: `npm --prefix packages/renderer test`. Type-check: `cd packages/renderer && npx tsc --noEmit` (KHÔNG dùng `npx --prefix` — nó không cd).
- Nhãn tiếng Việt cho người dùng không rành kỹ thuật ("Vì sao", "vì"). Không emoji trong code.

## Ngoài phạm vi (ghi rõ để không scope-creep)

- **Populate `parentItemId`** (PM gắn cha): là việc của data/`company-pm` skill (user-level, repo khác) hoặc sửa tay `work-items.json`. Plan này chỉ đọc + hiển thị. Task 3 chỉ thêm 1 entry mẫu để test end-to-end.
- **Nối tới text `goals.md`**: gốc chuỗi hiện là work-item không-cha (root). Link tới đúng câu goal trong `goals.md` cần daemon expose `/goal` → follow-up riêng, KHÔNG làm ở đây.
- Auto-infer cha; nhiều-cha; sửa cha từ UI.

---

## Task 1: `parentItemId` field + `ancestryOf` selector (thuần)

**Files:**
- Modify: `packages/renderer/src/ui/workItems.ts` (thêm field vào `interface WorkItem` ~dòng 6-16; thêm hàm `ancestryOf` sau `matchWorkItem` ~dòng 64)
- Test: `packages/renderer/test/workItems.test.ts` (tạo nếu chưa có, hoặc thêm `describe`)

**Interfaces:**
- Consumes: `WorkItem` (đã có trong `workItems.ts`).
- Produces: `ancestryOf(start: WorkItem, items: readonly WorkItem[]): WorkItem[]` — chuỗi `[start, cha, …, root]`, dừng ở orphan, không treo ở cycle.

- [ ] **Step 1: Viết test fail cho `ancestryOf`**

Thêm vào `packages/renderer/test/workItems.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ancestryOf, type WorkItem } from "../src/ui/workItems";

const wi = (id: string, parentItemId?: string): WorkItem => ({ id, title: `việc ${id}`, parentItemId });

describe("ancestryOf", () => {
  it("đi từ item lên tới root theo parentItemId", () => {
    const items = [wi("a", "b"), wi("b", "c"), wi("c")];
    expect(ancestryOf(items[0], items).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("item không cha → chuỗi 1 phần tử", () => {
    const items = [wi("a")];
    expect(ancestryOf(items[0], items).map((i) => i.id)).toEqual(["a"]);
  });

  it("orphan: parentItemId trỏ item đã xóa → dừng, không ném", () => {
    const items = [wi("a", "ghost")];
    expect(ancestryOf(items[0], items).map((i) => i.id)).toEqual(["a"]);
  });

  it("cycle A→B→A → không treo, trả đúng phần đã đi", () => {
    const items = [wi("a", "b"), wi("b", "a")];
    expect(ancestryOf(items[0], items).map((i) => i.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `npm --prefix packages/renderer test -- workItems`
Expected: FAIL — `ancestryOf` chưa export (`ancestryOf is not a function`).

- [ ] **Step 3: Thêm field + implement `ancestryOf`**

Trong `packages/renderer/src/ui/workItems.ts`, thêm field vào `interface WorkItem` (sau `status?: string | null;`):

```ts
  /** Work-item cha (task ancestry). null/undefined = gốc chuỗi. */
  parentItemId?: string | null;
```

Thêm hàm sau `matchWorkItem` (sau ~dòng 64):

```ts
/**
 * Chuỗi work-item từ `start` lên tới root, theo parentItemId. Thứ tự
 * [start, cha, …, root]. Dừng khi cha không tồn tại (orphan) và khi gặp
 * cycle (trả phần đã đi, KHÔNG lặp vô hạn).
 */
export function ancestryOf(start: WorkItem, items: readonly WorkItem[]): WorkItem[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  const chain: WorkItem[] = [];
  const seen = new Set<string>();
  let cur: WorkItem | undefined = start;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentItemId ? byId.get(cur.parentItemId) : undefined;
  }
  return chain;
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `npm --prefix packages/renderer test -- workItems`
Expected: PASS (4/4 case `ancestryOf`).

- [ ] **Step 5: Type-check**

Run: `cd packages/renderer && npx tsc --noEmit`
Expected: 0 lỗi.

- [ ] **Step 6: Commit**

```bash
git add packages/renderer/src/ui/workItems.ts packages/renderer/test/workItems.test.ts
git commit -m "feat: ancestryOf selector + parentItemId on WorkItem (task ancestry core)"
```

---

## Task 2: Render khối "Vì sao" trong panel work-item

**Files:**
- Modify: `packages/renderer/src/ui/workItems.ts` (thêm `whyChainHtml`; gọi nó trong `workItemSectionHtml` ~dòng 103-108)
- Test: `packages/renderer/test/workItems.test.ts`

**Interfaces:**
- Consumes: `ancestryOf` (Task 1), `esc` (đã có trong file).
- Produces: `whyChainHtml(item: WorkItem, items: readonly WorkItem[]): string` — HTML chuỗi "Vì sao"; chuỗi rỗng khi item không có cha.

- [ ] **Step 1: Viết test fail cho `whyChainHtml`**

Thêm vào `packages/renderer/test/workItems.test.ts`:

```ts
import { whyChainHtml } from "../src/ui/workItems";

describe("whyChainHtml", () => {
  it("chuỗi nhiều tầng → chứa mọi tiêu đề + nhãn Vì sao", () => {
    const items = [wi("a", "b"), wi("b", "c"), wi("c")];
    const html = whyChainHtml(items[0], items);
    expect(html).toContain("Vì sao");
    expect(html).toContain("việc a");
    expect(html).toContain("việc b");
    expect(html).toContain("việc c");
  });

  it("item không cha → chuỗi rỗng (không có gì để giải thích)", () => {
    const items = [wi("a")];
    expect(whyChainHtml(items[0], items)).toBe("");
  });

  it("escape tiêu đề (chống XSS)", () => {
    const items = [wi("a", "b"), { id: "b", title: "<img src=x>" }];
    const html = whyChainHtml(items[0], items);
    expect(html).not.toContain("<img src=x>");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `npm --prefix packages/renderer test -- workItems`
Expected: FAIL — `whyChainHtml` chưa export.

- [ ] **Step 3: Implement `whyChainHtml` + gọi trong `workItemSectionHtml`**

Trong `packages/renderer/src/ui/workItems.ts`, thêm hàm (gần `workItemLinksHtml`):

```ts
/**
 * Khối "Vì sao": chuỗi work-item cha, đọc như "làm A vì B vì C". Rỗng khi
 * item không có cha (không có gì để giải thích). Escape mọi tiêu đề.
 */
export function whyChainHtml(item: WorkItem, items: readonly WorkItem[]): string {
  const chain = ancestryOf(item, items);
  if (chain.length <= 1) return "";
  const rows = chain
    .map(
      (it, i) =>
        `<div class="why-row">${i === 0 ? "" : '<span class="why-arrow">vì →</span> '}${esc(it.title)}</div>`,
    )
    .join("");
  return `<div class="why-chain"><div class="why-label">Vì sao</div>${rows}</div>`;
}
```

Trong `workItemSectionHtml`, thêm `whyChainHtml` ngay sau `workItemLinksHtml(item)` (trong template, trước `</div>` đóng `.work-item`):

```ts
      ${workItemLinksHtml(item)}
      ${whyChainHtml(item, items)}
    </div>`;
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `npm --prefix packages/renderer test -- workItems`
Expected: PASS (cả `ancestryOf` lẫn `whyChainHtml`).

- [ ] **Step 5: Type-check + full suite (không vỡ gì)**

Run: `cd packages/renderer && npx tsc --noEmit && cd - && npm --prefix packages/renderer test`
Expected: tsc 0 lỗi; toàn bộ suite xanh (300+ test, không giảm).

- [ ] **Step 6: Commit**

```bash
git add packages/renderer/src/ui/workItems.ts packages/renderer/test/workItems.test.ts
git commit -m "feat: 'Vì sao' ancestry chain in work-item side panel"
```

---

## Task 3: Entry mẫu + xác minh end-to-end (data, không code)

**Files:**
- Modify: `.claude/memory/work-items.json` (thêm `parentItemId` cho 1-2 entry để nhìn thấy chuỗi thật)

**Interfaces:** không có (chỉ data).

- [ ] **Step 1: Thêm `parentItemId` vào 1 work-item con thật**

Chọn 2 item có quan hệ cha-con trong `.claude/memory/work-items.json`, thêm `"parentItemId": "<id-cha>"` vào item con. (Đây là thao tác "PM gắn cha thủ công" của MVP.)

- [ ] **Step 2: Xác minh trên office thật**

Run: khởi động renderer live (`npm --prefix packages/renderer run build` rồi daemon serve, hoặc `?ws=1`), mở side panel của agent khớp item con.
Expected: thấy khối **"Vì sao"** liệt kê item con → cha. Item không cha KHÔNG hiện khối này.

- [ ] **Step 3: Commit (nếu entry mẫu đáng giữ)**

```bash
git add .claude/memory/work-items.json
git commit -m "chore: sample parentItemId to exercise the why-chain"
```

*(Nếu không muốn commit data mẫu vào repo, revert bước này — code Task 1+2 mới là deliverable.)*

---

## Self-Review

**1. Spec coverage** (đối chiếu "Feature A" trong design doc):
- work-item + `parentItemId` → Task 1 ✓
- selector thuần `ancestryOf` → Task 1 ✓ (đặt ở `ui/workItems.ts` — grounding sửa "sim/" của spec: work-item sống ở đây)
- panel "Vì sao" tái dùng de-jargon → Task 2 ✓ (tái dùng `esc`/`workItemSectionHtml`; panel đã wired sẵn nên KHÔNG cần đụng `main.ts`/`sidePanel.ts` — nhỏ hơn spec tưởng)
- MVP PM gắn cha thủ công → Task 3 (data) + ghi rõ populate là việc ngoài phạm vi renderer ✓
- chống cycle + orphan → Task 1 Step 1 test ✓
- link agent→việc → đã có `matchWorkItem`, không cần task ✓

**2. Placeholder scan:** không có TBD/TODO; mọi step có code/lệnh thật.

**3. Type consistency:** `ancestryOf(start, items)` và `whyChainHtml(item, items)` dùng nhất quán `WorkItem`/`readonly WorkItem[]` qua cả 2 task; `esc` là hàm sẵn có trong file.

**Điều chỉnh so với spec (grounded, đã ghi):** A là renderer-only (daemon passthrough), `ancestryOf` ở `ui/workItems.ts` chứ không `sim/`, và không cần đụng `main.ts` vì `workItemSectionHtml` đã được side panel gọi. Nối tới `goals.md` là follow-up (cần daemon `/goal`), không nằm trong MVP.
