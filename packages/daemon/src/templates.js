// "Công ty đóng hộp" (wi-templates-panel): serve the repo's templates/ over HTTP
// so the office UI can browse and apply one — the product front-end for the
// company-template CLI, which owns the real logic (scripts/company-template-lib.mjs).
//
// POST /templates/apply OVERWRITES the user's ~/.claude/company/roster.yaml. The
// daemon binds 127.0.0.1, but any page in the user's browser can still fetch() a
// localhost port — so `name` is validated as a plain slug naming a real directory
// under templates/ (resolveTemplateDir), never joined raw into a path. It never
// installs a skill: missing ones are reported for the company-hire skill, which
// runs the mandatory safety scan.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import {
  applyTemplate,
  readGoals,
  templateMissingSkills,
  templateNames,
} from "../../../scripts/company-template-lib.mjs";
import { parseRoster } from "./roster.js";

/** templates/ lives in THIS repo, not in whatever repo the office tab points at. */
export const DEFAULT_TEMPLATES_DIR = fileURLToPath(new URL("../../../templates/", import.meta.url));
export const DEFAULT_COMPANY_DIR = path.join(os.homedir(), ".claude", "company");

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * Summarize every template on disk. Read per request — a handful of small files,
 * same discipline as /roster. A broken template is skipped, never fatal; a missing
 * templates/ dir degrades to `[]`.
 * @returns {{name: string, departments: {name: string, memberCount: number}[], memberTotal: number, hasGoals: boolean, missingSkills: string[]}[]}
 */
export function listTemplates({ templatesDir = DEFAULT_TEMPLATES_DIR, homeDir = os.homedir() } = {}) {
  let names;
  try {
    names = templateNames(templatesDir);
  } catch (error) {
    console.warn(`[templates] unreadable (${error.message}): ${templatesDir}`);
    return [];
  }

  const out = [];
  for (const name of names) {
    try {
      const dir = path.join(templatesDir, name);
      const rosterText = readFileSync(path.join(dir, "roster.yaml"), "utf8");
      const departments = parseRoster(rosterText).departments.map((d) => ({
        name: d.name,
        memberCount: d.members.length,
      }));
      out.push({
        name,
        departments,
        memberTotal: departments.reduce((n, d) => n + d.memberCount, 0),
        hasGoals: readGoals(dir) !== null,
        missingSkills: templateMissingSkills(rosterText, homeDir),
      });
    } catch (error) {
      console.warn(`[templates] skipping "${name}" (${error.message})`);
    }
  }
  return out;
}

/**
 * GET /templates → the summaries above.
 * POST /templates/apply {name} → {backupPath, missingSkills, goals} (400 on a bad name).
 * Same extraHttp contract as the other daemon routes (true once handled).
 */
export function createTemplatesHttpHandler({
  templatesDir = DEFAULT_TEMPLATES_DIR,
  companyDir = DEFAULT_COMPANY_DIR,
  homeDir = os.homedir(),
} = {}) {
  return (req, res, url) => {
    if (url.pathname !== "/templates" && url.pathname !== "/templates/apply") return false;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }

    const respond = (statusCode, payload) => {
      res.writeHead(statusCode, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === "/templates") {
      if (req.method !== "GET") {
        respond(405, { error: "method not allowed" });
        return true;
      }
      respond(200, listTemplates({ templatesDir, homeDir }));
      return true;
    }

    // /templates/apply
    if (req.method !== "POST") {
      respond(405, { error: "method not allowed" });
      return true;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy(); // a template name never needs this much
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      try {
        // resolveTemplateDir (inside applyTemplate) rejects `../x`, `a/b`, and
        // any name that isn't an existing directory — the security boundary.
        const result = applyTemplate({ templatesDir, companyDir, homeDir, name: parsed?.name });
        console.log(`[templates] applied "${result.name}" → ${result.rosterPath}`);
        respond(200, {
          backupPath: result.backupPath,
          missingSkills: result.missingSkills,
          goals: result.goals,
        });
      } catch (error) {
        if (error.code === "INVALID_TEMPLATE") {
          respond(400, { error: error.message });
          return;
        }
        console.error("[templates] apply failed:", error);
        respond(500, { error: "applying the template failed" });
      }
    });
    return true;
  };
}
