# Demo / README — Status (DevRel chip)

_Cập nhật: 2026-07-07. Branch `docs/demo-readme`. Không đụng code `packages/`._

## ✅ Đã làm

1. **Chạy hệ thật end-to-end**: daemon (8787) + renderer (5199, `?ws=1`). Verify bằng state trong page: **12 nhân vật = 12 session thật** (Acme Web ×5, demo-app, video-src, codex-adapter, AI Image Generation, loving-curran…), đúng station theo tool (arcade khi Bash, bookshelf khi Read, desk khi Edit), badge Focusing/Running/Error đúng trạng thái thật.
2. **Demo assets** (`docs/media/`):
   - `demo.gif` — 20s, 10fps, 880px, **0.45MB**: nhân vật spawn ở cửa → đi về bàn/arcade, badge + bubble sống.
   - `office-hero.png` — full office, 8 nhân vật tại trạm, 65KB.
3. **README viết lại** (tiếng Anh, chuẩn bị open-source): hero GIF đầu trang, quick start 3 bước (clone → daemon → renderer, kèm mock mode không cần daemon), sơ đồ ASCII giữ nguyên ý cũ (thêm `packages/protocol` + `/transcript`), mục "Status: early PoC" trung thực, vision giữ nguyên: *answer "where do I need to intervene?" faster than the terminal*.

## 👀 Quan sát cho PM (không phải bug tôi tự sửa)

1. **Hidden-tab freeze (đáng làm nhất)**: browser dừng `requestAnimationFrame` khi tab bị ẩn → nhân vật đứng im **dồn đống ở cửa** (movement tính theo `dtMs` nên không catch-up khi tab hiện lại; Pixi ticker có vẻ dừng hẳn). State/reducer vẫn đúng tuyệt đối — chỉ là render. Gợi ý rẻ: lắng nghe `visibilitychange` → snap puppet về `standingPosition` hiện tại. Đã ghi 1 dòng "known limits" trong README.
2. **Side panel TRANSCRIPT kẹt "Đang tải..."** khi tôi mở panel cho `codex-adapter` (môi trường tab ẩn, mở panel qua `layer.onAgentClick` trực tiếp). Phần Trạng thái/Hoạt động gần nhất render đầy đủ và đúng. Có thể do môi trường của tôi (timer bị throttle) — nhờ chip Mission Control xác nhận lại trong tab hiện hình.
3. **Label chồng nhau** khi nhiều nhân vật đứng gần nhau (tên session dài kiểu `AI Image Generation_20260703_165721`) — cosmetic, cân nhắc truncate.
4. Queue "Cần can thiệp" hoạt động tốt với data thật — bắt đúng cả session của chính tôi khi tool call bị deny.

## Cách quay demo (để tái tạo)

Tab Chrome ẩn không chạy rAF → tôi drive animation thủ công qua CDP: `layer.tick(state, 100)` mỗi frame + `renderer.render()` + `canvas.toDataURL` POST về một server tạm trong scratchpad, rồi `ffmpeg` ghép 200 frame (palettegen 128 màu) thành GIF. Không đụng code repo.
