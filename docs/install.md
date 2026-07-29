# Cài đặt & vận hành

Dành cho người nhận bàn giao Agent Office. Cần **Node 20+**. Không cần gì khác.

## Chạy

**macOS** — một lệnh, từ bản clone sạch hay vào sáng ngày demo:

```bash
./scripts/start.sh
```

Nó cài dependency nếu thiếu, build lại renderer, dựng daemon nếu chưa chạy, rồi mở
**http://localhost:8787**. Chạy lại lúc nào cũng được — nó dùng lại daemon đang có.

> Mở bằng `localhost`, đừng gõ tay `127.0.0.1`. Trình duyệt coi hai địa chỉ này
> là hai origin riêng và cấp quyền riêng — vào bằng IP thì phải cấp lại quyền
> microphone, chưa cấp thì nút 🎤 không nhận giọng và không báo gì cả.

Muốn bấm đúp thay vì gõ lệnh:

```bash
./scripts/make-app.sh     # tạo ~/Applications/Agent Office.app
```

**Windows** — trong PowerShell, từ thư mục repo:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

> `start.ps1` đã **parse + dry-run sạch trên pwsh 7.6.3 (macOS)**: 0 lỗi cú pháp,
> và với daemon đang chạy thì cả luồng non-Windows chạy trót lọt (kiểm deps →
> `npm run build` → chờ cổng → exit 0). **Chưa chạy trên Windows thật** phần
> Windows-only: `Start-ScheduledTask` đăng ký/khởi động daemon, `Start-Process` mở
> trình duyệt, và perf x86. `install-daemon-service.ps1` (script này gọi tới) thì
> đã verify trên Windows 11 thật ([windows-port.md](windows-port.md)). Trên Windows,
> lần chạy đầu vẫn là bài test: đúng thì in `Agent Office -> ...` và mở trình duyệt.

## Cái gì chạy ở đâu

| Thứ | macOS | Windows |
|---|---|---|
| Daemon | launchd `com.agentoffice.daemon`, chạy lúc đăng nhập, tự dựng lại khi chết | Scheduled Task `AgentOfficeDaemon` |
| Log daemon | `~/Library/Logs/agent-office-daemon.log` | `%LOCALAPPDATA%\agent-office\agent-office-daemon.log` |
| Log khi bấm đúp `.app` | `~/Library/Logs/agent-office-app.log` | — |
| App | `http://localhost:8787` — **một tiến trình, một cổng**: daemon phục vụ luôn bản build | như macOS |

Chỉ nghe ở `127.0.0.1`, không mở ra mạng ngoài.

## Hỏng thì xem đâu

**Trang 404 hoặc trắng.** Chưa build `packages/renderer/dist`. Chạy `./scripts/start.sh` —
nó luôn build. Đây là lý do file này tồn tại: `install-daemon-service.sh` chỉ cài
service phục vụ `dist/`, nó không tự build.

**Văn phòng vẫn là bản cũ sau khi sửa code.** Cũng vậy — daemon đọc file từ đĩa theo
từng request, nên `start.sh` build xong là nó phục vụ bản mới ngay, không cần restart.
Nhưng nếu bạn build bằng tay và quên, daemon vẫn trả **200 kèm bản cũ** và trông y như
đang khoẻ. Nó không có cách nào báo cho bạn biết.

**Cấu hình báo "Mất kết nối" (chế độ live).** Daemon chết thật. Xem log ở bảng trên.
Dựng lại: chạy lại `./scripts/start.sh`.

**Bóng đổ tự nhiên biến mất.** Cố ý: máy tụt dưới 20 fps quá 3 giây thì office bỏ bóng
đổ để giữ mượt, và không bật lại cho tới khi tải lại trang. Đo được 3 fps trên VM
Windows ARM không có tăng tốc GPU. Tải lại trang là bóng trở về.

**Máy không có WebGL.** App vẫn chạy: Bảng việc, Nhật ký, Chi phí, Cấu hình đều bình
thường, chỉ khung Văn phòng 3D được thay bằng lời giải thích.

## Demo không cần daemon

Thêm `?mock=1` → kịch bản dựng sẵn, mở thẳng vào Văn phòng, không cần daemon hay
session thật. Dùng để cho người ta thấy sản phẩm trước khi họ kết nối gì cả.
Ở chế độ này Bảng việc / Nhật ký / Chi phí **không có dữ liệu** — đúng thiết kế, vì
không có daemon để hỏi.

Bản thật thì ngược lại: chạy `http://127.0.0.1:8787` không kèm tham số, các phiên
Claude Code đang chạy sẽ hiện thành nhân vật trong vài giây.

## Gỡ cài đặt

```bash
./scripts/install-daemon-service.sh uninstall     # macOS
rm -rf ~/Applications/Agent\ Office.app           # nếu đã tạo .app
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-daemon-service.ps1 uninstall
```

Xoá repo là hết — không có gì nằm ngoài repo, service, và mấy file log kể trên.
