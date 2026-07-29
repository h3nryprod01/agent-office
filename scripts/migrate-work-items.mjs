#!/usr/bin/env node
// R13-A: one-shot migration of .claude/memory/work-items.json into the new
// ~/.agent-office/projects/agent-office/ layout. Reads work-items.json, never writes it.
//
// Closed work (done|dropped) lands in items-archive.json so the board isn't a graveyard;
// only open work stays in items.json. Old `wi-…` ids are kept verbatim — the Plane and PR
// links point at them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DEFAULT_PROJECTS_DIR, createProject } from "../packages/daemon/src/projects.js";

const SLUG = "agent-office";
const ARCHIVED_STATUSES = ["done", "dropped"];

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** work item (cũ) → item (mới). Giữ nguyên id; timestamps lấy từ `updatedAt` cũ. */
function toItem(wi) {
  const at = wi.updatedAt;
  return {
    id: wi.id,
    title: wi.title,
    source: "agent",
    status: wi.status === "backlog" ? "idea" : wi.status,
    createdAt: at,
    updatedAt: at,
    fromIdea: null,
    assignee: wi.assignee ?? null,
    links: {
      pr: wi.pr ?? null,
      plane: wi.planeUrl ?? null,
      obsidian: wi.obsidianNote ?? null,
      branch: wi.branch ?? null,
    },
  };
}

/** Any item a person typed, in items.json or still sitting unread in the outbox. */
function hasHumanItems(dir) {
  try {
    if (JSON.parse(fs.readFileSync(path.join(dir, "items.json"), "utf8")).items.some((i) => i.source === "human")) {
      return true;
    }
  } catch {
    // no items.json yet, or unreadable — nothing to protect
  }
  for (const name of ["items-outbox.jsonl", "items-outbox.jsonl.draining"]) {
    try {
      if (fs.readFileSync(path.join(dir, name), "utf8").includes('"human"')) return true;
    } catch {
      // absent
    }
  }
  return false;
}

export function migrate({ projectsDir, workItemsPath, repoRoot, force = false }) {
  const raw = JSON.parse(fs.readFileSync(workItemsPath, "utf8"));
  if (!Array.isArray(raw.items)) {
    throw new Error(`${workItemsPath}: thiếu mảng "items"`);
  }

  const dir = path.join(projectsDir, SLUG);
  if (fs.existsSync(dir)) {
    if (!force) throw new Error(`dự án "${SLUG}" đã tồn tại: ${dir} (dùng --force để ghi đè)`);
    // --force deletes the whole project directory. Once a human has typed an idea into the
    // board, that is the only copy of it — this migration must not be the thing that eats it.
    if (hasHumanItems(dir)) {
      throw new Error(`dự án "${SLUG}" đã có ý tưởng do người viết — --force sẽ xoá mất chúng. Di trú thủ công.`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  createProject({ projectsDir, name: SLUG, template: "coding", cwd: repoRoot });

  const items = raw.items.map(toItem);
  const archived = raw.items.filter((wi) => ARCHIVED_STATUSES.includes(wi.status)).map(toItem);
  const board = items.filter((i) => !archived.some((a) => a.id === i.id));

  writeJsonAtomic(path.join(dir, "items-archive.json"), { version: 1, items: archived });
  writeJsonAtomic(path.join(dir, "items.json"), { version: 1, items: board });
  return { archived: archived.length, board: board.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoDefault = fileURLToPath(new URL("../", import.meta.url));
  const { values } = parseArgs({
    options: {
      "projects-dir": { type: "string" },
      "work-items": { type: "string" },
      "repo-root": { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const repoRoot = path.resolve(values["repo-root"] ?? repoDefault);
  try {
    const result = migrate({
      projectsDir: values["projects-dir"] ?? DEFAULT_PROJECTS_DIR,
      workItemsPath: values["work-items"] ?? path.join(repoRoot, ".claude", "memory", "work-items.json"),
      repoRoot,
      force: values.force,
    });
    console.log(`archived=${result.archived} board=${result.board}`);
  } catch (error) {
    console.error(`lỗi: ${error.message}`);
    process.exit(1);
  }
}
