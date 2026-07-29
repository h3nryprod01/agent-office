/** Bản tiếng Việt — bản gốc của mọi chuỗi trong giao diện. */
export const vi: Record<string, string> = {
  // ── điều hướng ───────────────────────────────────────────────────────────
  "nav.office": "Văn phòng",
  "nav.board": "Bảng việc",
  "nav.log": "Nhật ký",
  "nav.costs": "Chi phí",
  "nav.settings": "Cấu hình",

  // ── trạng thái agent ─────────────────────────────────────────────────────
  "status.working": "Đang làm việc",
  "status.reading": "Đang đọc tài liệu",
  "status.running_command": "Đang chạy lệnh",
  "status.waiting_permission": "Chờ bạn duyệt",
  "status.blocked": "Đang kẹt",
  "status.error": "Gặp lỗi",
  "status.idle": "Đang rảnh",
  "status.done": "Đã xong",

  // ── khu vực trong văn phòng ──────────────────────────────────────────────
  "station.pmDesk": "Bàn PM/CEO",
  "station.cabinet": "Tủ hồ sơ",
  "station.bookshelf": "Kệ sách (đọc file)",
  "station.arcade": "Máy arcade (chạy lệnh)",
  "station.meeting": "Bàn họp (giao việc)",

  // ── điều khiển văn phòng ─────────────────────────────────────────────────
  "office.center": "⌖ Giữa",
  "office.centerTitle": "Đưa văn phòng về giữa khung nhìn",
  "office.lightsOn": "☀️ Bật đèn",
  "office.lightsOff": "🌙 Tắt đèn",
  "office.lightsOnTitle": "Bật đèn văn phòng",
  "office.lightsOffTitle": "Tắt đèn — chỉ còn màn hình và đèn neon",
  "office.toDesks": "🏢 Về bàn",
  "office.huddle": "👥 Họp nhanh",
  "office.toDesksTitle": "Cho mọi người về bàn làm việc",
  "office.huddleTitle": "Gọi cả team ra bàn họp",
  "office.soundTitle": "Bật/tắt âm thanh môi trường (clack / ting / buzz)",
  "office.connecting": "live: đang kết nối {url}…",
  "office.offline": "⚠ daemon offline — đang kết nối lại…",
  "office.openFailed": "⚠ Mở thất bại: {error}",

  // ── bảng tường ───────────────────────────────────────────────────────────
  "wall.daemonOffline": "daemon ngoại tuyến",
  "wall.queued": "Chờ làm",
  "wall.inProgress": "Đang làm",
  "wall.productivity": "NĂNG SUẤT",
  "wall.last24h": "24 giờ qua",
  "wall.empty": "— trống —",

  // ── không có WebGL ───────────────────────────────────────────────────────
  "webgl.title": "Không bật được đồ hoạ 3D",
  "webgl.body": "Máy này không dùng được WebGL, nên khung Văn phòng 3D không hiển thị.",
  "webgl.stillWorks":
    "Mọi thứ khác vẫn chạy bình thường: <b>Bảng việc</b>, <b>Nhật ký</b>, <b>Chi phí</b>, <b>Cấu hình</b> — bấm ở thanh bên trái.",
  "webgl.hint":
    "Thường do card đồ hoạ/driver cũ, hoặc đang chạy qua remote desktop / máy ảo không có tăng tốc phần cứng.",

  // ── bảng bên (side panel) ────────────────────────────────────────────────
  "panel.copied": "đã copy",
  "panel.copyManually": "copy tay dòng trên",
  "panel.agentGone": "Agent đã biến mất",
  "panel.resumeInClaude": "Tiếp tục trong Claude",
  "panel.resumeCopyTitle": "Copy lệnh resume phiên PM này",
  "panel.status": "Trạng thái",
  "panel.detail": "Chi tiết",
  "panel.doing": "Đang làm",
  "panel.cwd": "Thư mục làm việc",
  "panel.session": "Phiên",
  "panel.reportsTo": "Nhân sự",
  "panel.topLevel": " · cấp cao nhất",
  "panel.close": "Đóng",
  "panel.noActivity": "Chưa có hoạt động.",
  "panel.transcriptLiveOnly": "Transcript chỉ có ở live mode (?ws=1).",
  "panel.loading": "Đang tải…",
  "panel.noMessages": "Chưa có message nào trong buffer.",
  "panel.showMore": "Xem thêm ({n})",

  // ── chat với PM ──────────────────────────────────────────────────────────
  "chat.youPrefix": "bạn › ",
  "chat.toggleTitle": "Ẩn/hiện khung chat",
  "chat.stopTitle":
    "Dừng turn PM đang chạy. CHỈ dừng được PM chat này — các session Claude khác của bạn phải dừng ở app gốc.",
  "chat.placeholder": "Nhắn cho PM… (Enter để gửi)",
  "chat.placeholderRepo": "Nhắn cho PM · {repo}… (Enter để gửi)",
  "chat.ttsTitle": "PM đọc to reply (giọng Đoan) — bấm để bật/tắt",
  "chat.resumeTitle":
    "Tiếp tục phiên PM này trong Claude Code — copy lệnh 'claude --resume' của repo đang mở",
  "chat.hint":
    "Chatbox nói chuyện với PM của repo trong tab đang mở (tab All = repo mặc định). Muốn phê duyệt tool cho một session đang chờ permission, phải làm trong app Claude Code gốc của session đó.",
  "chat.sendFailed": "Gửi thất bại (HTTP {status})",
  "chat.noDaemon": "Không kết nối được daemon ({url}) — daemon có đang chạy không?",
  "chat.stopFailed": "Không kết nối được daemon để dừng turn.",
  "chat.noSession": "Chưa có phiên PM cho repo này — nhắn PM một câu trước đã.",
  "chat.copiedCmd": "đã copy 🔗 {cmd}",
  "chat.copyManually": "copy tay lệnh này: {cmd}",
  "chat.daemonUnreachable": "Không kết nối được daemon ({url}).",

  // ── nhật ký hoạt động ────────────────────────────────────────────────────
  "activity.runningTests": "Đang chạy kiểm thử",
  "activity.git": "Thao tác mã nguồn (git)",
  "activity.deleteFile": "Xoá tệp",
  "activity.moveFile": "Sao chép/di chuyển tệp",
  "activity.build": "Đóng gói bản chạy",
  "activity.shell": "Chạy lệnh hệ thống",
  "activity.readingNamed": "Đọc: {name}",
  "activity.reading": "Đọc & tra tài liệu",
  "activity.editingNamed": "Sửa: {name}",
  "activity.editing": "Soạn/sửa nội dung",
  "activity.web": "Tra cứu trên web",
  "activity.working": "Đang xử lý",
  "activity.liveOnly": "Nhật ký chỉ có ở live mode.",
  "activity.empty": "Chưa có hoạt động nào.",
  "activity.business": "Kinh doanh",
  "activity.technical": "Kỹ thuật",

  // ── bảng việc (kanban) ───────────────────────────────────────────────────
  "kanban.ideas": "Ý tưởng",
  "kanban.queued": "Chờ xử lý",
  "kanban.inProgress": "Đang làm",
  "kanban.review": "Chờ duyệt",
  "kanban.liveOnly": "Bảng việc chỉ có ở live mode.",
  "kanban.more": "… {n} thẻ nữa",
  "kanban.inputPlaceholder": "+ ghi nhanh một ý tưởng…",
  "kanban.myIdeas": "Ý tưởng của tôi",
  "kanban.agentWork": "Việc của agent",
  "kanban.noIdeas": "Chưa có ý tưởng nào",
  "kanban.noIdeasHint":
    "Gõ ý tưởng đầu tiên vào ô bên dưới rồi Enter — PM sẽ nhặt việc từ đây.",
  "kanban.agentNoWork": "Agent chưa có việc nào",
  "kanban.agentNoWorkHint":
    "Sang tab “Ý tưởng của tôi”, ghi một ý rồi bấm “Giao cho PM”.",
  "kanban.askPm": 'Nhờ PM xử lý ý tưởng: "{title}"',

  // ── chi phí ──────────────────────────────────────────────────────────────
  "costs.overBudget":
    "⚠ Vượt ngân sách: {spent} / {budget}. Yêu cầu cần duyệt sẽ chờ bạn duyệt vượt.",
  "costs.byDay": "Theo ngày",
  "costs.liveOnly": "Chi phí chỉ có ở live mode.",
  "costs.chipWithTotal": "{warn}Chi phí · {total}",
  "costs.chip": "Chi phí",

  // ── cấu hình ─────────────────────────────────────────────────────────────
  "settings.title": "Cấu hình",
  "settings.connection": "Kết nối",
  "settings.agentSources": "Nguồn agent",
  "settings.about": "Về",
  "settings.mockMode": "● Chế độ demo (mock) — không nối daemon",
  "settings.connected": "● Đã kết nối",
  "settings.disconnected": "● Mất kết nối — daemon ({url}) có đang chạy?",
  "settings.installed": "Đã cài",
  "settings.notInstalled": "Chưa cài",
  "settings.loggedIn": "Đã đăng nhập",
  "settings.notLoggedIn": "Chưa đăng nhập",
  "settings.notChecked": "Chưa kiểm tra",
  "settings.check": "Kiểm tra",
  "settings.checking": "Đang kiểm tra…",
  "settings.checkFailed": "Lỗi — thử lại",
  "settings.sourcesLiveOnly": "Nguồn agent chỉ hiện ở chế độ live (cần daemon).",
  "settings.sourcesHint":
    'Các CLI agent mà văn phòng nhìn thấy. "Kiểm tra" xác nhận đăng nhập.',
  "settings.aboutText":
    'Agent Office — văn phòng trực quan cho công ty một-người vận hành bằng AI agent. "Công ty đóng hộp" cho từng loại việc.',
  "settings.language": "Ngôn ngữ",
  "settings.languageHint": "Đổi ngôn ngữ sẽ tải lại trang.",

  // ── template công ty ─────────────────────────────────────────────────────
  "templates.button": "🏢 Công ty đóng hộp",
  "templates.note": "Mỗi template là một công ty đa agent đóng gói sẵn (sơ đồ phòng ban + mục tiêu). <b>Áp dụng sẽ ghi đè roster thật</b> của máy này — roster cũ luôn được backup trước.",
  "templates.loading": "Đang tải…",
  "templates.hasGoals": "có goals.md",
  "templates.noGoals": "chưa có goals.md",
  "templates.meta": "{depts} phòng · {members} thành viên · {goals}",
  "templates.missingSkills":
    "⚠ Thiếu {n} skill: {list} — chạy skill company-hire để tuyển (bắt buộc scan an toàn).",
  "templates.confirmOverwrite": "⚠ Bấm lần nữa để GHI ĐÈ roster",
  "templates.apply": "Áp dụng",
  "templates.applyWarning":
    'Áp dụng "{name}" sẽ ghi đè {path}. Roster hiện tại được backup trước → {path}.<timestamp>.bak',
  "templates.backedUp": "✅ Đã backup roster cũ → {path}",
  "templates.createdFresh": "✅ Đã tạo roster mới (máy này chưa có roster cũ để backup).",
  "templates.allSkillsPresent": "✅ Tất cả skill của template đã cài trên máy này.",
  "templates.close": "Đóng",
  "templates.empty": "Chưa có template nào trong templates/.",
  "templates.applied": 'Đã áp dụng "{name}"',
  "templates.goalsHeading": "Mục tiêu (goals.md) — giao cho company-pm",
  "templates.noDaemon": "Không kết nối được daemon ({url}).",
  "templates.applying": 'Đang áp dụng "{name}"…',
  "templates.applyFailed": "⚠ Áp dụng thất bại: {error}",

  // ── quầy tuyển dụng ──────────────────────────────────────────────────────
  "hiring.prompt":
    "Dùng skill company-hire: tuyển {gap}. Báo cáo verdict scan + kết quả vào chat.",
  "hiring.noRoster":
    "Chưa có roster — tuyển người đầu tiên bằng form dưới, hoặc chạy skill company-roster để bootstrap.",
  "hiring.budgetCap": "trần ${amount}/ngày",
  "hiring.emptyDept": "phòng trống",
  "hiring.rosterUpdated": "Cập nhật roster: {when} · {total} thành viên",
  "hiring.close": "Đóng",
  "hiring.gapPlaceholder": "Mô tả gap — vd: cần thumbnail designer cho phòng media",
  "hiring.liveOnly": "Roster chỉ có ở live mode (cần daemon {url}).",
  "hiring.unreadable": "Không đọc được roster — daemon có đang chạy không?",
  "hiring.inProgress":
    "⏳ PM đang tuyển… (company-hire: săn ứng viên → scan → cài). Chi tiết ở chatbox.",
  "hiring.noDaemon": "⚠ Không kết nối được daemon ({url}) — daemon có đang chạy không?",
  "hiring.joined": "🎉 {names} đã vào roster.",
  "hiring.turnDone":
    "✅ PM xong turn — xem kết quả ở chatbox. Người mới (nếu tuyển được) sẽ tự vào roster.",
  "hiring.turnFailed": "PM turn lỗi",

  // ── thanh thời gian / replay ─────────────────────────────────────────────
  "timeline.backToLive": "Quay về hiện tại",
  "timeline.exportTitle": "Export phiên ra JSON",
  "timeline.importTitle": "Import file replay JSON (hoặc kéo-thả vào trang)",
  "timeline.noEvents": "Chưa có event nào để replay",
  "timeline.nothingToExport": "Chưa có event nào để export",
  "timeline.exported": "Đã export {n} event",
  "timeline.noRecording": "Trình duyệt không hỗ trợ quay video",
  "timeline.timelapseSaved": "Đã tải timelapse",
  "timeline.recording": "Đang quay — bật replay 60× rồi quay để có timelapse",
  "timeline.emptyFile": "File replay rỗng",
  "timeline.loaded": "Đã nạp {n} event — kéo timeline hoặc bấm ▶",
  "timeline.unreadableFile": "Không đọc được file",
  "timeline.notJson": "File không phải JSON hợp lệ",
  "timeline.notReplayFile": "Không phải file replay Agent Office",

  // ── giọng nói ────────────────────────────────────────────────────────────
  "voice.tableSummary": "bảng {rows} dòng",
  "voice.ttsGlitch": "🗣️ Giọng đọc (VieNeu) tạm lỗi ở câu này — thử lại hoặc tải lại trang.",
  "voice.micBlocked": "Mic bị chặn — cấp quyền microphone cho trang này rồi thử lại.",
  "voice.networkError":
    "Nhận giọng nói lỗi mạng — Web Speech của Chrome cần gọi server Google; kiểm tra VPN/tường lửa.",
  "voice.error": "Nhận giọng nói lỗi: {code}",
  "voice.unsupported": "Trình duyệt không hỗ trợ Web Speech API — thử Chrome/Edge",
  "voice.micTitle": "Bấm để nói (hoặc giữ Space khi không gõ) — thả ra là gửi, Esc để hủy",
  "voice.ttsUnsupported": "Trình duyệt không hỗ trợ speechSynthesis",
  "voice.ttsOn": "Đang đọc to reply của PM — bấm để tắt",
  "voice.ttsOff": "Bấm để PM đọc to reply (mặc định tắt)",

  // ── tủ hồ sơ ─────────────────────────────────────────────────────────────
  "outputs.empty": "Chưa có output nào trong docs/media/.",
  "outputs.title": "Tủ hồ sơ",
  "outputs.close": "Đóng",
  "outputs.liveOnly": "Tủ hồ sơ chỉ hoạt động ở live mode (?ws=1).",
  "outputs.loading": "Đang tải…",
  "outputs.noDaemon": "Không kết nối được daemon.",

  // ── work item ────────────────────────────────────────────────────────────
  "work.because": "vì →",
  "work.whyLabel": "Vì sao",
  "work.liveOnly": "Work item chỉ có ở live mode (?ws=1).",
  "work.loading": "Đang tải…",
  "work.none": "Không có work item cho agent này.",

  // ── xem toà nhà ──────────────────────────────────────────────────────────
  "building.button": "🏢 Tòa nhà",
  "building.title": "Tòa nhà",
  "building.close": "Đóng",
  "building.empty": "Chưa có phòng ban nào đang hoạt động.",
  "building.hasBlocked": "có agent đang kẹt",

  // ── sơ đồ tổ chức ────────────────────────────────────────────────────────
  "org.button": "Sơ đồ tổ chức",
  "org.close": "Đóng",
  "org.empty": "Chưa có agent nào đang chạy.",

  // ── board đăng ký ────────────────────────────────────────────────────────
  "board.toggle": "Board · {doing} làm · {blocked} kẹt · {done} xong",
  "board.empty": "Registry trống.",

  // ── bộ dựng robot ────────────────────────────────────────────────────────
  "robot.color.fire": "Lửa",
  "robot.color.green": "Lục",
  "robot.color.magenta": "Hồng tím",
  "robot.color.purple": "Tím",
  "robot.color.pink": "Hồng",
  "robot.color.mint": "Bạc hà",
  "robot.color.white": "Trắng",
  "robot.color.sand": "Cát",
  "robot.body.boxy": "Khối vuông",
  "robot.body.boxyDesc": "voxel, thân thiện",
  "robot.body.capsule": "Viên nang",
  "robot.body.capsuleDesc": "bo tròn, mềm, có visor",
  "robot.body.hover": "Bay lơ lửng",
  "robot.body.hoverDesc": "không chân — bay",
  "robot.body.heavy": "Máy móc nặng",
  "robot.body.heavyDesc": "to, công nghiệp, giáp vai",
  "robot.body.slim": "Người máy thon",
  "robot.body.slimDesc": "cao, mảnh, thanh lịch",
  "robot.body.retro": "Cổ điển",
  "robot.body.retroDesc": "robot thiếc 1950s",
  "robot.body.eye": "Mắt thần",
  "robot.body.eyeDesc": "một mắt bay — tối giản",
  "robot.body.quad": "Bốn chân",
  "robot.body.quadDesc": "thú máy — thấp, bò",
  "robot.body.screen": "Đầu màn hình",
  "robot.body.screenDesc": "đầu = màn hình",
  "robot.body.cube": "Lập phương",
  "robot.body.cubeDesc": "khối bay + tay rời",
  "robot.shellLight": "thân sáng",
  "robot.shellDark": "thân tối",
  "robot.walkStop": "⏸ Dừng đi",
  "robot.walkStart": "🚶 Xem dáng đi",

  // ── kịch bản demo (?mock=1) ──────────────────────────────────────────────
  "demo.readContext": "Đọc context dự án đã…",
  "demo.split": "OK — chia việc cho 4 agents.",
  "demo.readOld": "Xem code cũ trước…",
  "demo.runTests": "Chạy test suite…",
  "demo.testsRed": "Test đỏ rồi — sửa đây 😅",
  "demo.needApproval": "Cần anh duyệt lệnh này!",
  "demo.cleanDiff": "Diff sạch, 1 nit nhỏ.",
  "demo.myPartDone": "Xong phần của em!",
  "demo.e2e": "Chạy e2e bên demo-app…",
  "demo.report": "Tổng hợp kết quả, viết báo cáo.",

  // ── added in the English pass ──────────────────────────────────────────
  "outputs.open": "Mở",
  "outputs.reveal": "Mở thư mục chứa",
  "org.title": "Sơ đồ tổ chức",
  "costs.loading": "Đang tải…",
  "queue.title": "❗ Cần can thiệp",
  "hiring.title": "🪪 Tuyển dụng",
  "hiring.note": "Thành viên roster = skill/agent ĐÃ CÀI trên máy (từ ~/.claude/company/roster.yaml) — khác với nhân vật session đang chạy trong office.",
  "hiring.loading": "Đang tải…",
  "hiring.newHire": "Tuyển người mới",
  "hiring.askPm": "Giao cho PM tuyển",
  "hiring.flow": "PM sẽ chạy skill company-hire: săn ứng viên GitHub → bắt buộc quét an toàn (skillspector) → cài → ghi roster. Theo dõi tiến trình ở chatbox; người mới sẽ đi qua cửa chào cả văn phòng.",
  "panel.recentActivity": "Hoạt động gần nhất",
  "chat.typing": "PM đang gõ…",
  "chat.stop": "⏹ dừng",
  "chat.send": "Gửi",
  "wall.scrumBoard": "BẢNG VIỆC",
  "chat.note": "\u24d8 chat kh\u00f4ng duy\u1ec7t \u0111\u01b0\u1ee3c permission \u2014 x\u1eed l\u00fd \u1edf app g\u1ed1c \u00b7 m\u1ed7i tin = 1 turn Claude th\u1eadt",
};
