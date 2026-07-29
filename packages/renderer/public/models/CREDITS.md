# Model credits — `public/models/`

These ship to the browser, so their provenance lives next to them. (The repo's
`assets/CREDITS.md` covers the retired 2D pixel-art pipeline, which the renderer
no longer loads or ships.)

| File | Nguồn | License | Ghi chú |
|---|---|---|---|
| `RobotExpressive.glb` | [three.js examples](https://github.com/mrdoob/three.js/tree/r171/examples/models/gltf) (r171) | CC0 — Tomás Laulhé, chỉnh sửa bởi Don McCurdy | Rigged + animation (Idle/Walking/Wave/No/ThumbsUp). Kind `robot`. Chỉ tải khi có ai gọi `setKind("robot")` — hiện app không có UI đổi kind. |

Nhân vật mặc định (`screen` — "Đầu màn hình") là **procedural**: dựng bằng
primitive của three.js trong `src/render3d/robotKit.ts`. Không phụ thuộc asset,
không vướng license.

## Đã bỏ

`Xbot.glb` (kind `human`) đã gỡ 2026-07-17. Rig gốc từ Mixamo (Adobe) nên license
để redistribute **không xác minh được**, trong khi asset đó **không dùng tới**
(đã chốt mẫu 09 "Đầu màn hình"; robot cũng được đánh giá đẹp hơn human) và nặng
2.9MB. Sản phẩm có khách trả tiền thì không giữ asset license mờ mà chẳng đổi lại
lợi ích gì. Nếu sau này cần nhân vật người: dựng procedural như `screen`, hoặc
lấy asset có license rõ ràng.
