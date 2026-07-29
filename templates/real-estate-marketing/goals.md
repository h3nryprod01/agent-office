# Goals — Real Estate Marketing (bản general)

Goal mẫu cho `company-pm`. Đây là **bản general**, chưa gắn khách cụ thể: điền hết CHỖ TRỐNG ở
mục cuối rồi mới giao cho PM chạy.

Quy ước: mỗi bullet là 1 goal PM giao được cho phòng (`marketing` / `media` / `research` /
`social` / `ops`). Số lượng, tần suất, kênh đều sửa được theo khách.

## 1. Lịch nội dung tuần

- 3 bài listing cho `<SẢN PHẨM>` — mỗi bài 1 điểm bán khác nhau (giá, vị trí, tiến độ). → `marketing`
- 1 bài review dự án dạng dài (800–1200 chữ), có dẫn nguồn về pháp lý + tiến độ. → `marketing` + `research`
- 1 bài kiến thức mua nhà cho nhóm khách `<PHÂN KHÚC KHÁCH>` (vay, thuế phí, chọn hướng, kiểm tra sổ). → `marketing`
- 1 bản tin thị trường ngắn khu vực `<KHU VỰC>` (biến động giá, nguồn cung mới). → `research` → `marketing`
- Cuối tuần: PM tổng kết bài đã lên + 3 góc nội dung cho tuần sau. → `ops`

## 2. Chiến dịch lead-gen

- `marketing:campaign-plan`: kế hoạch chiến dịch cho `<SẢN PHẨM>`, mục tiêu `<SỐ LEAD/THÁNG>` lead.
- Landing page + form thu lead (họ tên, SĐT, nhu cầu, ngân sách). → `marketing` (`ui-ux-pro-max`)
- `competitive-ads-extractor`: bóc 10 ads đối thủ cùng khu vực → rút 5 góc quảng cáo, xếp hạng theo độ khác biệt.
- 3 biến thể ad copy + 3 hình cho mỗi góc thắng. → `marketing` + `media`
- Chuỗi email/tin nhắn nurture 5 chạm sau khi khách để lại thông tin. → `marketing` (`marketing:email-sequence`)
- Lead về → phân loại nóng/ấm/lạnh, đẩy vào CRM. → `ops` (`small-business:lead-triage`)

> Việc **chạy ads thật** (Facebook/Google Ads Manager) chưa có trong roster — xem "Cần tuyển".

## 3. Bộ ảnh/video cho 1 dự án/căn (template tái dùng)

Chạy 1 lần cho mỗi `<SẢN PHẨM>` mới, ra 1 bộ tài sản chuẩn:

- 10–15 ảnh listing đã nâng chất (ánh sáng, méo ống kính, dọn tạp vật). → `media` (`image-enhancer`)
- 3 ảnh phối cảnh/nội thất gợi ý bằng AI, ghi rõ nhãn "hình minh hoạ". → `media` (`fal-ai-media` + `design-image-prompt-engineer`)
- 1 poster bảng giá + 1 thumbnail. → `media` (`canvas-design`)
- 1 reel dọc 9:16 (30–45s): hook → 3 điểm bán → CTA. → `media`
- 1 video giới thiệu dự án 60–90s có voiceover tiếng Việt. → `media` (`hyperframes-explainer`)
- Dự án mở bán: thêm 1 video ra mắt. → `media` (`product-launch-video`)
- Tất cả tài sản lưu theo cây thư mục `<SẢN PHẨM>/{anh,video,poster}`. → `ops` (`file-organizer`)

## 4. Báo cáo thị trường khu vực (định kỳ)

- Tần suất `<HÀNG THÁNG/QUÝ>` cho khu vực `<KHU VỰC>`. → `research` (`deep-research`)
- Nội dung: mặt bằng giá theo loại hình, nguồn cung mới, dự án cạnh tranh, lãi suất vay, tâm lý người mua.
- Mọi con số phải có nguồn + ngày lấy số. Không có nguồn → ghi "chưa xác minh", không đoán.
- Rút gọn thành 1 post + 1 infographic. → `marketing` + `media`
- Đặt lịch lặp lại: **chưa có member làm việc này** — tạm thời PM tự nhắc hoặc dùng cron ngoài. Xem "Cần tuyển".

## 5. Repurpose 1 nội dung dài → đa kênh

Đầu vào: 1 bài review dự án hoặc 1 video tour đã có.

- Cắt 3–5 clip ngắn theo từng điểm bán. → `media` (`video-editing`)
- Viết caption riêng cho từng kênh, không dùng lại y nguyên. → `marketing` (`content-engine`)
- Video dài lên YouTube: title/description/tags/thumbnail. → `social` (`youtube-seo`)
- Đăng chéo các kênh roster hỗ trợ. → `social` (`crosspost`)
- Theo dõi kênh nào ra lead, tuần sau dồn về kênh đó. → `ops`

> **Giới hạn thật:** `crosspost` chỉ hỗ trợ **X / LinkedIn / Threads / Bluesky**. Facebook,
> TikTok, Zalo OA — 3 kênh quan trọng nhất của BĐS Việt Nam — **chưa có skill đăng tự động**.
> Hiện tại phòng `social` chỉ *soạn* nội dung cho các kênh này, người thật đăng tay.

## Cần tuyển (chạy skill `company-hire`, bắt buộc `skillspector-scan`)

Những năng lực goals ở trên cần mà roster chưa có. Không skill nào bên dưới đang tồn tại — đừng
giao việc cho chúng cho tới khi tuyển xong.

| Năng lực | Vì sao cần | Ghi chú |
|---|---|---|
| Đăng Facebook Page / Zalo OA / TikTok | 3 kênh chính của BĐS VN, `crosspost` không hỗ trợ | Kiểm tra MCP `zernio` có tool đăng bài không trước khi tuyển skill mới |
| Ads Manager (Facebook / Google) | Goal 2 dừng ở ad copy, chưa chạy & tối ưu được ngân sách | Cần quyền tài khoản ads của khách |
| Định giá / so sánh giá·m² | Báo cáo thị trường đang dựa hoàn toàn vào nguồn public | Có thể thay bằng data feed khách cung cấp |
| Pháp lý dự án (sổ, quy hoạch, tiến độ) | Bài review dự án chạm nội dung pháp lý — rủi ro sai | Trong lúc chưa có: mọi khẳng định pháp lý phải người thật duyệt |
| CRM lead pipeline thật | `small-business:*` là plugin generic, không có pipeline BĐS | Hoặc nối CRM sẵn có của khách |
| Lịch lặp lại (`schedule`) | Goal 4 cần chạy định kỳ mà không ai nhắc | Skill `schedule` **có trên máy nhưng chỉ là symlink vào phiên Claude Desktop** — không phải bản cài bền, `apply` sẽ báo thiếu. Cài bản thật vào `~/.claude/skills/` hoặc dùng cron. |
| Dựng landing page bản thật (`frontend-design`) | Đang thay bằng `ui-ux-pro-max` | Cùng lý do symlink như trên — tuỳ chọn nâng cấp, không chặn |

## `coreyhaines31/marketingskills` — 10 đã cài, 22 còn đề xuất

Plugin Claude Code, **MIT**, 37.413★, 46 skill (kiểm 2026-07-10 qua `gh repo view`). Tác giả Corey Haines.

### Đã cài 2026-07-09 → đã là member trong `roster.yaml`

`copywriting` · `content-strategy` · `cro` · `seo-audit` · `marketing-psychology` · `referrals` ·
`lead-magnets` · `ad-creative` · `social` → phòng `marketing`; `customer-research` → phòng `research`.

Cài lẻ dạng prose. Scan verdict **CAUTION (26)**, nhưng 3 finding spot-check đều là false-positive nằm
trong docs, **0 file thực thi**. Xác nhận độc lập 2026-07-10: cả 10 là thư mục thật trong
`~/.claude/skills`, có `SKILL.md`, `find` ra 0 file `.sh/.py/.js/.mjs`.

Hai điều chỉnh khi tiếp nhận:

- **`seo-audit` thay `marketing:seo-audit`** (plugin). Cùng một việc — giữ cả hai thì hai member cùng
  nhận một loại task. Bản `~/.claude/skills` verify được, bản plugin thì không.
- **`social` KHÔNG thay `crosspost`.** `social` *soạn* nội dung + social listening; `crosspost` *đăng*.
  Hai việc khác nhau, giữ cả hai, đừng gộp.
- **`ad-creative` KHÔNG vá gap "chạy ads".** Nó sinh biến thể ad copy, không đụng Ads Manager.

### Còn đề xuất — CHƯA cài (22 skill)

> Không skill nào dưới đây là member. Đừng giao việc cho chúng.
> Cài: `/plugin marketplace add coreyhaines31/marketingskills` (hoặc lẻ `npx skills add ...`).
> **Bắt buộc `company-hire` + `skillspector-scan` trước khi cài** — không bypass, kể cả repo MIT nhiều sao.

| Phòng | Skill đề xuất | Vì sao hợp BĐS |
|---|---|---|
| `marketing` | `popups`, `signup`, `emails`, `cold-email`, `sms` | Phần còn lại của phễu lead-gen (Goal 2) |
| `marketing` / `ops` | `ai-seo`, `programmatic-seo`, `schema`, `site-architecture`, `directory-submissions` | Local SEO cho listing: mỗi căn/dự án là 1 trang. **Ưu tiên cài cụm này trước** |
| `marketing` | `ads` | Vá một phần gap "chạy ads" ở bảng trên |
| `marketing` | `copy-editing` | Biên tập bài đã viết |
| `media` | `video`, `image` | Bổ trợ bộ tài sản Goal 3 |
| `research` | `competitor-profiling`, `competitors` | Hồ sơ đối thủ khu vực |
| `marketing` | `public-relations`, `launch` | Lễ mở bán dự án |
| `marketing` | `marketing-plan`, `marketing-ideas`, `marketing-loops`, `analytics` | Kế hoạch + đo lường |

**Bỏ qua** (thiên SaaS/product, ít hợp BĐS): `churn-prevention`, `onboarding`, `product-marketing`, `aso`,
`paywalls`, `pricing`, `offers`, `sales-enablement`, `prospecting`, `co-marketing`, `free-tools`, `revops`.

**Trùng vai nếu cài thêm:** `emails` ↔ `marketing:email-sequence`; `video` ↔ `video-editing`;
`image` ↔ `fal-ai-media`; `competitors` ↔ `competitive-ads-extractor`. Cài xong phải chốt ai làm gì.

**Không vá được gap kênh VN:** không skill nào trong 46 skill này đăng bài lên Facebook / TikTok / Zalo OA.
Gap ở bảng "Cần tuyển" vẫn còn nguyên sau khi cài hết.

## CHỖ TRỐNG — điền trước khi giao PM

| Chỗ trống | Nghĩa | Ví dụ |
|---|---|---|
| `<TÊN ĐƠN VỊ>` | Tên thương hiệu xuất hiện trong mọi nội dung | "BĐS Minh Khang" |
| `<LOẠI HÌNH>` | môi giới / chủ đầu tư / sàn giao dịch | quyết định giọng: bán hàng hay uy tín dự án |
| `<SẢN PHẨM>` | căn hộ / đất nền / nhà phố / cho thuê | ảnh hưởng toàn bộ Goal 3 |
| `<KHU VỰC>` | Địa bàn cho Goal 1 và 4 | "TP Thủ Đức" |
| `<PHÂN KHÚC KHÁCH>` | Người mua ở / đầu tư / thuê | quyết định góc nội dung |
| `<KÊNH ƯU TIÊN>` | Kênh dồn lực | FB + TikTok → cảnh báo ở Goal 5 áp dụng |
| `<BRAND/TONE>` | Giọng và bộ nhận diện | màu, font, xưng hô, có emoji hay không |
| `<SỐ LEAD/THÁNG>` | Mục tiêu định lượng Goal 2 | "80 lead" |
| `<HÀNG THÁNG/QUÝ>` | Tần suất báo cáo Goal 4 | |
