import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PmHub } from "../src/pm-hub.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { written: [], write(s) { this.written.push(s); }, end() {}, on() {} };
  }
  kill() {
    if (this._exited) return;
    this._exited = true;
    queueMicrotask(() => this.emit("exit", null));
  }
  line(obj) { this.stdout.emit("data", JSON.stringify(obj) + "\n"); }
  /** what the user asked, as the PM process received it on stdin */
  asked() { return this.stdin.written.map((w) => JSON.parse(w).message.content[0].text); }
  init(sessionId) { this.line({ type: "system", subtype: "init", session_id: sessionId }); }
  say(text) { this.line({ type: "assistant", message: { content: [{ type: "text", text }] } }); }
  finish(sessionId, extra = {}) { this.line({ type: "result", session_id: sessionId, is_error: false, ...extra }); }
}

function setup(slugs = ["demo-app", "acme-web"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-l5-hub-"));
  const projectsDir = path.join(root, "projects");
  for (const slug of slugs) {
    const cwd = path.join(root, "repos", slug);
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(projectsDir, slug), { recursive: true });
    fs.writeFileSync(
      path.join(projectsDir, slug, "project.json"),
      JSON.stringify({ version: 1, slug, name: `Name of ${slug}`, template: "coding", cwd }),
    );
    fs.writeFileSync(path.join(projectsDir, slug, "items.json"), JSON.stringify({ version: 1, items: [] }));
  }
  const spawns = []; // {cwd, child, args}
  const events = [];
  const live = [];
  const hub = new PmHub({
    projectsDir,
    broadcast: (e) => events.push(e),
    broadcastLive: (e) => live.push(e),
    spawnFn: (bin, args, opts) => {
      const child = new FakeChild();
      spawns.push({ cwd: opts.cwd, child, args });
      return child;
    },
  });
  return { hub, spawns, events, live, projectsDir, root };
}

const spawnIn = (spawns, slug) => spawns.find((s) => s.cwd.endsWith(path.join("repos", slug)));

test("list(): every project on disk shows up as an idle PM, even before anyone spoke to it", () => {
  const { hub } = setup();
  const pms = hub.list();
  assert.deepEqual(pms.map((p) => [p.slug, p.state, p.queued, p.unread]), [
    ["acme-web", "idle", 0, 0],
    ["demo-app", "idle", 0, 0],
  ]);
  assert.equal(pms[0].name, "Name of acme-web");
  hub.dispose();
});

test("two projects run their PM at the same time, each in its own repo, replies go to the right asker", () => {
  const { hub, spawns } = setup();
  const replies = [];
  assert.equal(hub.ask("demo-app", "status?", { onReply: (r) => replies.push(["demo-app", r.text]) }).accepted, true);
  assert.equal(hub.ask("acme-web", "and you?", { onReply: (r) => replies.push(["acme-web", r.text]) }).accepted, true);

  assert.equal(spawns.length, 2);
  assert.notEqual(spawns[0].cwd, spawns[1].cwd); // each PM lives in its own project's cwd
  assert.deepEqual(
    hub.list().map((p) => [p.slug, p.state]),
    [["acme-web", "working"], ["demo-app", "working"]],
  );

  // acme-web's PM answers first even though it was asked second
  const acme = spawnIn(spawns, "acme-web").child;
  const demo = spawnIn(spawns, "demo-app").child;
  acme.init("s-acme"); acme.say("acme is green"); acme.finish("s-acme");
  assert.deepEqual(replies, [["acme-web", "acme is green"]]);
  assert.equal(hub.list().find((p) => p.slug === "demo-app").state, "working");

  demo.init("s-demo"); demo.say("demo is red"); demo.finish("s-demo");
  assert.deepEqual(replies, [["acme-web", "acme is green"], ["demo-app", "demo is red"]]);
  assert.deepEqual(hub.list().map((p) => p.state), ["idle", "idle"]);
  hub.dispose();
});

test("inside one project messages queue and run one after another on the same warm process", () => {
  const { hub, spawns } = setup(["demo-app"]);
  const replies = [];
  const r1 = hub.ask("demo-app", "first", { onReply: (r) => replies.push(r.text) });
  const r2 = hub.ask("demo-app", "second", { onReply: (r) => replies.push(r.text) });
  assert.equal(r1.accepted, true);
  assert.equal(r1.queued, undefined);
  assert.equal(r2.accepted, true);
  assert.equal(r2.queued, 1); // position in the queue
  assert.equal(hub.list()[0].queued, 1);

  const { child } = spawns[0];
  assert.deepEqual(child.asked(), ["first"]); // the second one has not reached the PM yet
  child.init("s1"); child.say("one"); child.finish("s1");
  assert.deepEqual(child.asked(), ["first", "second"]); // drained automatically
  assert.equal(spawns.length, 1); // same warm process
  child.say("two"); child.finish("s1");
  assert.deepEqual(replies, ["one", "two"]);
  assert.equal(hub.list()[0].queued, 0);
  hub.dispose();
});

test("queue is capped so one chatty channel cannot pile up unbounded PM turns", () => {
  const { hub } = setup(["demo-app"]);
  hub.ask("demo-app", "0", {});
  const results = [];
  for (let i = 1; i <= 8; i += 1) results.push(hub.ask("demo-app", String(i), {}));
  assert.equal(results.filter((r) => r.accepted).length, 5); // MAX_QUEUE
  assert.equal(results.at(-1).accepted, false);
  assert.equal(results.at(-1).reason, "queue_full");
  hub.dispose();
});

test("unknown project is refused without spawning anything", () => {
  const { hub, spawns } = setup();
  const r = hub.ask("nope", "hi", {});
  assert.deepEqual([r.accepted, r.reason], [false, "unknown_project"]);
  assert.equal(spawns.length, 0);
  hub.dispose();
});

test("speaker is prefixed so a PM shared by several people knows who is talking", () => {
  const { hub, spawns } = setup(["demo-app"]);
  hub.ask("demo-app", "ship it?", { speaker: "Binh (manager, telegram)" });
  assert.deepEqual(spawns[0].child.asked(), ["[Binh (manager, telegram)] ship it?"]);
  hub.dispose();
});

test("events: pm_message is buffered per project with unique ids; pm_status goes to live-only", () => {
  const { hub, spawns, events, live } = setup();
  hub.ask("demo-app", "a", {});
  hub.ask("acme-web", "b", {});
  for (const s of spawns) { s.child.init("sid-" + path.basename(s.cwd)); s.child.say("hi"); s.child.finish("sid-" + path.basename(s.cwd)); }

  const msgs = events.filter((e) => e.type === "pm_message");
  assert.ok(msgs.length >= 6); // user echo + assistant + done, twice
  assert.equal(new Set(msgs.map((e) => e.id)).size, msgs.length); // no id collision between the two PMs
  assert.deepEqual([...new Set(msgs.map((e) => e.sessionId))].sort(), ["pm:acme-web", "pm:demo-app"]);
  assert.ok(msgs.every((e) => e.meta.project === "demo-app" || e.meta.project === "acme-web"));
  assert.ok(msgs.every((e) => e.status !== "error")); // notifier would raise a bogus "agent stuck" otherwise

  const statuses = live.filter((e) => e.type === "pm_status");
  assert.ok(statuses.length >= 4);
  assert.deepEqual(statuses.at(-1).meta.state, "idle");
  assert.equal(events.some((e) => e.type === "pm_status"), false); // never buffered for replay
  hub.dispose();
});

test("unread counts finished replies until markRead", () => {
  const { hub, spawns } = setup(["demo-app"]);
  hub.ask("demo-app", "a", {});
  spawns[0].child.init("s"); spawns[0].child.say("x"); spawns[0].child.finish("s");
  hub.ask("demo-app", "b", {});
  spawns[0].child.say("y"); spawns[0].child.finish("s");
  assert.equal(hub.list()[0].unread, 2);
  hub.markRead("demo-app");
  assert.equal(hub.list()[0].unread, 0);
  hub.dispose();
});

test("a failing turn reports the error to the asker, frees the PM and lets the queue continue", () => {
  const { hub, spawns } = setup(["demo-app"]);
  const got = [];
  hub.ask("demo-app", "one", { onReply: (r) => got.push(["one", r.error === true]) });
  hub.ask("demo-app", "two", { onReply: (r) => got.push(["two", r.error === true]) });
  const { child } = spawns[0];
  child.init("s");
  child.finish("s", { is_error: true, result: "boom" });
  assert.deepEqual(got, [["one", true]]);
  assert.equal(child.asked().length, 2); // "two" was started
  child.say("fine"); child.finish("s");
  assert.deepEqual(got, [["one", true], ["two", false]]);
  assert.equal(hub.list()[0].lastError, null); // last turn was fine
  hub.dispose();
});

test("stop() cancels the running turn and drops what was queued behind it", () => {
  const { hub, spawns } = setup(["demo-app"]);
  const got = [];
  hub.ask("demo-app", "long", { onReply: (r) => got.push(r.error) });
  hub.ask("demo-app", "later", { onReply: (r) => got.push(["later", r.error, r.text]) });
  assert.equal(hub.stop("demo-app").stopped, true);
  assert.equal(hub.list()[0].queued, 0);
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    // the queued asker is told it was cancelled (and its message never reached the PM)
    assert.ok(got.some((g) => Array.isArray(g) && g[0] === "later" && g[1] === true && /Cancelled/.test(g[2])));
    assert.equal(spawns[0].child.asked().length, 1);
    hub.dispose();
  });
});

test("session id is kept per project under the project's own folder", () => {
  const { hub, spawns, projectsDir } = setup(["demo-app"]);
  hub.ask("demo-app", "a", {});
  spawns[0].child.init("sess-1");
  const saved = JSON.parse(fs.readFileSync(path.join(projectsDir, "demo-app", "pm-session.json"), "utf8"));
  assert.equal(saved.repos["demo-app"].sessionId, "sess-1");
  hub.dispose();
});

test("project PM prompt names the project and says how members address it", () => {
  const { hub, spawns } = setup(["demo-app"]);
  hub.ask("demo-app", "a", {});
  const args = spawns[0].args;
  const prompt = args[args.indexOf("--append-system-prompt") + 1];
  assert.match(prompt, /Name of demo-app/);
  assert.match(prompt, /goals\.md/);
  assert.match(prompt, /\[Name\]/); // speaker-prefix convention
  hub.dispose();
});
