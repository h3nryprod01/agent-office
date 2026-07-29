# Company Hire + Roster — status (wi-company-hire-roster)

_2026-07-08 — Skill Builder 2. Hai meta-skill user-level cho "công ty đa agent" + dogfood tuyển thật._

## Đã ship

### 1. Skill `company-roster` (`~/.claude/skills/company-roster/SKILL.md`)

Quản lý sơ đồ nhân sự tại `~/.claude/company/roster.yaml`:

- **Schema**: 5 phòng (dev/media/marketing/research/ops) → members (name, source, hired, role 1 dòng, cv nếu tuyển ngoài), `model_routing` gợi ý per phòng (opus/sonnet/haiku theo loại việc), `budget_usd_per_day`, `repos` (map `byRepo` của `GET http://127.0.0.1:8787/costs` về phòng).
- **Actions**: xem bảng (tổng quan 1 dòng/phòng, chi tiết khi hỏi 1 phòng) / thêm-gỡ thành viên (verify tồn tại thật trước khi thêm; gỡ khỏi roster KHÔNG xóa đĩa) / kiểm tra budget (đối chiếu chi thật 24h, cảnh báo vượt trần; daemon tắt → degrade, chỉ hiện trần).
- **Bootstrap từ đồ thật**: roster đầu tiên quét `~/.claude/skills/` + `~/.claude/agents/` + plugin skills, CHỌN LỌC 5-7 thành viên/phòng (dev: forge, tdd-workflow, systematic-debugging, code/security-reviewer, build-error-resolver; media: hyperframes×2, demo-app-video, fal-ai-media, video-editing, video-optimization-specialist; marketing: content-engine, crosspost, competitive-ads-extractor, marketing:seo-audit, marketing:campaign-plan, content-creator; research: deep-research, exa-search, market-research, trend-researcher, lead-research-assistant; ops: small-business×2, finance:reconciliation, invoice-organizer, file-organizer, schedule).
- **company-pm đã được vá tối thiểu** (1 đoạn trong Bước 3): tham khảo roster khi giao việc (phòng/skill/model/budget), gap → company-hire.

### 2. Skill `company-hire` (`~/.claude/skills/company-hire/SKILL.md`)

Quy trình tuyển 5 bước: xác định gap (check roster + skill sẵn có, không tuyển trùng) → săn ứng viên GH (`gh search repos/code`, ưu tiên anthropics/skills, VoltAgent/awesome-claude-code-subagents, ComposioHQ/awesome-claude-skills) → **skillspector-scan BẮT BUỘC** (fetch về temp, KHÔNG cài thẳng; REVIEW/DO_NOT_INSTALL hoặc scanner lỗi/thiếu = DỪNG báo user, không bao giờ cài bừa, không tự chế bước scan thay thế) → cài vào `~/.claude/skills/` → đăng ký roster kèm CV (nguồn, ngày, scan_verdict, scan_score). Degrade: gh chưa auth → nhận URL trực tiếp nhưng vẫn phải scan; không có ứng viên đạt → báo "chưa tuyển được", không hạ chuẩn.

## Dogfood thật — tuyển `youtube-seo`

Gap thật: phòng marketing/media thiếu skill SEO YouTube (agent video-optimization-specialist chỉ tư vấn chiến lược). Chạy full flow:

| Bước | Kết quả thật |
|---|---|
| Search | 3 nguồn ưu tiên không có; `gh search code --filename SKILL.md` ra 3 ứng viên |
| Đánh giá | Chọn kostja94/marketing-skills `skills/platforms/youtube` (713★, push 2026-06, pure markdown, phủ title/description/tags/thumbnail). Loại SamurAIGPT muapi-youtube-thumbnail (3.7k★ nhưng khóa API muapi.ai trả phí — đã có fal-ai-media); loại mediar-ai/skillhubz (8★) |
| Scan | SkillSpector v2.3.1: `VERDICT recommendation=SAFE severity=LOW score=0 issues=0` (exit 0) |
| Cài | `~/.claude/skills/youtube-seo/` — hệ thống đã nhận skill (xuất hiện trong available skills) |
| Đăng ký | Roster marketing, CV: `{scan_verdict: SAFE, scan_score: 0, scanned: 2026-07-08}` |

## Verify

- **Roster render + budget**: bảng in đúng 5 phòng/30 thành viên từ yaml thật; budget đối chiếu `/costs` thật: dev chi $775.58 / trần $500 → `⚠ VƯỢT 55%` (cảnh báo hoạt động); media $6.80/$100 ok; phòng chưa map repo in `n/a` không bịa số.
- **company-board vẫn chạy**: Plane ON, registry đọc được, 0 PR mở, worktree `promo` khớp wi-video-agent-office, main == origin/main, outbox 0 dòng.
- **Hire flow end-to-end** có verdict scan thật (bảng trên).

## Ghi chú cho PM

- Trần budget (500/100/50/50/30 USD/ngày) là số khởi điểm tôi đặt — user nên duyệt lại. Dev đang vượt trần ngay hôm nay (demo-app $621 chiếm phần lớn).
- Phòng marketing/research/ops chưa map repo nào vào `/costs` (`repos: []`) — muốn theo dõi chi thật cần quy ước repo hoặc mở rộng daemon attribution.
- `wi-hiring-hall` (backlog) giờ đã có backend: roster.yaml + CV là data nguồn cho khu tuyển dụng trong office UI.
