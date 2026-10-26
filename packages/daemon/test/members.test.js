import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROLES,
  PairingStore,
  listMembers,
  addMember,
  removeMember,
  findMemberByIdentity,
  roleIn,
  canChat,
  canApprove,
  canManageMembers,
} from "../src/members.js";

function tmpProjects(slugs = ["demo-app"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-l5-members-"));
  for (const slug of slugs) {
    fs.mkdirSync(path.join(dir, slug), { recursive: true });
    fs.writeFileSync(
      path.join(dir, slug, "project.json"),
      JSON.stringify({ version: 1, slug, name: slug, template: "coding", cwd: "/x", policy: { mode: "ask" } }, null, 2),
    );
  }
  return dir;
}

test("roles: owner everything, manager chat+approve, viewer read-only", () => {
  assert.deepEqual(ROLES, ["owner", "manager", "viewer"]);
  assert.equal(canChat("owner"), true);
  assert.equal(canChat("manager"), true);
  assert.equal(canChat("viewer"), false);
  assert.equal(canApprove("owner"), true);
  assert.equal(canApprove("manager"), true);
  assert.equal(canApprove("viewer"), false);
  assert.equal(canManageMembers("owner"), true);
  assert.equal(canManageMembers("manager"), false);
  assert.equal(canChat(null), false);
  assert.equal(canApprove(undefined), false);
});

test("addMember writes members[] into project.json and keeps every other key (policy belongs to another lane)", () => {
  const dir = tmpProjects();
  const m = addMember({ projectsDir: dir, slug: "demo-app", name: "An", role: "manager", telegram: { userId: 111 } });
  assert.match(m.id, /^m-[0-9a-f]{8}$/);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "demo-app", "project.json"), "utf8"));
  assert.deepEqual(raw.policy, { mode: "ask" });
  assert.equal(raw.members.length, 1);
  assert.deepEqual(raw.members[0].telegram, { userId: "111" }); // ids are stored as strings
  assert.equal(listMembers({ projectsDir: dir, slug: "demo-app" })[0].name, "An");
});

test("addMember validates role, name and rejects a second member with the same identity", () => {
  const dir = tmpProjects();
  assert.throws(() => addMember({ projectsDir: dir, slug: "demo-app", name: "x", role: "god" }), /role/);
  assert.throws(() => addMember({ projectsDir: dir, slug: "demo-app", name: "  ", role: "viewer" }), /name/);
  assert.throws(() => addMember({ projectsDir: dir, slug: "nope", name: "x", role: "viewer" }), /no such project/);
  addMember({ projectsDir: dir, slug: "demo-app", name: "An", role: "viewer", telegram: { userId: "5" } });
  assert.throws(
    () => addMember({ projectsDir: dir, slug: "demo-app", name: "An2", role: "manager", telegram: { userId: 5 } }),
    /already a member/,
  );
});

test("removeMember refuses to drop the last owner", () => {
  const dir = tmpProjects();
  const o = addMember({ projectsDir: dir, slug: "demo-app", name: "Boss", role: "owner" });
  const v = addMember({ projectsDir: dir, slug: "demo-app", name: "Eye", role: "viewer" });
  assert.throws(() => removeMember({ projectsDir: dir, slug: "demo-app", id: o.id }), /last owner/);
  removeMember({ projectsDir: dir, slug: "demo-app", id: v.id });
  assert.equal(listMembers({ projectsDir: dir, slug: "demo-app" }).length, 1);
  assert.throws(() => removeMember({ projectsDir: dir, slug: "demo-app", id: "m-nope" }), /no such member/);
});

test("findMemberByIdentity / roleIn look a person up by channel identity across projects", () => {
  const dir = tmpProjects(["demo-app", "acme-web"]);
  addMember({ projectsDir: dir, slug: "demo-app", name: "An", role: "manager", telegram: { userId: "7" } });
  addMember({ projectsDir: dir, slug: "acme-web", name: "An", role: "viewer", telegram: { userId: "7" } });
  addMember({ projectsDir: dir, slug: "acme-web", name: "Zed", role: "owner", zalo: { userId: "z9" } });
  assert.equal(roleIn({ projectsDir: dir, slug: "demo-app", channel: "telegram", userId: 7 }), "manager");
  assert.equal(roleIn({ projectsDir: dir, slug: "acme-web", channel: "telegram", userId: "7" }), "viewer");
  assert.equal(roleIn({ projectsDir: dir, slug: "acme-web", channel: "zalo", userId: "z9" }), "owner");
  assert.equal(roleIn({ projectsDir: dir, slug: "acme-web", channel: "telegram", userId: "999" }), null);
  const hits = findMemberByIdentity({ projectsDir: dir, channel: "telegram", userId: "7" });
  assert.deepEqual(hits.map((h) => h.slug).sort(), ["acme-web", "demo-app"]);
});

test("PairingStore: code is single-use, expires, and redeeming adds the member", () => {
  const dir = tmpProjects();
  let now = 1_000_000;
  const store = new PairingStore({ projectsDir: dir, ttlMs: 60_000, now: () => now });
  const { code, expiresAt } = store.create({ slug: "demo-app", role: "manager", createdBy: "m-boss" });
  assert.match(code, /^AO-[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(expiresAt, now + 60_000);

  const res = store.redeem(code.toLowerCase(), { channel: "telegram", userId: 42, name: "Binh" });
  assert.equal(res.ok, true);
  assert.equal(res.slug, "demo-app");
  assert.equal(res.member.role, "manager");
  assert.equal(roleIn({ projectsDir: dir, slug: "demo-app", channel: "telegram", userId: "42" }), "manager");

  const again = store.redeem(code, { channel: "telegram", userId: 43, name: "Eve" });
  assert.equal(again.ok, false); // one-time
  assert.equal(listMembers({ projectsDir: dir, slug: "demo-app" }).length, 1);
});

test("PairingStore: expired code is refused and forgotten", () => {
  const dir = tmpProjects();
  let now = 0;
  const store = new PairingStore({ projectsDir: dir, ttlMs: 1000, now: () => now });
  const { code } = store.create({ slug: "demo-app", role: "viewer", createdBy: "x" });
  now = 5000;
  const res = store.redeem(code, { channel: "telegram", userId: 1, name: "n" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid_or_expired");
  assert.equal(store.pending().length, 0);
});

test("PairingStore: unknown slug / bad role cannot mint a code; a person already in the project keeps their old membership", () => {
  const dir = tmpProjects();
  const store = new PairingStore({ projectsDir: dir });
  assert.throws(() => store.create({ slug: "nope", role: "viewer", createdBy: "x" }), /no such project/);
  assert.throws(() => store.create({ slug: "demo-app", role: "root", createdBy: "x" }), /role/);
  addMember({ projectsDir: dir, slug: "demo-app", name: "An", role: "viewer", telegram: { userId: "3" } });
  const { code } = store.create({ slug: "demo-app", role: "manager", createdBy: "x" });
  const res = store.redeem(code, { channel: "telegram", userId: "3", name: "An" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "already_member");
  assert.equal(roleIn({ projectsDir: dir, slug: "demo-app", channel: "telegram", userId: "3" }), "viewer");
});

test("PairingStore.pending lists only live codes (and never the code of another project when filtered)", () => {
  const dir = tmpProjects(["demo-app", "acme-web"]);
  const store = new PairingStore({ projectsDir: dir });
  store.create({ slug: "demo-app", role: "viewer", createdBy: "x" });
  store.create({ slug: "acme-web", role: "viewer", createdBy: "x" });
  assert.equal(store.pending("demo-app").length, 1);
  assert.equal(store.pending().length, 2);
});
