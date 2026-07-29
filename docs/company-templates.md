# Company Templates

Template = "công ty đóng hộp": 1 `roster.yaml` (sơ đồ nhân sự đa agent) + 1 `goals.md` (mục tiêu cho `company-pm`). Làm xong 1 setup thật cho khách → `save` thành template → bán / tái dùng. Đây là sản phẩm thương mại hoá chính.

## Dùng

```bash
node scripts/company-template.mjs list                 # xem template có sẵn
node scripts/company-template.mjs show content-studio  # xem roster + goals
node scripts/company-template.mjs apply content-studio # đè lên roster máy này
node scripts/company-template.mjs save <tên-mới>       # lưu roster hiện tại thành template
```

## Trong office — panel "🏢 Công ty đóng hộp"

Nút góc phải trên → overlay danh sách template (phòng ban, số thành viên, cảnh báo skill thiếu) → **Áp dụng** (bấm 2 lần mới ghi đè). Daemon phục vụ `GET /templates` + `POST /templates/apply`, dùng chung logic với CLI qua `scripts/company-template-lib.mjs`. Chi tiết: `docs/templates-panel-status.md`.

## apply — cài 1 template lên máy

1. Nếu đã có `~/.claude/company/roster.yaml`, copy sang `roster.yaml.bak` (backup an toàn, in đường dẫn).
2. Đè `templates/<name>/roster.yaml` lên `~/.claude/company/roster.yaml`.
3. Quét `~/.claude/skills` + `~/.claude/agents`, in danh sách skill template cần mà máy chưa có. Member dạng plugin (source `"plugin ..."`) không check được → coi như đã cài.
4. In `goals.md`.

Skill thiếu → chạy **skill `company-hire`** để tuyển (bắt buộc `skillspector-scan`, không bypass). Template chỉ chạy trơn khi mọi member đã cài.

## save — đóng gói 1 setup thật thành template

Copy `~/.claude/company/roster.yaml` → `templates/<name>/roster.yaml`. Sau đó tự thêm `templates/<name>/goals.md`.

## Template mẫu

- **content-studio** — Content Studio một-người: 3 phòng `media` + `marketing` + `research`, toàn skill đã cài (hyperframes, fal-ai-media, canvas-design, content-engine, crosspost, deep-research, ...).
- **real-estate-marketing** — Team marketing bất động sản (bản general, chưa gắn khách): 5 phòng `marketing` + `media` + `research` + `social` + `ops`. `goals.md` có bảng CHỖ TRỐNG cần điền theo khách và bảng "Cần tuyển" cho năng lực còn thiếu (đăng FB/TikTok/Zalo, chạy ads, pháp lý dự án). Xem `docs/template-realestate-status.md`.

## Lưu ý

- CLI KHÔNG đụng daemon/renderer (`packages/`); chỉ đọc/ghi `templates/` và `~/.claude/company/`. Chiều ngược lại thì có: daemon import `company-template-lib.mjs`.
- `apply` ghi đè roster thật — luôn có backup `.bak` (có timestamp, apply lần 2 không đè backup lần 1). Kiểm tra kỹ trước khi apply trên máy chính.
- Tên template phải khớp `^[a-z0-9-]+$` và là thư mục thật trong `templates/` — áp cho cả `apply`, `show`, `save` lẫn route daemon.
