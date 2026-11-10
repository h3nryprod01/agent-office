# Dữ liệu cá nhân trong template Bất động sản

**Đây không phải ý kiến pháp lý.** Tài liệu mô tả dòng dữ liệu của template này theo mã của Agent Office (xem [PRIVACY.md](../../PRIVACY.md) ở gốc repo) và liệt kê những việc khách phải tự lo. Các điều luật được nhắc ở đây chưa được đọc từ văn bản gốc; xem mục "Mức kiểm" ở cuối. Người có chuyên môn pháp lý của khách phải đọc và quyết.

Vai trò theo cách đặt vấn đề của kế hoạch triển khai: **khách là bên kiểm soát dữ liệu** (quyết định thu gì, để làm gì), người triển khai Agent Office cho khách là **bên xử lý**. Cách phân vai này cần được ghi vào hợp đồng; tài liệu này không thay thế hợp đồng.

## 1. Dữ liệu cá nhân nào đi qua template

| Dữ liệu | Chỗ xuất hiện trong template |
|---|---|
| Họ tên, số điện thoại, nhu cầu, ngân sách của lead | Form ở landing page (`goals.md` mục 2); đầu vào của `sops/cham-lead.md` |
| Danh sách khách đã từ chối nhận tin | Đầu vào của `sops/cham-lead.md` |
| Lịch sử trao đổi và câu hỏi khách đã hỏi | Bản ghi CRM do `sops/cham-lead.md` tạo |
| Hồ sơ căn hoặc dự án: có thể chứa tên chủ nhà, người mua, số giấy tờ | Đầu vào của `sops/viet-tin-rao.md`, `sops/kiem-tra-phap-ly.md` |
| Ảnh thật của căn hộ, đôi khi có người | `sops/xu-ly-anh.md`, `sops/video-ngan.md` |
| Tin nhắn của chính nhân viên khi chat với trợ lý (PM) qua Telegram hoặc Zalo | Xem PRIVACY.md mục 4 |

Template không tự thu dữ liệu từ khách: người của khách đưa dữ liệu vào, hoặc form của khách gửi vào CRM của khách. Template soạn bản nháp, người thật gửi mọi tin (`sops/cham-lead.md`).

## 2. Dữ liệu đi tới đâu

1. **Nhà cung cấp mô hình AI của công cụ agent.** Mọi thứ agent đọc hoặc viết trong một phiên (kể cả tên, số điện thoại và hồ sơ nếu nằm trong thư mục dự án hoặc được dán vào) được công cụ agent gửi tới nhà cung cấp mô hình, ví dụ Anthropic cho Claude Code. Nơi đặt máy chủ và thời hạn lưu giữ do nhà cung cấp và hợp đồng giữa khách với nhà cung cấp quyết định; chưa xác minh trong repo này, và nhiều khả năng nằm ngoài Việt Nam.
2. **Telegram hoặc Zalo, nếu bật cầu nối.** Yêu cầu duyệt (tên công cụ, tên dự án, 300 ký tự đầu của lệnh hoặc đường dẫn), câu trả lời đầy đủ của PM, thông báo agent kẹt và bản tóm tắt cuối ngày được gửi lên máy chủ của Telegram hoặc Zalo. Hiện chưa có bước che số điện thoại hay số giấy tờ trước khi gửi. Chi tiết: PRIVACY.md mục 4.
3. **Làn worker của bên thứ ba.** Agent Office nhận ra các phiên chạy qua nhà cung cấp khác (làn worker) và tính vào bảng chi phí. Nếu khách cho dữ liệu cá nhân đi qua làn đó, dữ liệu tới một nhà cung cấp khác, có thể ở nước khác, với điều khoản khác. **Không dùng làn worker cho dự án có dữ liệu cá nhân.** Chính sách duyệt của dự án (`allowedLanes`) có thể giới hạn làn được chạy.
4. **Ổ đĩa của máy chạy Agent Office.** Bản ghi phiên của agent nằm ở thư mục của công cụ agent, không phải của Agent Office; dữ liệu của Agent Office nằm ở `~/.agent-office` (PRIVACY.md mục 2). Cả hai ở dạng văn bản thường.

## 3. Khách phải tự lo

Danh sách này là điểm khởi đầu để người pháp lý của khách rà, không phải danh sách đầy đủ.

- **Thông báo và căn cứ xử lý với lead.** Khách phải cho người để lại thông tin biết dữ liệu dùng làm gì, ai nhận, và có căn cứ hợp lệ (thường là sự đồng ý) cho từng mục đích, nhất là mục đích nhắn tin quảng cáo. Template chỉ dùng số điện thoại "cho mục đích khách đã đồng ý" (`sops/cham-lead.md`) nhưng không ghi lại và không kiểm tra sự đồng ý đó.
- **Chuyển dữ liệu ra nước ngoài.** Theo nguồn thứ cấp, Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 có hiệu lực từ 01/01/2026 và Nghị định 356/2025 yêu cầu hồ sơ đánh giá tác động chuyển dữ liệu xuyên biên giới. Việc gửi dữ liệu lead tới nhà cung cấp mô hình AI ở nước ngoài (mục 2.1) và tới Telegram hoặc Zalo (mục 2.2) có thể thuộc diện này. Mức phạt, các trường hợp miễn trừ cho doanh nghiệp nhỏ và hạn chót hoàn thành hồ sơ: chưa xác minh.
- **Tin nhắn rác và quảng cáo qua điện thoại.** Nghị định 91/2020 về chống tin nhắn rác, thư rác, cuộc gọi rác điều chỉnh việc nhắn tin và gọi điện quảng cáo; chưa đọc văn bản gốc, và có thể đã được thay thế hoặc sửa đổi. Template đã giữ khung giờ im lặng 22:00 đến 07:00 và danh sách từ chối nhận tin, nhưng đó là quy tắc vận hành của template, không phải bảo đảm tuân thủ.
- **Phụ lục xử lý dữ liệu trong hợp đồng** giữa khách và người triển khai: phạm vi, mục đích, thời hạn lưu, bên nhận (kể cả nhà cung cấp mô hình và Telegram/Zalo), biện pháp bảo mật, cách trả lời khi có người đòi xem hay xoá dữ liệu của họ.
- **Tắt làn worker** cho dự án có dữ liệu cá nhân (mục 2.3), và quyết định có bật Telegram/Zalo cho dự án đó hay không.
- **Tài khoản dùng cho công cụ agent**: xem [docs/onprem.md](../../docs/onprem.md), mục "Whose Claude account".
- **Xoá dữ liệu khi khách hoặc lead yêu cầu**: dữ liệu nằm ở nhiều chỗ (CRM của khách, thư mục dự án, bản ghi phiên của công cụ agent, tin nhắn trên Telegram/Zalo, nhà cung cấp mô hình). Khách cần biết từng chỗ và ai xoá.
- **Dữ liệu nhạy cảm**: số giấy tờ tuỳ thân, giấy tờ nhà đất của cá nhân, thông tin tài chính. Chỉ đưa vào công cụ agent khi thật cần.

## Mức kiểm

- Mục 1 và 2: đọc từ mã Agent Office và từ các SOP của template.
- Mục 3: nội dung pháp lý lấy từ ghi chú kế hoạch (nguồn thứ cấp), **chưa đối chiếu với văn bản gốc** và chưa qua người có chuyên môn pháp lý.
