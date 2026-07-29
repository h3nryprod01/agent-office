#!/usr/bin/env node
// company-template — CLI quản lý "công ty đóng hộp" (template roster + goals).
// KHÔNG import daemon/renderer. Chỉ đọc/ghi templates/ (trong repo) và ~/.claude/company/.
// Logic thật nằm trong company-template-lib.mjs — daemon (GET/POST /templates) dùng chung.
//
// Lệnh:
//   list              liệt kê template trong templates/
//   show <name>       in roster.yaml + goals.md của 1 template
//   apply <name>      đè template lên ~/.claude/company/roster.yaml (backup .bak) + báo skill thiếu
//   save <name>       lưu roster hiện tại thành template mới

import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import {
  TEMPLATE_NAME_RE,
  applyTemplate,
  readGoals,
  resolveTemplateDir,
  templateNames,
} from "./company-template-lib.mjs";

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const HOME_DIR = os.homedir();
const COMPANY_DIR = path.join(HOME_DIR, ".claude", "company");
const ROSTER_PATH = path.join(COMPANY_DIR, "roster.yaml");

const USAGE = `Cách dùng: company-template <lệnh> [tên]

  list            liệt kê template có sẵn
  show <name>     xem roster + goals của template
  apply <name>    đè template lên ~/.claude/company/roster.yaml (backup .bak), báo skill thiếu
  save <name>     lưu roster hiện tại thành template mới`;

function listTemplates() {
  let dirs;
  try {
    dirs = templateNames(TEMPLATES_DIR);
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`không tìm thấy thư mục templates/ tại ${TEMPLATES_DIR}`);
    throw err;
  }
  if (!dirs.length) {
    console.log("(chưa có template nào trong templates/)");
    return;
  }
  console.log("Template có sẵn:");
  for (const d of dirs) console.log(`  - ${d}`);
}

function show(name) {
  const dir = resolveTemplateDir(TEMPLATES_DIR, name);
  let rosterText;
  try {
    rosterText = fs.readFileSync(path.join(dir, "roster.yaml"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`template "${name}" không có roster.yaml`);
    throw err;
  }
  console.log(`=== ${name}/roster.yaml ===`);
  console.log(rosterText.trimEnd());
  const goals = readGoals(dir);
  if (goals) {
    console.log(`\n=== ${name}/goals.md ===`);
    console.log(goals.trimEnd());
  }
}

function apply(name) {
  const result = applyTemplate({
    templatesDir: TEMPLATES_DIR,
    companyDir: COMPANY_DIR,
    homeDir: HOME_DIR,
    name,
  });

  if (result.backupPath) console.log(`Đã backup roster hiện tại → ${result.backupPath}`);
  console.log(`Đã apply template "${name}" → ${result.rosterPath}`);

  // Báo skill thiếu (bỏ qua member dạng plugin — không check được).
  if (result.missingSkills.length) {
    console.log(`\nSkill thiếu (${result.missingSkills.length}): ${result.missingSkills.join(", ")}`);
    console.log("→ chạy skill company-hire để tuyển (bắt buộc scan an toàn).");
  } else {
    console.log("Tất cả skill của template đã cài trên máy này.");
  }

  if (result.goals) {
    console.log(`\n=== ${name}/goals.md ===`);
    console.log(result.goals.trimEnd());
  }
}

function save(name) {
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new Error(`tên template không hợp lệ: ${JSON.stringify(name)} (chỉ a-z, 0-9, -)`);
  }
  if (!fs.existsSync(ROSTER_PATH)) {
    throw new Error(`chưa có roster để lưu: ${ROSTER_PATH}`);
  }
  const destDir = path.join(TEMPLATES_DIR, name);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(ROSTER_PATH, path.join(destDir, "roster.yaml"));
  console.log(`Đã lưu roster hiện tại → templates/${name}/roster.yaml`);
  console.log(`Tự thêm templates/${name}/goals.md (mục tiêu cho company-pm).`);
}

function main() {
  const [cmd, name] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "list":
        return listTemplates();
      case "show":
        requireName(cmd, name);
        return show(name);
      case "apply":
        requireName(cmd, name);
        return apply(name);
      case "save":
        requireName(cmd, name);
        return save(name);
      default:
        console.log(USAGE);
        return;
    }
  } catch (err) {
    console.error(`Lỗi: ${err.message}`);
    process.exit(1);
  }
}

function requireName(cmd, name) {
  if (!name) {
    console.error(`Lỗi: thiếu tên template. Cách dùng: company-template ${cmd} <name>`);
    process.exit(1);
  }
}

main();
