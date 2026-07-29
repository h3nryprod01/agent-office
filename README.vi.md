# Agent Office

[English](README.md) · **Tiếng Việt**

[![CI](https://github.com/h3nryprod01/agent-office/actions/workflows/ci.yml/badge.svg)](https://github.com/h3nryprod01/agent-office/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%20%7C%2022-brightgreen.svg)](https://nodejs.org)

Các phiên agent lập trình của bạn, hiện lên thành một văn phòng isometric sống.

Mỗi nhân vật dưới đây là **một phiên agent thật** đang chạy trên máy này — đi tới kệ sách để đọc file, đập máy arcade để chạy lệnh, và giơ dấu ❗ đỏ khi cần bạn.

![Demo — phiên agent thật thành nhân vật trong văn phòng](docs/media/demo.gif)

## Vì sao có nó

Log terminal trả lời *"chuyện gì đã xảy ra?"*. Agent Office sinh ra để trả lời một câu khác, **nhanh hơn terminal**: *"tôi cần can thiệp ở đâu?"*

Hai nguyên tắc chi phối mọi quyết định ở đây:

- Data thật + real-time là linh hồn của sản phẩm.
- Đồ hoạ xấu với data thật **thắng** đồ hoạ đẹp với data giả.

## Chạy thử

Cần Node 20 trở lên.

```bash
git clone https://github.com/h3nryprod01/agent-office && cd agent-office
./scripts/start.sh
```

Lệnh này cài dependency, build renderer, dựng daemon thành login agent (tự chạy khi đăng nhập, tự sống lại khi chết), rồi mở **http://localhost:8787** — các phiên đang chạy hiện thành nhân vật trong vài giây.

Chạy lại lúc nào cũng được: nó build lại và dùng luôn daemon đang có. Một tiến trình, một cổng, luôn là bản build hiện tại.

> Mở bằng `localhost`, đừng gõ `127.0.0.1`. Trình duyệt coi đây là hai origin riêng với quyền riêng, và quyền microphone mà tính năng giọng nói cần sẽ không đi theo.

Chưa có phiên nào đang chạy? Thêm `?mock=1` để xem kịch bản dựng sẵn, và `?stress=30` để đo hiệu năng với 30 nhân vật.

**Windows:** `powershell -ExecutionPolicy Bypass -File scripts\start.ps1` — y hệt. Đã parse + dry-run sạch trên pwsh; phần Scheduled Task và mở trình duyệt là Windows-only, chưa chạy thật ở đó. Xem [docs/install.md](docs/install.md).

**Linux:** `./scripts/install-ubuntu.sh` — service systemd `--user`, chạy từ lúc boot.

**Thích bấm đúp hơn gõ lệnh?** `./scripts/make-app.sh` tạo *Agent Office.app* trong `~/Applications`.

**Đang sửa renderer?** `npm --prefix packages/renderer run dev` phục vụ ở **http://localhost:5199** với hot reload, nối cùng daemon đó.

Log, xử lý sự cố, gỡ cài đặt: **[docs/install.md](docs/install.md)**.

## Thực tế bạn nhận được gì

### Văn phòng

![Văn phòng — các phiên thật ở đúng trạm của mình](docs/media/office-hero.png)

Mỗi phiên sinh ra một nhân vật, và nhân vật đi lại giữa các trạm. Đứng ở đâu là biết đang làm gì, không cần đọc chữ: **bàn làm việc** = đang sửa code, **kệ sách** = đang đọc file, **máy arcade** = đang chạy lệnh, **bàn họp** = đang giao việc cho sub-agent.

Nhiều repo thành nhiều tab văn phòng. Dấu ❗ đỏ trên đầu nhân vật nghĩa là nó đang kẹt.

### Ai đang chờ ai

![Sơ đồ tổ chức — cây cha/con của agent, cập nhật trực tiếp](docs/media/readme/orgchart.png)

Sub-agent có nhân vật riêng, nối dây về đúng agent đã sinh ra nó. Sơ đồ tổ chức là cùng thông tin đó dưới dạng cây, kèm số đếm sống: bao nhiêu đang làm, bao nhiêu kẹt, bao nhiêu xong.

### Toàn bộ repo cùng lúc

![Toà nhà — mỗi repo một tầng](docs/media/readme/building.png)

Chế độ toà nhà xếp mỗi repo vào một tầng. Bấm vào là nhảy sang văn phòng đó. Hàng đợi can thiệp chạy **xuyên** các văn phòng — agent kẹt ở repo bạn không nhìn tới vẫn nổi lên, bấm vào là tự chuyển tab và pan camera tới đúng chỗ.

### Cấu hình, và ngôn ngữ

![Cấu hình — kết nối daemon, các CLI agent, và chọn ngôn ngữ](docs/media/readme/settings.png)

Giao diện **mặc định tiếng Anh, có tiếng Việt** — nó theo ngôn ngữ ưu tiên của trình duyệt và nhớ lựa chọn của bạn.

## Kiến trúc

```
NGUỒN DATA (chỉ đọc, không xâm lấn)
  ~/.claude/projects/**/*.jsonl             transcript Claude Code (gốc + sub-agent)
  ~/.codex/sessions/**/rollout-*.jsonl      Codex CLI
  ~/.gemini/tmp/**                          Gemini CLI
  ~/.claude/agent-office-hook-events.jsonl  hook (tuỳ chọn, để có tín hiệu tức thì)
        │ tail + chuẩn hoá về một luồng sự kiện
        ▼
  packages/daemon (Node thuần; dependency duy nhất là `ws`)
        │ WebSocket + HTTP ở localhost:8787
        ▼
  packages/renderer (văn phòng isometric bằng three.js + giao diện)
```

Giao thức sự kiện nằm ở `packages/protocol`. Daemon là bên ghi duy nhất, renderer chỉ đọc — nên thêm một harness mới là viết adapter, không phải viết lại.

## Hiện đã làm được

**Thấy agent đang làm gì** — tail **Claude Code, Codex CLI và Gemini CLI**, gộp về một luồng. Sub-agent có nhân vật riêng. Nhiều repo thành nhiều tab.

**Xử lý được từ trong office** — hàng đợi liệt kê agent đang kẹt / đang chờ / lỗi và pan camera tới; thông báo hệ điều hành khi có agent kẹt; yêu cầu duyệt quyền làm nhân vật giơ ❗ và duyệt được ngay trong office hoặc qua Telegram; PM riêng cho từng repo để chat (bằng giọng nói cũng được); bảng chi phí gộp cả ba harness.

**Vận hành agent như một đội** — `templates/` chứa các setup "công ty đóng hộp": sơ đồ nhân sự agent kèm mục tiêu, xem được, áp được, lưu lại được.

## Trạng thái

Một công cụ chạy được, tác giả dùng hằng ngày, nhưng vẫn là dự án cá nhân chứ chưa phải sản phẩm. Giới hạn đã biết:

- **Chỉ localhost, không có xác thực** — đọc [SECURITY.md](SECURITY.md) trước khi expose cổng đi đâu.
- Chi phí quy ra USD chỉ đầy đủ với model có giá công bố; model khác đếm token nhưng không quy tiền, thay vì đoán bừa.
- Animation dừng khi tab bị ẩn (trình duyệt tắt `requestAnimationFrame`); trạng thái vẫn đúng, nhân vật đuổi kịp khi tab hiện lại.
- `waiting_permission` tức thì nếu bật hook tuỳ chọn; không có hook thì suy từ transcript, chậm vài giây.
- Giọng đọc reply của PM cần một virtualenv cục bộ; không có thì tính năng đơn giản là tắt.

Bộ test: 560 test trong 55 file, CI chạy trên Node 20 và 22.

## Lộ trình

1. **Aquarium** — nhìn thụ động các phiên của chính mình. ✅
2. **Mission Control** — bấm vào nhân vật, biết ai đang kẹt, nhảy tới chỗ cần mình. ✅
3. **Open protocol** — mỗi harness một adapter sau cùng một schema. ✅ (Claude Code, Codex, Gemini)

Tiếp theo: tài liệu giao thức công khai để người khác thêm harness mà không phải đọc source của daemon.

## Cấu trúc repo

- `packages/daemon/` — đường ống data: tail transcript + hook → luồng sự kiện
- `packages/renderer/` — renderer isometric bằng three.js + giao diện
- `packages/protocol/` — giao thức sự kiện (JSON schema)
- `templates/` — sơ đồ nhân sự agent kiểu "công ty đóng hộp"
- `docs/` — spec, semantic mapping, và một ghi chú trạng thái cho từng tính năng ([mục lục](docs/README.md))
- `assets/` — art, nguồn và giấy phép ghi ở [assets/CREDITS.md](assets/CREDITS.md)

## Đóng góp

Issue luôn được hoan nghênh, kể cả kiểu "chạy trên máy tôi không được". Phản hồi theo khả năng — đây là dự án làm lúc rảnh. Muốn làm gì lớn thì mở issue trước đã. Xem [CONTRIBUTING.md](CONTRIBUTING.md).

## Giấy phép

MIT — xem [LICENSE](LICENSE). Art bên thứ ba là CC0; ghi công từng asset ở [assets/CREDITS.md](assets/CREDITS.md).
