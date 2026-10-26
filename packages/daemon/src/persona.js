// lane L6: personas and SOPs for roster members.
//
// A roster member may carry
//   persona: { name, role, avatar, voice, tone, prompt | prompt_file }   who the agent is
//   sop:     sops/<position>.md                                           how that position works
// Both are optional — a roster without them behaves exactly as before.
//
// An SOP file is a short frontmatter (the machine-readable part) plus free markdown:
//
//   ---
//   title: Developer
//   inputs:   what must exist before you start
//   steps:    the procedure, in order — one line each; `sopStep` on a work item is a 1-based index into it
//   done:     the definition-of-done checklist; every line must be true before you report Done
//   handoff:  `<member-name | position | human>: <what you hand over>` (a position = the basename of a member's SOP file)
//   escalate: when a human must decide instead of you
//   ---
//
// The frontmatter is NOT YAML: it has its own tiny reader (parseFrontmatter) so an item
// may contain `: ` or `#` without quoting, which is what SOP authors actually write.
//
// Everything that reads a member's files goes through resolveAsset(): flat `sops/*.md` /
// `personas/*.md` only, and the real path must stay inside the company directory.

import fs from "node:fs";
import path from "node:path";

import { parseRoster } from "./roster.js";

const SCALAR_KEYS = ["title", "role"];
const LIST_KEYS = ["inputs", "steps", "done", "handoff", "escalate"];
const HANDOFF_ITEM_RE = /^([A-Za-z0-9][A-Za-z0-9:_-]*):\s+(\S.*)$/;
const ASSET_RE = /^(sops|personas)\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const AVATAR_RE = /^[a-z0-9-]+$/;
const MAX_FILE_BYTES = 64 * 1024;
const MIN_STEPS = 2;
const MAX_STEPS = 12;

/** Handoff targets that are not roster members. */
export const HUMAN_TARGETS = ["human"];

const unquote = (s) =>
  s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) ? s.slice(1, -1) : s;

/**
 * Split `---\nfrontmatter\n---\nbody`. Returns null when the file has no frontmatter block.
 * @returns {{ front: string, body: string } | null}
 */
function splitFrontmatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(String(text));
  return m ? { front: m[1], body: (m[2] ?? "").trim() } : null;
}

/** `key: value` and `key:` + `  - item` lines → `{ scalars, lists, unknown }`. */
function parseFrontmatter(front) {
  const scalars = {};
  const lists = {};
  const unknown = [];
  let current = null;
  for (const raw of front.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item) {
      if (current) lists[current].push(unquote(item[1].trim()));
      continue;
    }
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(raw);
    if (!pair) continue;
    const [, key, value] = pair;
    current = null;
    if (LIST_KEYS.includes(key)) {
      lists[key] = [];
      current = key;
    } else if (SCALAR_KEYS.includes(key)) {
      scalars[key] = unquote(value.trim());
    } else {
      unknown.push(key);
    }
  }
  return { scalars, lists, unknown };
}

/**
 * Parse + validate an SOP file.
 * @returns {{ sop: object|null, errors: string[] }} `sop` is null only when there is no frontmatter at all;
 *   otherwise it is the best-effort parse and `errors` says what is wrong with it.
 */
export function parseSop(text) {
  const parts = splitFrontmatter(text);
  if (!parts) return { sop: null, errors: ["no `---` frontmatter block at the top of the file"] };

  const { scalars, lists, unknown } = parseFrontmatter(parts.front);
  const errors = unknown.map((k) => `unknown frontmatter key "${k}" (expected ${[...SCALAR_KEYS, ...LIST_KEYS].join(", ")})`);

  if (!scalars.title) errors.push("missing `title`");
  for (const key of LIST_KEYS) {
    if (!lists[key] || lists[key].length === 0) errors.push(`missing or empty \`${key}\``);
  }
  const steps = lists.steps ?? [];
  if (steps.length > 0 && steps.length < MIN_STEPS) errors.push(`\`steps\` needs at least ${MIN_STEPS} lines — one step is not a procedure`);
  if (steps.length > MAX_STEPS) errors.push(`\`steps\` has ${steps.length} lines, at most ${MAX_STEPS} — split the position`);

  const handoff = [];
  for (const line of lists.handoff ?? []) {
    const m = HANDOFF_ITEM_RE.exec(line);
    if (m) handoff.push({ to: m[1], what: m[2].trim() });
    else errors.push(`\`handoff\` item "${line}" must look like "<member-name or human>: <what you hand over>"`);
  }

  return {
    sop: {
      title: scalars.title ?? "",
      role: scalars.role ?? null,
      inputs: lists.inputs ?? [],
      steps,
      done: lists.done ?? [],
      handoff,
      escalate: lists.escalate ?? [],
      body: parts.body,
    },
    errors,
  };
}

/**
 * `rel` → absolute path inside `baseDir`, or null. Flat `sops/*.md` / `personas/*.md` only, and the
 * resolved real path must stay under baseDir (a symlink in sops/ must not read /etc/anything).
 */
export function resolveAsset(baseDir, rel) {
  if (typeof rel !== "string" || !ASSET_RE.test(rel)) return null;
  try {
    const real = fs.realpathSync(path.join(baseDir, rel));
    const root = fs.realpathSync(baseDir);
    return real.startsWith(root + path.sep) ? real : null;
  } catch {
    return null;
  }
}

function readAsset(baseDir, rel) {
  const file = resolveAsset(baseDir, rel);
  if (!file) throw new Error(`"${rel}" is not a readable sops/*.md or personas/*.md file inside the company directory`);
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error(`"${rel}" is larger than ${MAX_FILE_BYTES} bytes`);
  return fs.readFileSync(file, "utf8");
}

/**
 * Persona + SOP of one roster member, read from `baseDir` (a template, project or company directory).
 * Never throws: a broken file becomes an entry in `problems` and the rest of the kit still loads, so a
 * half-written template degrades to "less persona" instead of "cannot assign work".
 * @returns {{ persona: object|null, sop: object|null, problems: string[] }}
 */
export function loadMemberKit({ baseDir, member }) {
  const problems = [];
  let persona = member.persona ?? null;
  if (persona?.promptFile) {
    try {
      persona = { ...persona, prompt: readAsset(baseDir, persona.promptFile).trim() };
    } catch (error) {
      problems.push(`persona.prompt_file: ${error.message}`);
    }
  }

  let sop = null;
  if (member.sop) {
    try {
      const parsed = parseSop(readAsset(baseDir, member.sop));
      sop = parsed.sop;
      for (const e of parsed.errors) problems.push(`${member.sop}: ${e}`);
    } catch (error) {
      problems.push(`sop ${member.sop}: ${error.message}`);
    }
  }
  return { persona, sop, problems };
}

/** Strict check of a company directory (roster.yaml + sops/ + personas/). Returns human-readable problems. */
export function validateCompany({ baseDir }) {
  const problems = [];
  let roster;
  try {
    roster = parseRoster(fs.readFileSync(path.join(baseDir, "roster.yaml"), "utf8"));
  } catch (error) {
    return [`roster.yaml: ${error.message}`];
  }
  const members = roster.departments.flatMap((d) => d.members);
  // A handoff target is a member, or a position — the basename of a member's SOP file
  // (`video-producer` for `hyperframes`), which reads better than a skill name.
  const names = new Set(members.map((m) => m.name));
  for (const m of members) if (m.sop) names.add(path.basename(m.sop, ".md"));

  for (const member of members) {
    const at = `member "${member.name}"`;
    const { persona } = member;
    if (persona) {
      for (const field of ["name", "role", "avatar", "voice", "tone"]) {
        if (!persona[field]) problems.push(`${at}: persona.${field} is required`);
      }
      if (persona.avatar && !AVATAR_RE.test(persona.avatar)) problems.push(`${at}: persona.avatar must match ${AVATAR_RE}`);
      if (!persona.prompt && !persona.promptFile) problems.push(`${at}: persona needs prompt or prompt_file`);
      if (persona.prompt && persona.promptFile) problems.push(`${at}: persona sets both prompt and prompt_file — pick one`);
    }
    if (!persona && !member.sop) continue;

    const kit = loadMemberKit({ baseDir, member });
    for (const p of kit.problems) problems.push(`${at}: ${p}`);
    for (const h of kit.sop?.handoff ?? []) {
      if (!names.has(h.to) && !HUMAN_TARGETS.includes(h.to)) {
        problems.push(`${at}: ${member.sop} hands over to "${h.to}", who is neither a member nor a position in this roster`);
      }
    }
  }
  return problems;
}

const bullet = (items) => items.map((i) => `- ${i}`).join("\n");

/**
 * The prompt a member is spawned with: who they are, their standard procedure, the task, and the
 * reporting contract. Tolerates an empty kit (a legacy member gets just the task).
 * @param {{ id?: string, title: string, brief?: string|null, parentItemId?: string|null }} task
 */
export function buildMemberPrompt({ member, kit, task, goals = null }) {
  const { persona, sop } = kit;
  const sections = [];

  if (persona) {
    const who = [`You are ${persona.name ?? member.name}${persona.role ? `, ${persona.role}` : ""}.`];
    if (persona.voice) who.push(`Voice: ${persona.voice}.`);
    if (persona.tone) who.push(`Tone: ${persona.tone}.`);
    if (persona.prompt) who.push(persona.prompt);
    sections.push(`# Who you are\n${who.join(" ")}`);
  } else {
    sections.push(`# Who you are\nYou are ${member.name}${member.role ? `, ${member.role}` : ""}.`);
  }

  if (sop) {
    const steps = sop.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    const handoff = sop.handoff.map((h) => `- ${h.to}: ${h.what}`).join("\n");
    sections.push(
      [
        `# Your standard procedure — ${sop.title}`,
        `Follow it in order. Do not skip a step; if one does not apply, say so in your report.`,
        `## Inputs you need before you start\n${bullet(sop.inputs)}`,
        `## Steps\n${steps}`,
        `## Definition of done — every line must be true before you report Done\n${sop.done.map((d) => `- [ ] ${d}`).join("\n")}`,
        `## Hand over to\n${handoff}`,
        `## Escalate to a human when\n${bullet(sop.escalate)}`,
        sop.body ? `## Notes for this position\n${sop.body}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  if (goals) sections.push(`# Project goals\n${goals.trim().slice(0, 2000)}`);

  const taskLines = [`# Your task`, task.title];
  if (task.brief) taskLines.push("", task.brief);
  if (task.id) taskLines.push("", `Work item: ${task.id}${task.parentItemId ? ` (part of ${task.parentItemId})` : ""}.`);
  sections.push(taskLines.join("\n"));

  const report = [
    `# Reporting`,
    `When you finish or get stuck, report in five parts, each at most two lines: Did / Verified / Links / Blockers / Next.`,
  ];
  if (sop && task.id) {
    report.push(`Keep the work item's \`sopStep\` equal to the SOP step number you are on (1-${sop.steps.length}); update it each time you move to the next step.`);
  }
  sections.push(report.join("\n"));

  return sections.join("\n\n");
}
