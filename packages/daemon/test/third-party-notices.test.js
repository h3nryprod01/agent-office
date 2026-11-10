import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectProduction, renderNotices } from "../tools/third-party-notices.mjs";

function pkg(dir, name, version, extra = {}, license = null) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, license: "MIT", ...extra }));
  if (license) writeFileSync(path.join(dir, "LICENSE"), license);
}

test("collectProduction follows dependencies transitively, skips devDependencies, keeps license text", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "notices-"));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "app", dependencies: { a: "^1" }, devDependencies: { devonly: "^1" } }),
  );
  const nm = path.join(root, "node_modules");
  pkg(path.join(nm, "a"), "a", "1.0.0", { dependencies: { b: "^2" } }, "A license text");
  pkg(path.join(nm, "b"), "b", "2.1.0", {}, "B license text");
  pkg(path.join(nm, "devonly"), "devonly", "1.0.0", {}, "dev");
  // a nested copy that only `a` can see
  pkg(path.join(nm, "a", "node_modules", "c"), "c", "3.0.0", {}, "C license text");
  writeFileSync(path.join(nm, "a", "package.json"), JSON.stringify({ name: "a", version: "1.0.0", license: "MIT", dependencies: { b: "^2", c: "^3" } }));

  const found = collectProduction(root);
  assert.deepEqual(found.map((p) => `${p.name}@${p.version}`), ["a@1.0.0", "b@2.1.0", "c@3.0.0"]);
  assert.equal(found[0].licenseText.trim(), "A license text");
  assert.ok(!found.some((p) => p.name === "devonly"));
});

test("collectProduction throws a clear error when a dependency is not installed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "notices-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app", dependencies: { missing: "^1" } }));
  assert.throws(() => collectProduction(root), /missing.*npm ci/s);
});

test("renderNotices merges the same name@version from several packages and lists assets", () => {
  const p = { name: "three", version: "0.171.0", license: "MIT", licenseText: "MIT text", homepage: "https://threejs.org" };
  const md = renderNotices({ packages: [[p], [p]], assets: [{ name: "Kenney", license: "CC0 1.0", source: "https://kenney.nl", note: "n" }] });
  assert.equal(md.split("three@0.171.0").length - 1, 1);
  assert.match(md, /Kenney/);
  assert.match(md, /MIT text/);
});

test("collectProduction does not look above the repo root (e.g. ~/node_modules)", () => {
  const outer = mkdtempSync(path.join(os.tmpdir(), "notices-"));
  const root = path.join(outer, "repo");
  mkdirSync(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app", dependencies: { stray: "^1" } }));
  pkg(path.join(outer, "node_modules", "stray"), "stray", "1.0.0", {}, "stray");
  assert.throws(() => collectProduction(root, { stopAt: root }), /stray.*npm ci/s);
});
