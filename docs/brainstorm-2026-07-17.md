# Brainstorm hướng phát triển — 2026-07-17

> Kết quả workflow 4 lăng kính (sản phẩm / kinh doanh / kỹ thuật / thị trường) + phản biện đối kháng + tổng hợp. ~400k token, 6 agent. Lưu ở đây để Claude/Hermes trên Ubuntu tiếp tục có ngữ cảnh.

## Góc nhìn cốt lõi (reframe)

Ngã ba *"office = sản phẩm hay phễu?"* là câu hỏi **đúng nhưng hỏi quá sớm** — hỏi nó lúc này là một dạng trì hoãn đội lốt chiến lược. Cả hai đáp án vô nghĩa cho tới khi **một con người thật (khách #1, Windows 11) mở office HÀNG NGÀY thay vì canh terminal.**

Office không phải sản phẩm để đánh bóng, cũng không phải phễu thuần tuý — nó là **một bề mặt thông báo có gương mặt**. Scene 3D là lớp giải thích *"đang xảy ra gì"* SAU KHI cú vỗ vai đã trả lời *"bạn cần vào đây"*. Ngã ba tự giải theo **thời gian**: việc của office là **retention** (cú vỗ vai mỗi ngày), việc của template là **doanh thu**. Nối tiếp, không tranh nguồn lực.

**Chi tiết tố cáo nhất (phản biện chỉ ra):** phiên 2026-07-17 đổ công đóng gói demo **macOS** trong khi khách DUY NHẤT trả tiền chạy **Windows 11** — xây cho khách tưởng tượng, không phải khách đang có. Pattern lặp: BĐS (0 khách BĐS), catalog (cho khách #2..N), freeze protocol (1 consumer). Route mọi effort về đúng anh dev Windows đang trả tiền.

## Hướng phát triển (xếp hạng: impact × khả thi cho solo founder 1 khách)

| # | Hướng | Tiềm năng | Ghi chú |
|---|-------|-----------|---------|
| **1** | **❗ ra khỏi cửa sổ 3D — VERIFY trên Windows 11 khách #1** | **Cao** | OS notif + tiếng + badge menubar/dock. Kích CHỈ khi cần người (duyệt/block/agent hỏi). *THE ONE THING.* |
| **2** | Đóng khung **"radar can thiệp" + local-first** | Cao | Gần zero-build — thông điệp + kỷ luật không telemetry |
| **3** | **MỘT** template "Dev Team" **thật** trên Gumroad | Cao | Bán cho khách CÓ. Không gate, không catalog, không BĐS |
| 4 | roster-engine: apply spawn đội **thật** sống dậy | Cao | Ruột bán được — **để sau P1**, effort cao |
| 5 | Tín hiệu chệch hướng (❗ vàng) | Thử nghiệm | Moat "terminal không làm được" — sau, cần run thật tune |
| 6 | Vertical BĐS / mở catalog | Thử nghiệm | **Chỉ sau khi có khách #2 trả tiền** |
| 7 | **"ĐỪNG XÂY"** — bãi đỗ bẫy hạ tầng | — | mobile-approve, multiplayer, freeze protocol, dataset, marketing-export |

**THE ONE THING:** hướng #1 là **cổng cả hai con đường (sản phẩm lẫn phễu) đều phải đi qua**. Không retention hằng ngày → không sản phẩm để dùng, cũng không "văn phòng sống dậy" để phễu ai. Rẻ nhất, ROI thói-quen cao nhất.

## Góc nhìn đa chiều

- **Khách hàng:** solo dev không ngồi ngắm office — cần nó **gọi**. Câu sống còn: khách #1 có chạy **3+ agent song song**? Nếu không, "hàng đợi can thiệp" giải vấn đề **chưa tồn tại**.
- **Thị trường:** observability đã đông (LangSmith/Langfuse/Phoenix cloud-trace; Vibe Kanban/Conductor/Crystal/Claude Squad orchestrate). Tất cả là **công cụ đọc**. Không ai bán *"liếc là biết nhảy vào đâu"* — hào duy nhất. Đừng cạnh tranh ở "observability" (thua) — đóng khung **"radar can thiệp local"**.
- **Kỹ thuật/moat:** office 3D copy trong 1 cuối tuần. Moat thật = 2 lớp bẩn: (1) adapter chuẩn hoá transcript đa-harness, (2) roster-engine biến `roster.yaml` thành đội chạy thật. **Đừng** đóng băng "event protocol" thành contract khi 1 consumer (premature abstraction).
- **Kinh tế:** template = **SKU mua-đứt qua Gumroad/Lemon Squeezy** (tự lo VAT + payout quốc tế, bán được cho khách Windows **không cần installer công khai**). Không subscription khi 1 khách.
- **Rủi ro nền:** nếu ❗-ngoài-cửa-sổ **không thật sự** thắng terminal về tốc độ phát hiện block → ẩn dụ 3D là gimmick → cả sản phẩm mất lý do tồn tại. **Chưa ai đo con số này.**

## Wildcard

1. **"Agent Office tự dựng Agent Office"** — đừng làm demo riêng; stream/quay chính văn phòng thật (đội agent build chính Agent Office). Bạn đã là **khách #0**. **Đặc biệt hợp lúc này vì công việc đang chuyển sang Ubuntu — agent chạy trên Ubuntu có thể tự hiện trong office.** Marketing 0 đồng, real-data không fake được.
2. **"Nghe" thay vì "nhìn"** — office soundscape: mỗi hoạt động một âm nền; block thì âm đổi. Biết trạng thái đàn agent không cần liếc màn hình.
3. **Đảo mô hình giá** — free cái *để-ngắm* (office đẹp = trailer), **bán cái *ngắt-đúng-lúc*** (notification + drift tune theo project). Người ta trả tiền để **không phải canh**. Sản phẩm thật có thể là *retention-as-a-service*.

## Rủi ro

- **Notification fatigue** — tính năng #1 hỏng vì **tuning**, không phải code. Chỉ bắn đúng event "cần người thật" + tắt-tiếng-theo-project.
- **Tiêu effort sai chỗ** — demo macOS cho khách Windows, BĐS 0 khách, catalog cho khách #2..N, freeze protocol 1 consumer, lực hút polish renderer đã đủ tốt.
- **Template rỗng ruột = bán giả** — chỉ tên vai, không prompt/skill/flow thật → vi phạm "xấu-mà-thật thắng đẹp-mà-giả".
- **Mobile/duyệt-từ-xa = bề mặt tấn công thật** — phơi daemon (quyền duyệt Bash) ra mạng. Read-only + notify trước; approve cần auth + opt-in.
- **Local-first vs dataset/telemetry mâu thuẫn** — mộng benchmark cần thu data, phá lời hứa zero-telemetry. Opt-in tường minh hoặc không làm.

## Bước tiếp theo

1. **Dựng cầu notification trên Windows 11** (OS notif + tiếng + badge), kích chỉ khi {permission, hard block, agent hỏi}, ship tới máy khách #1 — *THE ONE THING, đúng OS khách CÓ.*
2. **Đo MỘT con số:** thời gian phát hiện block trên office+notif **vs** terminal — *de-risk toàn bộ luận đề với chi phí ~0.*
3. **Hỏi khách #1:** (a) có chạy 3+ agent song song? (b) sau notif, có mở office mỗi ngày thay vì canh terminal? — *hành vi duy nhất giải ngã ba.*
4. **Đóng gói MỘT roster "Dev Team" thật** thành SKU Gumroad, giao private 1-1 cho khách #1 — *doanh thu đầu tiên, không recurring infra.*
5. **Viết đoạn định vị local-first** đặt đầu mọi pitch; kỷ luật không lén thêm telemetry.

## Câu hỏi mở (chỉ khách/founder trả lời được)

- Khách #1 có **thật sự** chạy 3+ agent cùng lúc?
- Đằng sau "brief BĐS" là khách **thật chịu trả tiền** hay khách hy vọng?
- Khách #1 trả tiền cho **cái gì** — template, hay **sự tin cậy để ngừng babysit agent**?
- Nếu mai phải xoá 1 trong 2 — **renderer 3D** hay **lớp notification** — cái nào giữ được khách?
