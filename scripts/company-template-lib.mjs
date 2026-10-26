// Shared logic for the company-template CLI and the daemon's GET/POST /templates.
// Every path is a parameter — nothing here reads process.env or os.homedir(), so
// tests point it at a fake HOME instead of clobbering the real roster.
//
// ponytail: roster YAML is parsed only as far as we need (member names). A full YAML
// parser is overkill here; we only ever extract the `name:` field of member entries.

import fs from "node:fs";
import path from "node:path";

// Matches a member entry line in either form:
//   flow:  `  - { name: forge, source: "..." }`   (name may be quoted when it has a colon)
//   block: `  - name: youtube-seo`
// Captures the name (quoted or bare) as group 1/2/3.
const MEMBER_NAME_RE =
  /^[ \t]*-[ \t]*\{?[ \t]*name:[ \t]*(?:"([^"]+)"|'([^']+)'|([^,\s}]+))/gm;

/** A template name is one directory segment — no `..`, no separators, no dotfiles. */
export const TEMPLATE_NAME_RE = /^[a-z0-9-]+$/;

/**
 * Extract member `name` values from a roster YAML text.
 * Returns names in document order. Non-member lines (no leading `- ... name:`) are ignored.
 * @param {string} yamlText
 * @returns {string[]}
 */
export function extractMemberNames(yamlText) {
  const names = [];
  let m;
  while ((m = MEMBER_NAME_RE.exec(yamlText)) !== null) {
    names.push(m[1] ?? m[2] ?? m[3]);
  }
  return names;
}

/**
 * Return the subset of `names` not present in `installed`.
 * @param {string[]} names
 * @param {Set<string>} installed
 * @returns {string[]}
 */
export function missingSkills(names, installed) {
  return names.filter((n) => !installed.has(n));
}

/**
 * Member names that can't be checked against ~/.claude/{skills,agents}: `source` is a plugin (lives in the
 * plugin cache) or `builtin` (a position with no installed skill behind it — the persona + SOP ARE the member).
 * Handles both roster shapes: `source` on the flow line, or on a later line of a block member.
 */
export function pluginMemberNames(text) {
  const set = new Set();
  const uncheckable = /source:[ \t]*["']?(?:plugin|builtin)/;
  let current = null; // block form: the member whose keys we are reading
  for (const line of text.split(/\r?\n/)) {
    const m = /^[ \t]*-[ \t]*\{?[ \t]*name:[ \t]*(?:"([^"]+)"|'([^']+)'|([^,\s}]+))(.*)$/.exec(line);
    if (m) {
      current = m[1] ?? m[2] ?? m[3];
      if (uncheckable.test(m[4])) set.add(current);
    } else if (current && /^[ \t]+source:/.test(line) && uncheckable.test(line)) {
      set.add(current);
    }
  }
  return set;
}

/** Skills/agents installed under `homeDir`: dir names in .claude/skills + .md basenames in .claude/agents. */
export function installedSkills(homeDir) {
  const installed = new Set();
  for (const dir of [path.join(homeDir, ".claude", "skills"), path.join(homeDir, ".claude", "agents")]) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) installed.add(e.name.slice(0, -3));
      else if (e.isDirectory()) installed.add(e.name);
    }
  }
  return installed;
}

/** Skills a template's roster needs but `homeDir` doesn't have (plugin members excluded). */
export function templateMissingSkills(rosterText, homeDir) {
  const plugins = pluginMemberNames(rosterText);
  const checkable = extractMemberNames(rosterText).filter((n) => !plugins.has(n));
  return missingSkills(checkable, installedSkills(homeDir));
}

/**
 * Resolve `<templatesDir>/<name>` after validating the name. Throws on anything
 * that isn't a plain slug naming a real directory. Both the CLI and the daemon
 * route go through here, so path traversal is stopped in exactly one place.
 * @returns {string} the template directory
 */
export function resolveTemplateDir(templatesDir, name) {
  if (typeof name !== "string" || !TEMPLATE_NAME_RE.test(name)) {
    throw badTemplate(`tên template không hợp lệ: ${JSON.stringify(name)} (chỉ a-z, 0-9, -)`);
  }
  const dir = path.join(templatesDir, name);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw badTemplate(`không có template "${name}" trong templates/`);
  }
  return dir;
}

/** Caller-fault error: the daemon route maps `code` to HTTP 400, everything else to 500. */
function badTemplate(message) {
  const err = new Error(message);
  err.code = "INVALID_TEMPLATE";
  return err;
}

/** Directory names under `templatesDir`, sorted. Missing dir → throws (the CLI wants that message). */
export function templateNames(templatesDir) {
  return fs
    .readdirSync(templatesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** goals.md of a template, or null when it has none. */
export function readGoals(templateDir) {
  try {
    return fs.readFileSync(path.join(templateDir, "goals.md"), "utf8");
  } catch {
    return null;
  }
}

// Timestamped so a second `apply` never clobbers the first backup — the user's
// original roster.yaml must always be recoverable, not just the most recent one.
const backupPathFor = (rosterPath) =>
  `${rosterPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;

// A template's persona/SOP files live in these directories next to roster.yaml.
const ASSET_DIRS = ["sops", "personas"];

/**
 * Copy a template's `sops/` and `personas/` next to a roster. An existing directory of the same name is renamed
 * to `<dir>.<timestamp>.bak` first — the same promise the roster itself gets: nothing the user wrote is lost.
 * Templates without these directories (every pre-persona template) copy nothing.
 */
export function copyCompanyAssets(templateDir, destDir) {
  const counts = { sops: 0, personas: 0 };
  for (const name of ASSET_DIRS) {
    const src = path.join(templateDir, name);
    if (!fs.statSync(src, { throwIfNoEntry: false })?.isDirectory()) continue;
    const dest = path.join(destDir, name);
    if (fs.existsSync(dest)) fs.renameSync(dest, backupPathFor(dest));
    fs.cpSync(src, dest, { recursive: true });
    counts[name] = fs.readdirSync(dest).length;
  }
  return counts;
}

/**
 * Back up the current roster (if any), overwrite it with the template's, and
 * report what the caller must still do. Never installs a skill — missing ones
 * go through the company-hire skill (mandatory safety scan).
 * @returns {{name: string, rosterPath: string, backupPath: string|null, missingSkills: string[], goals: string|null, assets: {sops: number, personas: number}}}
 */
export function applyTemplate({ templatesDir, companyDir, homeDir, name }) {
  const templateDir = resolveTemplateDir(templatesDir, name);
  const srcRoster = path.join(templateDir, "roster.yaml");
  let rosterText;
  try {
    rosterText = fs.readFileSync(srcRoster, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw badTemplate(`template "${name}" không có roster.yaml`);
    throw err;
  }

  const rosterPath = path.join(companyDir, "roster.yaml");
  fs.mkdirSync(companyDir, { recursive: true });

  let backupPath = null;
  if (fs.existsSync(rosterPath)) {
    backupPath = backupPathFor(rosterPath);
    fs.copyFileSync(rosterPath, backupPath);
  }
  fs.copyFileSync(srcRoster, rosterPath);
  const assets = copyCompanyAssets(templateDir, companyDir);

  return {
    assets,
    personaCount: (rosterText.match(/^[ \t]+persona:[ \t]*$/gm) ?? []).length,
    name,
    rosterPath,
    backupPath,
    missingSkills: templateMissingSkills(rosterText, homeDir),
    goals: readGoals(templateDir),
  };
}
