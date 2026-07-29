# @agent-office/renderer

PixiJS v8 renderer: văn phòng isometric vẽ bằng **pixel-art thật**
(`assets/spritesheets/office-tileset.*` + `characters.*`), chạy bằng **mock
event stream** theo schema draft ở [`packages/protocol`](../protocol/) mặc
định, hoặc live qua `?ws=1`.

`public/assets` là symlink tới `../../assets` (repo root) để Vite serve atlas
PNG/JSON ở cùng path `assets/…` cả lúc `npm run dev` lẫn sau `npm run build`.

## Chạy

```bash
cd packages/renderer
npm install
npm run dev      # http://localhost:5199
npm test         # vitest — state machine tests
```

- Mặc định: mock scenario ~46s (PM spawn 4 sub-agents, đọc file, chạy test,
  1 agent chờ duyệt quyền, 1 agent lỗi rồi hồi phục, xong việc). Có nút
  Play/Pause/Speed/Restart ở góc dưới trái + FPS counter.
- `?stress=30` — thêm 30 nhân vật nền để kiểm tra 60fps.
- `?ws=1` — **live mode**: nối `ws://127.0.0.1:8787` (chạy `npm start` trong
  `packages/daemon` trước). Stream v1 của daemon được dịch sang protocol draft
  qua `src/events/daemonV1Adapter.ts` (code tạm — xoá khi daemon emit draft
  native). Chỉ hiện hoạt động trong 10 phút gần nhất (daemon replay toàn bộ
  lịch sử khi boot; xem chú thích trong adapter). Từ Round 3 adapter dùng
  `agentId`/`parentId` thật của daemon (sub-agent là nhân vật riêng) và map
  event additive `hook_signal` → `waiting_permission` real-time.

## Mission Control (Round 3)

Trả lời "**tôi cần can thiệp ở đâu?**" nhanh hơn terminal:

- **Click nhân vật** → side panel bên phải (`src/ui/sidePanel.ts`): tên/role,
  trạng thái + đã bao lâu, chi tiết, tool đang chạy, cwd, session/agent id,
  timeline ~30 hoạt động gần nhất (từ event stream, giữ trong
  `AgentModel.timeline`). Phần transcript N message cuối đang chờ endpoint
  HTTP phía daemon (placeholder trong panel).
- **Hàng đợi "Cần can thiệp"** góc trên trái (`src/ui/interventionQueue.ts`):
  agent ở `waiting_permission`/`error`/`blocked`, xếp theo mức khẩn rồi theo
  thời gian kẹt (selector thuần `src/sim/selectors.ts`, có test). Click item
  → camera pan mượt tới nhân vật + mở side panel.
- Nhân vật ở trạng thái alert có **❗ đỏ nhún nhảy** trên đầu, to hơn badge.
- Panel là DOM thuần ngoài canvas, refresh 4Hz; DOM chỉ bị thay khi nội dung
  đổi (bộ đếm "since" update tại chỗ) để click không rơi vào node vừa detach.

## Kiến trúc

```
EventSource (interface duy nhất — mock & WebSocket cùng implement)
      │ OfficeEvent (packages/protocol)
      ▼
 sim/reducer.ts   — PURE state machine: event → OfficeState (immutable)
      │            đây là CHỖ DUY NHẤT sửa khi protocol đổi
      ▼
 render/assets.ts   — load bundle "office" (assets/manifest.json) 1 lần lúc boot
 render/AgentLayer  — sprite lifecycle, đi lại giữa trạm, dây nối sub-agent→cha
 render/AgentSprite — AnimatedSprite pixel-art (2 colorway) + tên + badge + bubble
 render/OfficeView  — sàn nhà + bàn + kệ sách + arcade + bàn họp = Sprite từ office-tileset
```

Nguyên tắc tách lớp: **sim không biết Pixi, render không tự suy trạng thái.**
Mọi logic "event nghĩa là gì" nằm trong `sim/`, test được bằng vitest không cần
browser. `render/` chỉ đọc `OfficeState` mỗi frame.

## Mapping trạng thái → hình ảnh (theo docs/semantic-mapping.md)

| Trạng thái / tool | Nhân vật làm gì |
|---|---|
| `Read`/`Grep`/`Glob` | đi tới **kệ sách**, badge "Reading" (xanh dương) |
| `Bash` | đi tới **máy arcade**, badge "Running" (vàng) |
| `Write`/`Edit`/khác | về **bàn riêng**, badge "Focusing" (xanh lá) |
| `Task`/`Agent` | đi tới **bàn họp**; sub-agent pop-in tại đó rồi về bàn |
| `waiting_permission`/`blocked` | đứng yên tại chỗ, badge đỏ **❗ nhấp nháy** |
| `error` | đứng yên, badge cam ⚠️ (hồi phục qua `agent_status_changed`) |
| `agent_message` | speech bubble 4s |
| root spawn / sub-agent spawn | đi từ cửa vào / pop-in ở bàn họp (phân biệt trực quan) |
| sub-agent đang sống | dây mảnh nối về nhân vật cha ("ai chờ ai") |

## Art đã wire vào (không còn placeholder)

- `render/assets.ts` — `loadOfficeArt()` gọi `Assets.init` + `loadBundle("office")`
  1 lần trong `main.ts` trước khi dựng scene, `TextureStyle.defaultOptions.scaleMode
  = "nearest"` để pixel art nét.
- `render/OfficeView.ts` — mỗi trạm/desk/floor tile là `Sprite` lấy từ
  `office-tileset` (frame name theo `assets/spritesheets/office-tileset.json`);
  grid footprint trong `render/layout.ts` không đổi.
- `render/AgentSprite.ts` — `body` là `AnimatedSprite` lấy animation key
  `{colorway}/{state}_{dir}` từ `characters` atlas (docs/art-direction.md §4).
  Colorway (`coder-teal` / `coder-coral`) chọn **deterministic theo hash của
  `agentId`** — cùng 1 agent luôn cùng 1 màu áo giữa các lần re-render, và 2
  agent khác nhau thường (không đảm bảo) khác màu. `AgentLayer` tính hướng đi
  (N/E/S/W) từ delta vị trí mỗi frame và gọi `sprite.setWalking(dir)` — chỉ
  `walk` có đủ 4 hướng trong atlas, các state khác (idle/typing/reading/...)
  vẽ cố định 1 hướng theo bảng trong art-direction.md.
- Badge trạng thái / tên / speech bubble vẫn là PixiJS `Text` (không phải art
  asset) — giữ nguyên logic cũ.

**Fallback khi asset load lỗi**: `loadOfficeArt()` không bao giờ throw — bắt
lỗi, log `console.warn`, trả `null`. `OfficeView`/`AgentSprite` nhận
`Spritesheet | null`; nếu `null`, mỗi chỗ vẽ art thật rơi về lại `Graphics`
placeholder cũ (capsule màu / extrudedBox) thay vì crash toàn bộ renderer.
Đã test bằng cách tạm trỏ sai đường dẫn manifest — scene vẫn chạy, chỉ log
warning trong console.

## Perf

Đã đo bằng `?stress=30` (35 nhân vật đồng thời, sau Mission Control):
~2.1ms/frame khi bơm 120 frame liên tục — dư lớn cho 60fps (16.7ms budget).
Mỗi nhân vật là 1 Container + AnimatedSprite + Graphics + Text; panel DOM
nằm ngoài render loop.
