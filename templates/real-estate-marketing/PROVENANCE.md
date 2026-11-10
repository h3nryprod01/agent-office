# Nguồn gốc và giấy phép của các thành viên trong roster

Không phải ý kiến pháp lý. Lập ngày 10/11/2026.

Template này **không chứa nội dung skill nào**: `roster.yaml` chỉ gọi tên. Skill nằm trên máy của người dựng template, và khi giao một gói có kèm skill cho khách thì nội dung đó mới được chép đi. Bảng dưới cho biết mỗi tên trong roster đến từ đâu và theo giấy phép nào, để trước khi giao biết phải giữ thông báo nào và loại gì.

## Cách đã kiểm

- Với mỗi thành viên, tìm file skill/agent tương ứng trên máy dựng template rồi so với repo công khai bằng mã băm Git của file (không gửi nội dung đi đâu).
- **Trùng từng byte**: file khớp hoàn toàn một file trong repo nguồn ở bản hiện hành ngày 10/11/2026. Nguồn chắc chắn.
- **Trùng tên, khác nội dung**: repo nguồn có skill cùng tên nhưng nội dung đã đổi so với bản đang dùng (thường là khác phiên bản). Nguồn rất có khả năng đúng, nhưng giấy phép phải đối chiếu lại với đúng phiên bản được chép.
- **Chưa rõ**: không tìm được nguồn công khai. Không đoán.
- Cột giấy phép là giấy phép của repo nguồn (hoặc của thư mục skill nếu có file riêng), đọc từ repo; chưa đọc từng file con.

## Bảng (39 thành viên)

Roster hiện có 39 thành viên, không phải 37 như một số ghi chú cũ.

| # | Thành viên | Nguồn (URL công khai) | Đường dẫn trong repo nguồn | Giấy phép | Mức kiểm |
|---|---|---|---|---|---|
| 1 | content-engine | https://github.com/affaan-m/ECC | `skills/content-engine/` | MIT | Trùng từng byte (bản sao trong repo) |
| 2 | content-research-writer | https://github.com/ComposioHQ/awesome-claude-skills | `content-research-writer/` | Apache-2.0 theo README của repo; thư mục không có file giấy phép riêng | Trùng từng byte |
| 3 | competitive-ads-extractor | https://github.com/ComposioHQ/awesome-claude-skills | `competitive-ads-extractor/` | như dòng 2 | Trùng từng byte |
| 4 | ui-ux-pro-max | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | gốc repo | MIT (file LICENSE đi kèm bản đang dùng, ghi "Copyright (c) 2024 Next Level Builder") | Nguồn xác định qua file giấy phép và README đi kèm; không so mã băm |
| 5 | marketing:campaign-plan | https://github.com/anthropics/knowledge-work-plugins | `marketing/skills/campaign-plan/` | Apache-2.0 | Trùng từng byte (bản plugin đã tải về) |
| 6 | marketing:email-sequence | https://github.com/anthropics/knowledge-work-plugins | `marketing/skills/email-sequence/` | Apache-2.0 | Trùng từng byte (bản plugin đã tải về) |
| 7 | marketing-content-creator | https://github.com/msitarzewski/agency-agents | `marketing/marketing-content-creator.md` | MIT | Trùng tên, khác nội dung |
| 8 | copywriting | https://github.com/coreyhaines31/marketingskills | `skills/copywriting/` | MIT | Trùng tên, khác nội dung |
| 9 | content-strategy | https://github.com/coreyhaines31/marketingskills | `skills/content-strategy/` | MIT | Trùng tên, khác nội dung |
| 10 | cro | https://github.com/coreyhaines31/marketingskills | `skills/cro/` | MIT | Trùng tên, khác nội dung |
| 11 | seo-audit | https://github.com/coreyhaines31/marketingskills | `skills/seo-audit/` | MIT | Trùng tên, khác nội dung |
| 12 | marketing-psychology | https://github.com/coreyhaines31/marketingskills | `skills/marketing-psychology/` | MIT | Trùng tên, khác nội dung |
| 13 | referrals | https://github.com/coreyhaines31/marketingskills | `skills/referrals/` | MIT | Trùng tên, khác nội dung |
| 14 | lead-magnets | https://github.com/coreyhaines31/marketingskills | `skills/lead-magnets/` | MIT | Trùng tên, khác nội dung |
| 15 | ad-creative | https://github.com/coreyhaines31/marketingskills | `skills/ad-creative/` | MIT | Trùng tên, khác nội dung |
| 16 | social | https://github.com/coreyhaines31/marketingskills | `skills/social/` | MIT | Trùng tên, khác nội dung |
| 17 | hyperframes | https://github.com/heygen-com/hyperframes | `skills/hyperframes/` | Apache-2.0 | Trùng tên, khác nội dung |
| 18 | hyperframes-explainer | chưa rõ | | chưa rõ | Không tìm thấy trong repo hyperframes; bản đang dùng tự nhận xây trên HyperFrames |
| 19 | product-launch-video | chưa rõ | | chưa rõ | Repo hyperframes chỉ có tài liệu hướng dẫn cùng tên, không có skill; bản đang dùng tự nhận thuộc hệ HyperFrames. Chưa xác định nơi phát hành chính thức |
| 20 | fal-ai-media | https://github.com/affaan-m/ECC | `skills/fal-ai-media/` | MIT | Trùng tên, khác nội dung; bản đang dùng ghi nguồn gốc ECC |
| 21 | image-enhancer | https://github.com/ComposioHQ/awesome-claude-skills | `image-enhancer/` | như dòng 2 | Trùng từng byte |
| 22 | canvas-design | https://github.com/anthropics/skills | `skills/canvas-design/` | Apache-2.0 (file LICENSE.txt đi kèm bản đang dùng là văn bản Apache 2.0) | Trùng từng byte |
| 23 | video-editing | https://github.com/affaan-m/ECC | `skills/video-editing/` | MIT | Trùng tên, khác nội dung; bản đang dùng ghi nguồn gốc ECC |
| 24 | design-image-prompt-engineer | https://github.com/msitarzewski/agency-agents | `design/design-image-prompt-engineer.md` | MIT | Trùng từng byte |
| 25 | kiem-tra-phap-ly | repo này | `sops/kiem-tra-phap-ly.md` | MIT (giấy phép của repo) | Viết riêng cho template, không phải skill cài |
| 26 | deep-research | https://github.com/affaan-m/ECC | `skills/deep-research/` | MIT | Trùng tên, khác nội dung; bản đang dùng ghi nguồn gốc ECC |
| 27 | exa-search | https://github.com/affaan-m/ECC | `skills/exa-search/` | MIT | Trùng tên, khác nội dung; bản đang dùng ghi nguồn gốc ECC |
| 28 | market-research | https://github.com/affaan-m/ECC | `skills/market-research/` | MIT | Trùng từng byte (bản sao trong repo) |
| 29 | lead-research-assistant | https://github.com/ComposioHQ/awesome-claude-skills | `lead-research-assistant/` | như dòng 2 | Trùng từng byte |
| 30 | product-trend-researcher | https://github.com/msitarzewski/agency-agents | `product/product-trend-researcher.md` | MIT | Trùng tên, khác nội dung |
| 31 | customer-research | https://github.com/coreyhaines31/marketingskills | `skills/customer-research/` | MIT | Trùng tên, khác nội dung |
| 32 | crosspost | https://github.com/affaan-m/ECC | `skills/crosspost/` | MIT | Trùng tên, khác nội dung; bản đang dùng ghi nguồn gốc ECC |
| 33 | youtube-seo | chưa rõ | | chưa rõ | Cùng định dạng với bộ marketingskills nhưng không có trong repo đó ở bản hiện hành |
| 34 | marketing-video-optimization-specialist | https://github.com/msitarzewski/agency-agents | `marketing/marketing-video-optimization-specialist.md` | MIT | Trùng từng byte |
| 35 | dieu-phoi | repo này | `sops/dieu-phoi.md` | MIT (giấy phép của repo) | Viết riêng cho template, không phải skill cài |
| 36 | small-business:lead-triage | https://github.com/anthropics/knowledge-work-plugins | `small-business/skills/lead-triage/` | Apache-2.0 (file LICENSE ở gốc repo) | Trùng tên, khác nội dung |
| 37 | small-business:crm-maintenance | chưa rõ | | chưa rõ | Không có trong plugin small-business bản đang cài lẫn trong repo nguồn; tên có thể đã đổi hoặc bị gỡ |
| 38 | small-business:run-campaign | chưa rõ | | chưa rõ | Như dòng 37 |
| 39 | file-organizer | https://github.com/ComposioHQ/awesome-claude-skills | `file-organizer/` | như dòng 2 | Trùng từng byte |

## Việc cần làm trước khi giao gói có skill cho khách

1. **Loại hoặc thay** các dòng "chưa rõ" (18, 19, 33, 37, 38) cho tới khi biết nguồn và giấy phép. Dòng 37 và 38 còn là tên không còn khớp skill nào trên máy này.
2. **Giữ thông báo giấy phép** của từng nguồn khi chép: MIT và Apache-2.0 đều yêu cầu đi kèm văn bản giấy phép (và thông báo bản quyền nếu có). Với Apache-2.0 còn phải ghi rõ chỗ đã sửa nếu có sửa. Đây là mô tả chung về hai giấy phép, chưa đối chiếu với từng file cụ thể.
3. **Đối chiếu lại các dòng "trùng tên, khác nội dung"** với đúng phiên bản sẽ chép: giấy phép của repo ở bản hiện hành có thể khác bản đang dùng.
4. **Dòng 2, 3, 21, 29, 39** (ComposioHQ/awesome-claude-skills): GitHub không nhận diện giấy phép của repo; README ghi Apache-2.0 còn thư mục skill không có file giấy phép riêng. Nếu cần chắc chắn, hỏi tác giả hoặc thay skill.
5. Thành viên `builtin` (25, 35) là SOP trong repo này, đi theo giấy phép MIT của repo.
