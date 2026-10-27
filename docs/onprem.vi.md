# Chạy Agent Office trên máy của bạn

Agent Office chạy hoàn toàn trên một máy do bạn quản lý. Không có dịch vụ đám mây nào
để đăng ký: một tiến trình nền nhỏ (*daemon*) đọc transcript mà các agent lập trình
ghi ra trên máy đó và phục vụ "văn phòng" cho trình duyệt. Trang này là toàn bộ đường
đi cho người bắt đầu từ con số không: cần chuẩn bị gì, cài thế nào, cho người khác
trong mạng nội bộ vào một cách an toàn, sao lưu, cập nhật và gỡ cài đặt.

Bản tiếng Anh: [onprem.md](onprem.md).

## 1. Cần chuẩn bị gì

| | Yêu cầu |
|---|---|
| **Hệ điều hành** | macOS 13+, Ubuntu 22.04+ (hoặc Linux họ Debian có systemd), hoặc Windows 11. Windows 10 nhiều khả năng chạy được nhưng chưa kiểm tra. |
| **RAM / ổ đĩa** | Khuyến nghị 8 GB RAM (4 GB là mức tối thiểu thực tế khi chạy một-hai agent). Khoảng 1 GB ổ đĩa cho cài đặt và build. |
| **Node.js** | 20 trở lên (khuyến nghị 22 LTS). |
| **git** | Cần để cài và để chạy `update`. |
| **Một agent CLI đã đăng nhập** | Tối thiểu **Claude Code**, với tài khoản dùng được nó (gói Claude Pro/Max/Team, hoặc khoá API của Anthropic). Codex CLI và Gemini CLI là phần thêm, không bắt buộc. |
| **Trình duyệt** | Chrome, Edge, Firefox hoặc Safari bản hiện hành. |
| **Mạng** | Ra ngoài qua HTTPS tới nhà cung cấp agent (CLI cần, không phải Agent Office). Không cần mở cổng vào nào, trừ khi bạn mở văn phòng cho mạng nội bộ (mục 4) — khi đó chỉ một cổng TCP, mặc định `8787`. |

Bản thân Agent Office không gửi gì cho ai. Thứ duy nhất rời khỏi máy là những gì các
agent CLI tự gửi cho nhà cung cấp của chúng, và cầu nối Telegram/Zalo (tuỳ chọn) nếu
bạn cấu hình.

Không chắc đã đủ chưa? Cứ cài, rồi chạy bộ kiểm tra (mục 2): nó nói rõ thiếu gì và
gõ lệnh nào để sửa.

## 2. Cài đặt

Lấy mã nguồn (thư mục nào bạn sở hữu cũng được):

```bash
git clone https://github.com/h3nryprod01/agent-office
cd agent-office
```

Rồi chạy script khởi động cho hệ điều hành của bạn. Mỗi script cài thư viện, build
ứng dụng, cài daemon thành dịch vụ nền (tự chạy khi bạn đăng nhập và tự khởi động lại
nếu sập), rồi mở văn phòng.

| Hệ điều hành | Lệnh |
|---|---|
| macOS | `./scripts/start.sh` |
| Ubuntu / Debian | `./scripts/install-ubuntu.sh` |
| Windows (PowerShell, trong thư mục repo) | `powershell -ExecutionPolicy Bypass -File scripts\start.ps1` |

Trước khi cài bất cứ gì, script kiểm tra những điều cơ bản (phiên bản Node, `npm`,
cổng, thư mục dữ liệu có ghi được không) và dừng lại kèm cách sửa nếu có thứ làm
hỏng quá trình khởi động.

Văn phòng nằm ở **http://localhost:8787**. Dùng `localhost`, đừng gõ `127.0.0.1`:
trình duyệt coi hai địa chỉ này là hai trang khác nhau và hỏi quyền micro riêng.

### Bộ kiểm tra sẵn sàng

Lúc nào cũng chạy được, trên cả ba hệ điều hành:

```bash
./scripts/start.sh doctor                                      # macOS
./scripts/install-ubuntu.sh doctor                             # Linux
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 doctor   # Windows
```

(hoặc `node scripts/ao.mjs doctor` ở đâu cũng được). Mỗi kiểm tra một dòng, và dưới
mỗi vấn đề là lệnh để sửa:

```text
[ok]   Node.js 22.1.0
[FAIL] Claude Code not found on PATH — the PM chat and approvals need it
        fix: npm install -g @anthropic-ai/claude-code   then run `claude` once and sign in
[FAIL] port 8787 is used by another program
        fix: find it with: lsof -i :8787   — stop it, or run Agent Office on another port: DAEMON_WS_PORT=8788
```

(Thông báo của công cụ hiện bằng tiếng Anh.) Nó kiểm tra: Node 20+, `npm`, `git`,
`claude` / `codex` / `gemini` có trên PATH, cổng còn trống (hoặc đang là của chính
Agent Office), thư mục dữ liệu ghi được, đã cài thư viện và đã build, bộ nhớ, chế độ
LAN có bật và có token chưa, và dịch vụ nền đã cài chưa. Nó chỉ đọc, không đổi gì.
Thêm `--json` để lấy kết quả dạng máy đọc.

### Các lệnh bạn sẽ dùng

Tất cả đều là `node scripts/ao.mjs <lệnh>`, và cũng chạy được dưới dạng
`./scripts/start.sh <lệnh>` (macOS), `./scripts/install-ubuntu.sh <lệnh>` (Linux),
`scripts\start.ps1 <lệnh>` (Windows).

| Lệnh | Việc nó làm |
|---|---|
| `doctor` | Máy đã sẵn sàng chưa? Gõ gì để sửa chỗ chưa được. |
| `update` | Sao lưu dữ liệu, `git pull`, cài lại thư viện, build lại, khởi động lại dịch vụ. `--dry-run` chỉ in các bước, không chạy. |
| `backup [--out THƯ_MỤC]` | Nén dữ liệu thành một file (mục 5). |
| `restore <file>` | Khôi phục từ file sao lưu (mục 5). |
| `lan on` / `lan off` / `lan status` | Cho máy khác vào / quay về chỉ máy này (mục 4). |
| `token add --label <tên> --role <vai trò>` | Tạo link truy cập cho một người. |
| `token list` / `token revoke <id-hoặc-nhãn>` | Xem ai có quyền / cắt quyền một người. |

### Cập nhật

```bash
node scripts/ao.mjs update
```

Nếu bạn đã sửa file trong thư mục cài, nó từ chối chạy (không kéo đè lên thay đổi của
bạn) và chỉ cách cất chúng đi. Nó sao lưu dữ liệu trước, và build bản mới *bên cạnh* bản
cũ, chỉ thay vào khi build thành công. Nếu cài thư viện hoặc build hỏng sau khi kéo mã
mới, nó tự đưa bản trước đó trở lại (`git reset --hard` về đúng commit ban đầu, cài lại
thư viện) và **không** khởi động lại dịch vụ lên bản hỏng; nếu ngay cả bước đó cũng hỏng,
thông báo lỗi liệt kê đúng các lệnh để chạy tay.

### Log và tên dịch vụ

| | macOS | Linux | Windows |
|---|---|---|---|
| Dịch vụ | launchd `com.agentoffice.daemon` | systemd user unit `agent-office-daemon` | Scheduled Task `AgentOfficeDaemon` |
| Log | `~/Library/Logs/agent-office-daemon.log` | `journalctl --user -u agent-office-daemon` | `%LOCALAPPDATA%\agent-office\agent-office-daemon.log` |

Dữ liệu của bạn nằm ở `~/.agent-office` (Windows: `%USERPROFILE%\.agent-office`):
dự án, đầu việc, và danh sách quyền truy cập. Đặt `AGENT_OFFICE_HOME` để chuyển sang
nơi khác.

## 3. Ai được thấy gì: vai trò

| Vai trò | Làm được |
|---|---|
| **owner** | Mọi thứ, kể cả những việc tác động lên màn hình của máy chủ (ví dụ mở một file trong Finder/Explorer). |
| **manager** | Đọc mọi thứ và thay đổi: chat với PM agent, trả lời yêu cầu phê duyệt của agent, tạo dự án và đầu việc, áp dụng mẫu công ty. |
| **viewer** | Chỉ đọc. Xem văn phòng, bảng việc, hoạt động và chi phí. Không chat, không phê duyệt, không tạo hay sửa gì, và không kích hoạt được việc dò đăng nhập agent. |

Ai dùng văn phòng **ngay trên máy đang chạy nó** đều là owner, không cần token, y như
trước. Vai trò chỉ có ý nghĩa với người kết nối qua mạng.

Viewer nhìn thấy agent đang làm gì (lệnh gọi công cụ, tên file, câu lệnh, chi phí).
Chỉ gửi link viewer cho những người được phép xem những thứ đó.

## 4. Cho người khác vào (chế độ LAN)

Mặc định daemon chỉ lắng nghe trên chính máy này. Để đồng nghiệp trong cùng mạng mở
được văn phòng:

```bash
node scripts/ao.mjs lan on
```

Lệnh này chuyển daemon sang lắng nghe trên mạng, tạo link **owner** đầu tiên nếu chưa
có, khởi động lại dịch vụ, và in ra link dạng:

```text
Access link (owner) — shown once, copy it now:
  http://192.0.2.10:8787/?ao_token=ao_...
```

Link chứa một token bí mật. **Nó chỉ hiện một lần**: hệ thống chỉ lưu bản băm, nên nếu
mất link thì phải tạo cái mới.

Mở link đó trong trình duyệt là đăng nhập trình duyệt đó: thanh địa chỉ được dọn sạch
ngay, và một cookie (HttpOnly, SameSite=Strict, 30 ngày) giữ phiên. Công cụ khác có thể
gửi cùng token đó qua `Authorization: Bearer <token>`.

### Cấp quyền cho một người

```bash
node scripts/ao.mjs token add --label "Mai" --role viewer
node scripts/ao.mjs token add --label "An"  --role manager
```

Gửi mỗi người link riêng của họ. Mỗi người một token nghĩa là bạn cắt được một người
mà không ảnh hưởng người khác:

```bash
node scripts/ao.mjs token list
node scripts/ao.mjs token revoke Mai        # không cần khởi động lại; kết nối đang mở bị đóng sau vài giây
```

### Tắt lại

```bash
node scripts/ao.mjs lan off
```

Daemon quay về chỉ máy này. Token được giữ nguyên, nên `lan on` lần sau sẽ cho đúng
những người đó vào lại.

### Daemon bảo đảm những gì

* Yêu cầu đến từ chính máy này (loopback) không cần gì, như trước.
* **Mọi yêu cầu khác, cả HTTP lẫn WebSocket, đều cần token hợp lệ**, nếu không nhận
  `401`. Trình duyệt chưa có token thấy trang yêu cầu link truy cập.
* Yêu cầu ghi của viewer nhận `403`.
* Kiểm tra nguồn gốc (cross-origin) vốn có vẫn chạy trước: trang web của site khác không
  dùng được token của bạn.
* Yêu cầu có header của proxy (`X-Forwarded-For` và tương tự) bị coi là từ xa dù xuất
  phát từ chính máy này, nên tunnel hay reverse proxy chạy cùng máy không vô tình biến
  cả internet thành "nội bộ".
* Token là 256 bit ngẫu nhiên, chỉ lưu dưới dạng SHA-256 trong
  `~/.agent-office/access.json` (quyền file 600).

### Nói thẳng về mạng

Đây là HTTP thường. Trong LAN, token đi qua mạng dưới dạng văn bản rõ, nên ai nghe lén
được mạng đó đều chép được. Chấp nhận được với mạng gia đình/văn phòng bạn tin cậy,
**không** chấp nhận được với Wi-Fi công cộng hay bất cứ thứ gì đi qua internet. Với mọi
thứ ngoài LAN tin cậy, hãy đặt sau VPN như Tailscale, hoặc reverse proxy HTTPS mà bạn
cấu hình để gửi `X-Forwarded-For` (để yêu cầu bị coi là từ xa và cần token) và giữ nguyên
header `Host` gốc (nginx: `proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr;`).
Thiếu cái đầu, mọi yêu cầu qua proxy trông như nội bộ và được coi là owner; thiếu cái sau,
kiểm tra cross-origin sẽ từ chối chính các yêu cầu của ứng dụng. Đừng mở cổng trên router
ra internet.

Hãy coi daemon như một cái shell trên máy đó: owner hoặc manager trả lời được các yêu
cầu phê duyệt của agent đang chạy ở đấy. Đừng bật chế độ LAN trên máy dùng chung nhiều
người.

### Tường lửa

* **macOS**: lần đầu sẽ có hộp thoại hỏi `node` có được nhận kết nối vào không. Chọn Allow.
* **Windows**: cho phép `node.exe` trên mạng **Private** khi có thông báo, hoặc chạy
  một lần trong PowerShell quản trị:
  `New-NetFirewallRule -DisplayName "Agent Office" -Direction Inbound -Program "<đường dẫn đầy đủ tới node.exe>" -Protocol TCP -LocalPort 8787 -Profile Private -Action Allow`
* **Linux (ufw)**: `sudo ufw allow from <dải-mạng-LAN-của-bạn> to any port 8787 proto tcp`

Để biết người khác nên dùng địa chỉ nào, `lan on` in một link cho mỗi địa chỉ mạng của
máy; chọn địa chỉ thuộc mạng chung của bạn.

## 5. Sao lưu và khôi phục

```bash
node scripts/ao.mjs backup                       # vào ~/agent-office-backups/
node scripts/ao.mjs backup --out /đường/dẫn/thư-mục
```

Lệnh tạo `agent-office-backup-<ngày>-<giờ>.tar.gz` chứa toàn bộ thư mục dữ liệu
(`~/.agent-office`: dự án và đầu việc của chúng, `access.json` cùng bản băm token).
Danh sách nhân sự công ty ở `~/.claude/company` nằm ngoài thư mục này nên không có trong đó. File chỉ mình bạn đọc được; hãy giữ kín.
`update` tự sao lưu một bản trước khi đổi bất cứ gì.

Khôi phục:

```bash
node scripts/ao.mjs restore ~/agent-office-backups/agent-office-backup-<ngày>-<giờ>.tar.gz
```

Khôi phục kiểm tra file trước và từ chối mọi thứ không an toàn (đường dẫn trèo ra ngoài
thư mục, liên kết, nhiều hơn một thư mục gốc). Nó **không bao giờ xoá** dữ liệu hiện
tại: dữ liệu đó được chuyển sang `…/.agent-office.pre-restore-<ngày>-<giờ>` ngay cạnh,
nên luôn quay lại được. Sau đó dịch vụ được khởi động lại để nạp dữ liệu vừa khôi phục
(`--no-restart` để bỏ qua; trên Windows, nếu khôi phục lỗi vì file bị khoá thì dừng task
`AgentOfficeDaemon` trước). `access.json` cũng được khôi phục theo, nên lệnh in ra ai đang
có quyền; hãy kiểm tra nếu file sao lưu đến từ người khác.

## 6. Gỡ cài đặt

Trước hết sao lưu những gì bạn muốn giữ (mục 5).

**macOS**

```bash
./scripts/install-daemon-service.sh uninstall
rm -rf ~/Applications/Agent\ Office.app        # chỉ khi bạn đã tạo app
```

**Linux**

```bash
systemctl --user disable --now agent-office-daemon
rm ~/.config/systemd/user/agent-office-daemon.service
rm -f ~/.local/share/applications/agent-office.desktop
rm -rf ~/.config/agent-office                  # chứa file env tuỳ chọn (token Telegram, v.v.)
systemctl --user daemon-reload
```

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-daemon-service.ps1 uninstall
```

Sau đó xoá thư mục repo. Dữ liệu, log và bản sao lưu nằm riêng và chỉ mất khi bạn tự
xoá:

* dữ liệu: `~/.agent-office` (Windows: `%USERPROFILE%\.agent-office`)
* sao lưu: `~/agent-office-backups`
* log: xem bảng ở mục 2

## 7. Khi có sự cố

Chạy `doctor` trước. Nó bao quát phần lớn bảng này.

| Hiện tượng | Nguyên nhân có thể và cách sửa |
|---|---|
| Trang trắng hoặc 404 ở `localhost:8787` | Chưa build ứng dụng. Chạy script khởi động. |
| "Disconnected" trong văn phòng | Daemon đang tắt. Xem log (mục 2), rồi chạy script khởi động. |
| Đồng nghiệp thấy "Access link required" | Họ cần link từ `token add`. Token chỉ hiện một lần; mất thì tạo cái mới. |
| Đồng nghiệp bị hỏi lại link sau một thời gian | Cookie bị xoá, hoặc token đã bị thu hồi (`token list`). |
| Đồng nghiệp hoàn toàn không vào được địa chỉ | Chế độ LAN đang tắt (`lan status`), tường lửa chặn cổng (mục 4), hoặc họ ở mạng khác. |
| `update` báo "local changes" | Bạn đã sửa file trong thư mục cài. `git stash` chúng rồi chạy lại `update`. |
| Cổng 8787 đã bị dùng | `doctor` chỉ ra ai đang giữ. Tắt chương trình đó, hoặc chạy cổng khác bằng `DAEMON_WS_PORT`. Các hook tuỳ chọn trong settings Claude Code của bạn chạy trong shell của bạn chứ không trong service: đưa cổng cho chúng nữa, ví dụ `AGENT_OFFICE_PORT=8788 node …/approve-gateway.mjs`. |
| `claude` đã cài nhưng văn phòng báo không có | Dịch vụ có PATH nhỏ hơn terminal của bạn. Cài lại dịch vụ từ terminal chạy được `claude`: macOS `./scripts/install-daemon-service.sh`, Linux `./scripts/install-daemon-service-linux.sh`, Windows `scripts\install-daemon-service.ps1`. |

## Đã kiểm tra và chưa kiểm tra

* **macOS và Linux**: các lệnh trong trang này đã được chạy, gồm `doctor`,
  `backup`/`restore`, `update` trên một bản clone tạm, và luồng token LAN với yêu cầu
  thật từ địa chỉ không phải loopback.
* **Windows**: daemon và Scheduled Task đã được kiểm chứng trên máy ảo Windows 11 (xem
  [windows-port.md](windows-port.md)). Một điều cần xác nhận trên máy thật: task chạy
  `cmd.exe /c node …`, nên `lan on|off` / `update` dừng task rồi chủ động tắt mọi
  `node.exe` còn sót đang chạy script daemon trước khi chạy lại; hãy kiểm tra bằng
  `Get-Process node` rằng sau đó chỉ có đúng một daemon. `start.ps1` và các lệnh mới đã parse không lỗi và
  chạy thử (dry-run) dưới PowerShell 7 trên macOS. **Chưa chạy trên máy Windows thật**:
  `start.ps1` đăng ký và khởi động task từ đầu đến cuối, `update` khởi động lại qua
  Scheduled Task, `backup`/`restore` với `tar.exe` có sẵn của Windows, hộp thoại tường
  lửa ở chế độ LAN, và đăng nhập Claude Code thật. Trên Windows, hãy coi lần chạy đầu
  tiên là bài kiểm tra và báo lại chỗ nào hỏng.
