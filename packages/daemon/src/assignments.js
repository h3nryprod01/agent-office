// lane L6: persona + SOP over HTTP.
//
//   GET  /roster-members?source=company|template|project[&name=]   a roster with persona/sop, same shape as GET /roster
//   GET  /sop?source=…[&name=]&member=<name>                  one member's parsed SOP
//   POST /assign {project, member, title, brief?, parentItemId?}
//        → creates the work item (assignee = member, sopStep = 1 when the member has an SOP)
//          and returns the prompt to spawn that member with: persona + SOP + task + reporting contract.
//
// The daemon never spawns the agent itself — the PM (or a script) takes the returned prompt. That keeps
// "who runs it" (harness, lane, worktree) out of this module.
//
// `name` is untrusted (any page in the browser can fetch() localhost): a template goes through
// resolveTemplateDir, a project through PROJECT_SLUG_RE, and member files through resolveAsset.

import fs from "node:fs";
import path from "node:path";

import { resolveTemplateDir } from "../../../scripts/company-template-lib.mjs";
import { buildMemberPrompt, loadMemberKit } from "./persona.js";
import { DEFAULT_PROJECTS_DIR, PROJECT_SLUG_RE, addItem, readItems, readProject } from "./projects.js";
import { DEFAULT_COMPANY_DIR, DEFAULT_TEMPLATES_DIR } from "./templates.js";
import { readRoster } from "./roster.js";

const SOURCES = ["company", "template", "project"];
const BODY_MAX = 8192; // a brief is a paragraph or two, not a document
const STATUS_BY_CODE = { INVALID: 400, NOT_FOUND: 404, INVALID_TEMPLATE: 400 };

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** `?source=&name=` → the directory holding roster.yaml, sops/ and personas/. */
function resolveBaseDir({ source, name }, { templatesDir, projectsDir, companyDir }) {
  if (source === "company") return companyDir;
  if (source === "template") return resolveTemplateDir(templatesDir, name);
  if (source === "project") {
    if (typeof name !== "string" || !PROJECT_SLUG_RE.test(name)) throw fail("INVALID", `invalid project: ${JSON.stringify(name)}`);
    return path.join(projectsDir, name);
  }
  throw fail("INVALID", `source must be one of ${SOURCES.join("|")}`);
}

function findMember(baseDir, memberName) {
  const roster = readRoster(path.join(baseDir, "roster.yaml"));
  const member = roster.departments.flatMap((d) => d.members).find((m) => m.name === memberName);
  if (!member) throw fail("NOT_FOUND", `no member "${memberName}" in this roster`);
  return member;
}

export function createAssignmentsHttpHandler({
  templatesDir = DEFAULT_TEMPLATES_DIR,
  projectsDir = DEFAULT_PROJECTS_DIR,
  companyDir = DEFAULT_COMPANY_DIR,
} = {}) {
  const dirs = { templatesDir, projectsDir, companyDir };

  return (req, res, url) => {
    const route = url.pathname;
    if (route !== "/roster-members" && route !== "/sop" && route !== "/assign") return false;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }

    const respond = (statusCode, payload) => {
      res.writeHead(statusCode, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const guard = (fn) => {
      try {
        fn();
      } catch (error) {
        const status = STATUS_BY_CODE[error.code];
        if (status) {
          respond(status, { error: error.message });
          return;
        }
        console.error("[assignments] error:", error);
        respond(500, { error: "server error" });
      }
    };

    if (route === "/assign") {
      if (req.method !== "POST") {
        respond(405, { error: "method not allowed" });
        return true;
      }
      let body = "";
      let tooBig = false;
      req.on("data", (chunk) => {
        if (tooBig) return;
        body += chunk;
        if (body.length > BODY_MAX) {
          tooBig = true;
          body = "";
        }
      });
      req.on("end", () => {
        if (tooBig) {
          respond(413, { error: `request body larger than ${BODY_MAX} bytes` });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        // Named fields only — a request must not carry its own directories.
        const { project, member, title, brief, parentItemId } = parsed ?? {};
        guard(() => respond(201, assign({ ...dirs, project, member, title, brief, parentItemId })));
      });
      return true;
    }

    if (req.method !== "GET") {
      respond(405, { error: "method not allowed" });
      return true;
    }
    const q = url.searchParams;
    guard(() => {
      const baseDir = resolveBaseDir({ source: q.get("source"), name: q.get("name") }, dirs);
      if (route === "/roster-members") {
        respond(200, readRoster(path.join(baseDir, "roster.yaml")));
        return;
      }
      const member = findMember(baseDir, q.get("member"));
      if (!member.sop) throw fail("NOT_FOUND", `member "${member.name}" has no SOP`);
      const kit = loadMemberKit({ baseDir, member });
      if (!kit.sop) throw fail("NOT_FOUND", kit.problems.join("; "));
      respond(200, { member: member.name, path: member.sop, sop: kit.sop, problems: kit.problems });
    });
    return true;
  };
}

/** Everything /assign does, minus HTTP. Validates first so a refused request leaves no item behind. */
export function assign({ projectsDir, project, member: memberName, title, brief = null, parentItemId = null }) {
  if (typeof project !== "string" || !PROJECT_SLUG_RE.test(project)) throw fail("INVALID", `invalid project: ${JSON.stringify(project)}`);
  if (typeof memberName !== "string" || memberName === "") throw fail("INVALID", "member is required");
  readProject({ projectsDir, slug: project }); // 404 for an unknown project
  const baseDir = path.join(projectsDir, project);
  const member = findMember(baseDir, memberName);
  if (brief !== null && brief !== undefined && typeof brief !== "string") throw fail("INVALID", "brief must be a string");

  if (parentItemId != null && !readItems({ projectsDir, slug: project }).some((i) => i.id === parentItemId)) {
    throw fail("INVALID", `parentItemId "${parentItemId}" is not an item of this project`);
  }

  const kit = loadMemberKit({ baseDir, member });
  const item = addItem({
    projectsDir,
    slug: project,
    title,
    source: "agent",
    status: "doing",
    assignee: member.name,
    parentItemId: parentItemId ?? null,
    sopStep: kit.sop ? 1 : null,
  });

  let goals = null;
  try {
    goals = fs.readFileSync(path.join(baseDir, "goals.md"), "utf8");
  } catch {
    // a project without goals.md still gets work assigned
  }
  const prompt = buildMemberPrompt({
    member,
    kit,
    goals,
    task: { id: item.id, title: item.title, brief: brief || null, parentItemId: item.parentItemId },
  });
  return { item, prompt, problems: kit.problems };
}
