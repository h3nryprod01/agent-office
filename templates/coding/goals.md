# Mục tiêu — <TÊN DỰ ÁN>

Điền 3 chỗ trống dưới đây trước khi giao việc cho PM. Bỏ trống thì agent sẽ tự đoán, và đoán sai.

## Dự án làm gì

<TÊN DỰ ÁN> — mô tả một câu, viết cho người ngoài đọc.

Ngăn xếp: <NGÔN NGỮ/FRAMEWORK>.

## Thế nào là xong

<ĐỊNH NGHĨA XONG> — ví dụ: test xanh, review đã duyệt, PR đã merge, deploy được.

Một việc chưa đạt đủ các điều kiện trên thì vẫn ở cột `review`, không được kéo sang `done`.

## Kỷ luật thi công

- Mỗi việc một branch, một PR. Không commit thẳng vào `main`.
- Test trước, code sau. Đổi hành vi mà không đổi test là dấu hiệu sai.
- Diff tối thiểu: mọi dòng thay đổi phải truy được về yêu cầu.

## Cần tuyển

Gap nhân sự đã biết của template này — chạy `company-hire` khi cần:

- **Chưa có ai chạy CI thật.** Không thành viên nào chạm được vào pipeline; test chỉ chạy trên máy.
- **Chưa có ai review DB migration.** `typescript-reviewer` không đọc schema; migration đang không có người gác.
