// lane L6: the bundled templates themselves — persona + SOP content is strict-valid, public-safe,
// and survives being applied into a throwaway company dir and a throwaway project.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyTemplate, templateNames } from "../../../scripts/company-template-lib.mjs";
import { createProject } from "../src/projects.js";
import { loadMemberKit, validateCompany } from "../src/persona.js";
import { parseRoster } from "../src/roster.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../../../templates/", import.meta.url));
const NAMES = templateNames(TEMPLATES_DIR);

// Minimum content per template: this is what makes them templates and not name lists.
const MIN = { coding: { sops: 10 }, "content-studio": { sops: 7 }, "real-estate-marketing": { sops: 10 } };

test("every bundled template has a persona + SOP set", () => {
  assert.deepEqual(NAMES, Object.keys(MIN).sort());
});

for (const name of NAMES) {
  const dir = path.join(TEMPLATES_DIR, name);

  test(`${name}: persona + SOP validate strictly`, () => {
    assert.deepEqual(validateCompany({ baseDir: dir }), []);
    const members = parseRoster(fs.readFileSync(path.join(dir, "roster.yaml"), "utf8")).departments.flatMap((d) => d.members);
    const sops = new Set(members.filter((m) => m.sop).map((m) => m.sop));
    assert.ok(sops.size >= MIN[name].sops, `${name}: ${sops.size} distinct SOPs, expected at least ${MIN[name].sops}`);
    for (const m of members.filter((m) => m.persona)) {
      assert.ok(m.sop, `${name}/${m.name} has a persona but no SOP`);
    }
    // every file in sops/ is used by somebody (no orphaned procedure)
    for (const file of fs.readdirSync(path.join(dir, "sops"))) {
      assert.ok(sops.has(`sops/${file}`), `${name}/sops/${file} is not referenced by any member`);
    }
  });

  test(`${name}: SOPs are concrete (no placeholders, checklist is checkable)`, () => {
    for (const file of fs.readdirSync(path.join(dir, "sops"))) {
      const text = fs.readFileSync(path.join(dir, "sops", file), "utf8");
      assert.doesNotMatch(text, /\b(TODO|TBD|lorem ipsum)\b|\.\.\.\s*$/im, `${file} has a placeholder`);
      const kit = loadMemberKit({ baseDir: dir, member: { name: "x", sop: `sops/${file}` } });
      assert.ok(kit.sop.done.length >= 3, `${file}: definition of done needs at least 3 lines`);
      assert.ok(kit.sop.escalate.length >= 2, `${file}: needs at least 2 escalation triggers`);
      assert.ok(kit.sop.inputs.length >= 2, `${file}: needs at least 2 inputs`);
    }
  });

  test(`${name}: nothing machine- or customer-specific ships in a public template`, () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const file of walk(dir)) {
      const text = fs.readFileSync(file, "utf8");
      const rel = path.relative(TEMPLATES_DIR, file);
      assert.doesNotMatch(text, /\/Users\/\w|\/home\/\w|C:\\Users/, `${rel}: absolute home path`);
      assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, `${rel}: IP address`);
      assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.-]+/, `${rel}: email address`);
      assert.doesNotMatch(text, /\b(sk-|ghp_|xox[bp]-|AKIA)[A-Za-z0-9]{8,}/, `${rel}: token-like string`);
      assert.doesNotMatch(text, /(?<![\w-])0\d{9,10}\b/, `${rel}: phone-number-like string`);
    }
  });

  test(`${name}: apply into a throwaway company dir and project keeps every persona + SOP`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-l6-apply-"));
    try {
      const companyDir = path.join(root, "home", ".claude", "company");
      applyTemplate({ templatesDir: TEMPLATES_DIR, companyDir, homeDir: path.join(root, "home"), name });
      assert.deepEqual(validateCompany({ baseDir: companyDir }), []);

      const cwd = path.join(root, "home", "demo-app");
      fs.mkdirSync(cwd, { recursive: true });
      const projectsDir = path.join(root, "projects");
      createProject({ projectsDir, templatesDir: TEMPLATES_DIR, homeDir: path.join(root, "home"), name: "Demo App", template: name, cwd });
      assert.deepEqual(validateCompany({ baseDir: path.join(projectsDir, "demo-app") }), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
