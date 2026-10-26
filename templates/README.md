# Company Templates

Mỗi thư mục con là một "công ty đóng hộp" — 1 `roster.yaml` (sơ đồ nhân sự đa agent) + 1 `goals.md` (mục tiêu cho `company-pm`).

Cách dùng qua `node scripts/company-template.mjs`:
- `list` — liệt kê template có sẵn.
- `show <name>` — xem roster + goals của 1 template.
- `apply <name>` — đè template lên `~/.claude/company/roster.yaml` (có backup `.bak`), báo skill thiếu.
- `save <name>` — lưu roster hiện tại thành template mới.

Template là sản phẩm bán được: làm xong 1 setup thật cho khách → `save` thành template → bán/tái dùng.

Từ lane L6: member có thể kèm `persona:` (ai) và `sop:` (làm thế nào — file `sops/<vị-trí>.md`).
`apply` chép cả `sops/` cạnh roster; thử mà không đụng roster thật:
`node scripts/company-template.mjs apply coding --company-dir /tmp/thu/company --home /tmp/thu/home`.
Định dạng + kiểm tra: `docs/company-templates.md`.
