# Status — wi-template-realestate (Template BĐS marketing, bản GENERAL)

_2026-07-10 — template-author-re. Đơn hàng thật đầu tiên theo hướng thương mại hoá company-templates._

## Đã giao

`templates/real-estate-marketing/` — "công ty đóng hộp" cho team marketing bất động sản, tái dùng
nguyên hệ company-template (R11). Không đụng `packages/`, `scripts/`, `.claude/`.

> **Cập nhật 2026-07-10 (lần 2):** 10 skill từ `coreyhaines31/marketingskills` đã được cài thật
> (scan CAUTION/26, 3 finding spot-check = false-positive trong docs, 0 file thực thi) → chuyển từ
> "đề xuất" sang **active member**. Roster: 28 → 37 member; số member kiểm tra được: 22 → 32.
> `seo-audit` (bản cài thật) thay `marketing:seo-audit` (plugin) vì trùng vai. 22 skill còn lại của
> bộ này vẫn ở mục đề xuất. **Gap kênh VN không đổi** — không skill nào đăng được FB/TikTok/Zalo OA.

- **`roster.yaml`** — 37 member, 5 phòng, cùng schema roster thật
  (`version` / `updated` / `departments` / `members{name,source,hired,role}` / `model_routing` /
  `budget_usd_per_day` / `repos`). Tổng ngân sách gợi ý 270 USD/ngày.

  | Phòng | Vai trò | Ngân sách/ngày |
  |---|---|---|
  | `marketing` | chiến lược, viết bài, ad copy, landing thu lead | 60 |
  | `media` | ảnh/video listing, reel, thumbnail, video ra mắt dự án | 100 |
  | `research` | thị trường, đối thủ khu vực, lead tiềm năng | 50 |
  | `social` | phân phối đa kênh, SEO YouTube | 30 |
  | `ops` | phân loại lead, CRM, kho tài sản | 30 |

- **`goals.md`** — 5 nhóm goal `company-pm` chạy được: lịch nội dung tuần, chiến dịch lead-gen,
  bộ ảnh/video tái dùng cho 1 dự án/căn, báo cáo thị trường định kỳ, repurpose nội dung dài → đa kênh.
  Kèm bảng **Cần tuyển** và bảng **CHỖ TRỐNG**.

## Verify

- `node scripts/company-template.mjs show real-estate-marketing` → exit 0, in đủ roster + goals.
- `node scripts/company-template.mjs list` → thấy `real-estate-marketing` cạnh `content-studio`.
- Kiểm skill ma bằng chính `company-template-lib.mjs` (`extractMemberNames` + `missingSkills`) đối chiếu
  `~/.claude/skills` + `~/.claude/agents`, **read-only** (không chạy `apply` vì `apply` ghi đè roster thật):
  37 member → 5 member plugin (không check được) → **32 member kiểm tra được, 0 thiếu**. Không member trùng tên.
- 10 skill marketingskills: verify độc lập là thư mục thật (không phải symlink), có `SKILL.md`,
  `find -name '*.sh' -o '*.py' -o '*.js' -o '*.mjs'` → **0 file thực thi** ở cả 10 — khớp với kết luận scan.
- `gh repo view coreyhaines31/marketingskills` → MIT, 37.413★. `gh api .../contents/skills` → **46 skill**
  (không phải 47); cả 32 skill được map đều tồn tại.

## Phát hiện trong lúc verify

**`frontend-design` và `schedule` không phải bản cài bền.** Cả hai chỉ là symlink trỏ vào
`~/Library/Application Support/Claude/local-agent-mode-sessions/.../<uuid>/skills/` — thư mục theo phiên
Claude Desktop. `installedSkills()` của CLI dùng `withFileTypes` không follow symlink nên coi chúng là
CHƯA CÀI, và về bản chất thì đúng: đường dẫn gắn UUID phiên, không tồn tại trên máy khách.

→ Đã bỏ khỏi roster, thay `frontend-design` bằng `ui-ux-pro-max` (thư mục thật), và ghi cả hai vào
mục "Cần tuyển" của `goals.md`. Roster không còn skill ma.

> Ghi chú cho coordinator, **ngoài phạm vi work item này**: roster thật
> `~/.claude/company/roster.yaml` đang dùng tên agent `content-creator`, `trend-researcher`,
> `video-optimization-specialist`, nhưng file trên đĩa tên là `marketing-content-creator.md`,
> `product-trend-researcher.md`, `marketing-video-optimization-specialist.md`. CLI index theo tên file
> → 3 member này sẽ bị báo "thiếu" nếu ai đó `save` rồi `apply` lại roster thật. Template mới dùng đúng
> tên file nên sạch. Không tự sửa vì ngoài vùng file được giao.

## Giới hạn đã ghi thẳng vào goals (không giấu)

- `crosspost` chỉ hỗ trợ X / LinkedIn / Threads / Bluesky. **Facebook, TikTok, Zalo OA — 3 kênh quan
  trọng nhất của BĐS Việt Nam — chưa có skill đăng tự động.** Phòng `social` hiện chỉ *soạn* nội dung
  cho các kênh này; người thật đăng tay. MCP `zernio` chưa lộ tool đăng bài nào khi search → chưa dám
  đưa vào roster.
- Chưa có skill chạy ads thật (Facebook/Google Ads Manager) — Goal 2 dừng ở ad copy + góc quảng cáo.
- Chưa có skill định giá / pháp lý dự án. Mọi khẳng định pháp lý trong bài review **phải người thật duyệt**.
- Chưa có member đặt lịch lặp lại (xem phát hiện `schedule` ở trên).

## CHỖ TRỐNG — user cần điền để áp cho khách thật

Đây là thứ đang chặn việc giao template cho `company-pm` chạy đơn thật:

| Chỗ trống | Cần biết gì |
|---|---|
| `<TÊN ĐƠN VỊ>` | Tên thương hiệu xuất hiện trong mọi nội dung |
| `<LOẠI HÌNH>` | Môi giới / chủ đầu tư / sàn — quyết định giọng bán hàng hay uy tín dự án |
| `<SẢN PHẨM>` | Căn hộ / đất nền / nhà phố / cho thuê — chi phối toàn bộ bộ ảnh-video (Goal 3) |
| `<KHU VỰC>` | Địa bàn cho lịch nội dung và báo cáo thị trường |
| `<PHÂN KHÚC KHÁCH>` | Mua ở / đầu tư / thuê |
| `<KÊNH ƯU TIÊN>` | Nếu là FB/TikTok/Zalo thì giới hạn `crosspost` ở trên áp dụng ngay |
| `<BRAND/TONE>` | Màu, font, xưng hô, có emoji hay không |
| `<SỐ LEAD/THÁNG>` | Mục tiêu định lượng chiến dịch lead-gen |
| `<HÀNG THÁNG/QUÝ>` | Tần suất báo cáo thị trường |

Có brief khách → điền bảng trên, chạy `apply real-estate-marketing`, xử lý danh sách skill thiếu bằng
`company-hire`, rồi giao `goals.md` cho `company-pm`.
