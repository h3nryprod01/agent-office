// lane L7: "new project" wizard backend. A template's goals.md carries upper-case blanks such as
// `<PRODUCT>`; instead of asking a non-coder to edit that file, the UI renders one form field per
// blank and this module writes the answers into the new project's goals.md.
//
//   GET  /wizard/template?name=<template>   → {name, fields: [{key, hint, example}]}
//   POST /wizard/create {name, template, cwd?, fields?, notes?}   → the project (same shape as POST /projects)
//     `cwd` omitted → the project gets its own folder <home>/AgentOffice/<slug> (created if missing):
//     a non-coder has no repo to point at, and a path typed by hand is the first thing they would get wrong.
//
// Everything that decides WHAT may be created (slug, template name, cwd inside home) stays in
// projects.js's createProject; this module validates its own inputs first and then delegates, so a
// rejected request never leaves a half-made project behind.
// ponytail: role check is the same stand-in as docs-workspace.js (loopback = owner) until L1's roleOf.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TEMPLATE_NAME_RE, readGoals, templateNames } from "../../../scripts/company-template-lib.mjs";
import { loopbackRole } from "./docs-workspace.js";
import { DEFAULT_PROJECTS_DIR, createProject, slugify } from "./projects.js";
import { DEFAULT_TEMPLATES_DIR } from "./templates.js";

// `<PRODUCT>`, `<SỐ LEAD/THÁNG>` — upper-case so `<b>` / `<br>` / `<https://…>` never count.
const FIELD_RE = /<([\p{Lu}\p{N}][\p{Lu}\p{N} /_.-]*)>/gu;
const DEFINITION_ROW_RE = /^\|\s*`?<([^>]+)>`?\s*\|\s*([^|]*)\|\s*([^|]*)/u;
const VALUE_MAX = 200;
const NOTES_MAX_LINES = 20;
const CAN_CREATE = new Set(["owner", "manager"]);
const STATUS_BY_CODE = { INVALID: 400, EXISTS: 409, NOT_FOUND: 404, FORBIDDEN: 403 };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
const invalid = (m) => fail("INVALID", m);

const singleLine = (text) => String(text).replace(/\s+/g, " ").trim();
const unquote = (text) => singleLine(text).replace(/^["“'`]+|["”'`]+$/g, "");

/** The blanks of a goals.md, in the order they are defined (table) or first used. */
export function parseGoalsFields(goals) {
  const hints = new Map();
  for (const line of goals.split("\n")) {
    const row = line.match(DEFINITION_ROW_RE);
    if (!row) continue;
    const key = row[1].trim();
    if (hints.has(key)) continue;
    // Templates are not consistent about which column holds the example and which the meaning, so
    // only a QUOTED cell counts as an example (it becomes the input's placeholder); anything else
    // is shown as part of the hint.
    const third = singleLine(row[3]);
    const quoted = /^["“].*["”]$/.test(third);
    hints.set(key, {
      hint: [singleLine(row[2]), quoted ? "" : third].filter(Boolean).join(" — ") || null,
      example: quoted ? unquote(third) : null,
    });
  }
  const keys = [];
  for (const match of goals.matchAll(FIELD_RE)) {
    const key = match[1].trim();
    if (!keys.includes(key)) keys.push(key);
  }
  const defined = keys.filter((k) => hints.has(k));
  const ordered = [...defined, ...keys.filter((k) => !hints.has(k))];
  return ordered.map((key) => ({ key, hint: hints.get(key)?.hint ?? null, example: hints.get(key)?.example ?? null }));
}

/**
 * Put the answers into goals.md. Blanks are replaced everywhere EXCEPT in the definition table
 * (that row is the documentation of the blank). An unanswered blank stays visible for the PM.
 * Then a "Brief" lists the answers and "Notes" the free-text goals.
 */
export function fillGoals(goals, values, notes) {
  const answered = Object.entries(values).filter(([, v]) => v !== "");
  const body = goals
    .split("\n")
    .map((line) =>
      DEFINITION_ROW_RE.test(line)
        ? line
        : answered.reduce((text, [key, value]) => text.split(`<${key}>`).join(value), line),
    )
    .join("\n");
  const sections = [];
  if (answered.length > 0) sections.push(`## Brief\n\n${answered.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
  if (notes.length > 0) sections.push(`## Notes\n\n${notes.map((n) => `- ${n}`).join("\n")}`);
  return sections.length === 0 ? body : `${body.replace(/\n*$/, "\n")}\n${sections.join("\n\n")}\n`;
}

function cleanAnswers(raw, knownKeys) {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalid("fields must be an object");
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw invalid(`field "${key}" must be a string`);
    if (knownKeys.includes(key)) out[key] = singleLine(value).slice(0, VALUE_MAX);
  }
  return out;
}

function cleanNotes(raw) {
  if (raw === undefined) return [];
  if (typeof raw !== "string") throw invalid("notes must be a string");
  return raw
    .split("\n")
    .map((l) => singleLine(l).slice(0, VALUE_MAX))
    .filter(Boolean)
    .slice(0, NOTES_MAX_LINES);
}

function templateDirOf(templatesDir, name) {
  if (typeof name !== "string" || !TEMPLATE_NAME_RE.test(name)) throw invalid("invalid template name");
  if (!templateNames(templatesDir).includes(name)) throw fail("NOT_FOUND", `no such template "${name}"`);
  return path.join(templatesDir, name);
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function createProjectWizardHandler({
  projectsDir = DEFAULT_PROJECTS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  homeDir = os.homedir(),
  roleOf = loopbackRole,
} = {}) {
  return (req, res, url) => {
    if (url.pathname !== "/wizard/template" && url.pathname !== "/wizard/create") return false;

    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    };
    const run = (fn) => {
      try {
        const [status, payload] = fn();
        json(status, payload);
      } catch (error) {
        const status = STATUS_BY_CODE[error.code];
        if (status) return json(status, { error: error.message });
        console.error("[wizard] error:", error);
        json(500, { error: "server error" });
      }
    };

    const wantsPost = url.pathname === "/wizard/create";
    if (req.method !== (wantsPost ? "POST" : "GET")) {
      json(405, { error: "method not allowed" });
      return true;
    }
    if (!CAN_CREATE.has(roleOf(req))) {
      json(403, { error: "not allowed" });
      return true;
    }

    if (!wantsPost) {
      run(() => {
        const name = url.searchParams.get("name");
        const dir = templateDirOf(templatesDir, name);
        return [200, { name, fields: parseGoalsFields(readGoals(dir) ?? "") }];
      });
      return true;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) req.destroy();
    });
    req.on("end", () => {
      run(() => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw invalid("body must be JSON");
        }
        // Named fields only — see POST /projects: a body must never carry its own homeDir/projectsDir.
        const { name, template } = parsed ?? {};
        const slug = slugify(name);
        const dir = templateDirOf(templatesDir, template);
        const goals = readGoals(dir) ?? "";
        const answers = cleanAnswers(parsed.fields, parseGoalsFields(goals).map((f) => f.key));
        const notes = cleanNotes(parsed.notes);

        // Default folder: only created after every input above has been accepted. It sits under
        // homeDir by construction (slug is [a-z0-9-]), so createProject's inside-home check still holds.
        let cwd = parsed.cwd;
        if (cwd === undefined || cwd === null || cwd === "") {
          cwd = path.join(homeDir, "AgentOffice", slug);
          fs.mkdirSync(cwd, { recursive: true });
        }
        const project = createProject({ projectsDir, templatesDir, homeDir, name, template, cwd });
        if (Object.keys(answers).length > 0 || notes.length > 0) {
          writeFileAtomic(path.join(projectsDir, project.slug, "goals.md"), fillGoals(goals, answers, notes));
        }
        return [201, project];
      });
    });
    return true;
  };
}
