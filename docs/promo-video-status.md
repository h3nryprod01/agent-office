# Promo video Agent Office — status (wi-video-agent-office)

> **Ghi chú bản public:** video promo và footage gốc (`docs/media/promo/`,
> `videos/agent-office-promo/`) không nằm trong repo để giữ kích thước clone nhỏ.
> Xem bản render ở phần Releases. Phần còn lại của tài liệu này giữ nguyên để
> ghi lại quá trình dựng.


_Media Producer session, 2026-07-08. Branch `media/promo-video`._

## Deliverable

- `docs/media/promo/agent-office-promo-16x9.mp4` — 30–45s, 1920×1080, tiếng Anh, phụ đề luôn bật (karaoke captions), voiceover Kokoro local (af_heart), KHÔNG nhạc nền (build offline, tránh nhạc bản quyền — xem "Render lại").
- `docs/media/promo/agent-office-promo-thumb.png` — thumbnail.
- Nguồn dựng: `videos/agent-office-promo/` (HyperFrames project — storyboard, script, 7 frame HTML, footage gốc trong `capture/assets/`).

## Cấu trúc video (38–40s)

| # | Cảnh | Footage | VO |
|---|------|---------|----|
| 1 | Hook: wall of logs (typography) | — | "Ten AI agents… all you get to see is a wall of logs." |
| 2 | Reveal office 34 nhân vật | `hook-stress30.mp4` (demo `?mock=1&stress=30`) | "This is Agent Office…" |
| 3 | Side panel + transcript thật | `sidepanel.mp4` (live) | "Click anyone…" |
| 4 | Intervention queue xuyên office | `queue-pan.mp4` (live) | "When someone gets stuck…" |
| 5 | Chat PM — PM thật trả lời | `chat-type.mp4` + `chat-reply.mp4` (live) | "Ask the PM…" |
| 6 | Time-lapse 60× | `timelapse.mp4` (live) | "Replay your whole day…" |
| 7 | Tagline + wordmark | `live-wide.png` dim | "Your AI agents. Your company. One screen." |

## Footage — quay thế nào (dogfood)

Toàn bộ footage là **screen recording sản phẩm thật** (renderer Vite port 5199 + daemon launchd thật, các session Claude/Codex đang chạy trên máy), quay bằng **headless Chrome raw CDP screencast** (không puppeteer — theo note vault "Headless Chrome screenshot qua raw CDP"):

- Script: `videos/agent-office-promo/capture/record.mjs` (scene chính) + luồng chat quay riêng sau khi fix daemon.
- Cơ chế: `Page.startScreencast` (jpeg q90 1920×1080) → frames + timestamp → ffconcat → ffmpeg CFR 30fps (`flags=neighbor` giữ pixel-art nét).
- Tương tác script hoá: click queue item (`#queue-panel [data-agent-id]` → focusAgent pan + side panel), đổi tab office, gõ chatbox (`#chat-box input` + native value setter + Enter), bật 60× + kéo scrubber (`.rp-speed[data-speed="60"]`, `#rp-scrub`).
- Cảnh reveal dùng scenario demo của chính sản phẩm (`?mock=1&stress=30`, 34 nhân vật); 5 cảnh còn lại là live data thật.

## Bug thật tìm thấy khi dogfood (đã hotfix)

**POST /chat → "spawn claude ENOENT"**: daemon launchd không có PATH tới claude CLI. Daemon vốn hỗ trợ `CHAT_CLAUDE_BIN` (index.js) nhưng plist không set. Hotfix: vá `~/Library/LaunchAgents/com.agentoffice.daemon.plist` thêm `EnvironmentVariables.CHAT_CLAUDE_BIN=/Users/you/.local/bin/claude` + bootout/bootstrap lại service. ⚠️ Chạy lại `scripts/install-daemon-service.sh` sẽ mất fix — đã spawn task chip sửa script (probe `command -v claude`, cùng pattern fix terminal-notifier #23).

## Render lại video

```bash
cd videos/agent-office-promo
# TTS local (Kokoro) cần venv python có kokoro-onnx + soundfile, và espeak-ng data từ brew:
#   python3 -m venv <venv> && <venv>/bin/pip install kokoro-onnx soundfile && brew install espeak-ng
export HYPERFRAMES_PYTHON=<venv>/bin/python
export ESPEAK_DATA_PATH=/opt/homebrew/share/espeak-ng-data
SKILL=~/.claude/skills/product-launch-video/scripts
node $SKILL/audio.mjs --script ./SCRIPT.md --storyboard ./STORYBOARD.md --hyperframes . --out ./audio_meta.json
node $SKILL/audio.mjs sync-durations --audio-meta ./audio_meta.json --storyboard ./STORYBOARD.md
node $SKILL/captions.mjs build --storyboard ./STORYBOARD.md --audio-meta ./audio_meta.json --hyperframes . --out ./caption_groups.json
node $SKILL/assemble-index.mjs --storyboard ./STORYBOARD.md --hyperframes .
node $SKILL/transitions.mjs inject --storyboard ./STORYBOARD.md --hyperframes .
npx hyperframes render --skill=product-launch-video --quality high --output renders/video.mp4
```

HeyGen chưa đăng nhập trên máy này → BGM bị skip (im lặng có chủ đích). Muốn có nhạc: `npx hyperframes auth login` rồi thêm mood vào `music:` trong STORYBOARD.md và chạy lại audio.mjs.

## Đã skip / nợ

- Bản 9:16: chưa cắt (frame overlay đặt theo layout 16:9; cắt dọc cần re-layout, làm khi có đích TikTok/Shorts cụ thể).
- BGM: im lặng (offline). Thêm khi có HeyGen auth.
- SFX: chỉ 1 cue trong thư viện bundle khớp; phần còn lại skip.
