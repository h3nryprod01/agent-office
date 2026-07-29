import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { EventBroadcastServer } from "../src/ws-server.js";

function mkEvent(sessionId, ts, overrides = {}) {
  return {
    v: 1,
    id: `${sessionId}-${ts}`,
    type: "tool_call",
    sessionId,
    ts,
    tool: "Bash",
    detail: `event ${ts}`,
    ...overrides,
  };
}

async function baseUrl(srv) {
  const { port } = srv.server.address();
  return `http://127.0.0.1:${port}`;
}

async function transcript(srv, params = "") {
  const res = await fetch(`${await baseUrl(srv)}/transcript${params}`);
  return res.json();
}

test("noisy session does not crowd out a quiet session's transcript", async () => {
  const srv = new EventBroadcastServer({ port: 0 });
  await srv.start();
  try {
    for (let i = 0; i < 150; i++) {
      srv.broadcast(mkEvent("noisy", 1000 + i));
    }
    for (let i = 0; i < 5; i++) {
      srv.broadcast(mkEvent("quiet", 2000 + i));
    }
    const lines = await transcript(srv, "?sessionId=quiet&limit=50");
    assert.equal(lines.length, 5);
  } finally {
    await srv.stop();
  }
});

test("per-session cap keeps only the most recent perSessionLimit events", async () => {
  const srv = new EventBroadcastServer({ port: 0, perSessionLimit: 5 });
  await srv.start();
  try {
    for (let i = 0; i < 12; i++) {
      srv.broadcast(mkEvent("s1", 1000 + i));
    }
    const lines = await transcript(srv, "?sessionId=s1&limit=50");
    assert.equal(lines.length, 5);
    assert.equal(lines[0].ts, 1007); // last 5 of 1000..1011
    assert.equal(lines[4].ts, 1011);
  } finally {
    await srv.stop();
  }
});

test("session-count cap evicts the least-recently-updated session entirely", async () => {
  const srv = new EventBroadcastServer({ port: 0, maxSessions: 3 });
  await srv.start();
  try {
    srv.broadcast(mkEvent("a", 1000));
    srv.broadcast(mkEvent("b", 1001));
    srv.broadcast(mkEvent("c", 1002));
    // touch b and c again so "a" becomes the least-recently-updated
    srv.broadcast(mkEvent("b", 1003));
    srv.broadcast(mkEvent("c", 1004));
    // a new 4th session should evict "a"
    srv.broadcast(mkEvent("d", 1005));

    assert.deepEqual(await transcript(srv, "?sessionId=a&limit=50"), []);
    const bLines = await transcript(srv, "?sessionId=b&limit=50");
    const dLines = await transcript(srv, "?sessionId=d&limit=50");
    assert.equal(bLines.length, 2);
    assert.equal(dLines.length, 1);
  } finally {
    await srv.stop();
  }
});

test("a newly-connecting WS client replays events from multiple sessions in ts order", async () => {
  const srv = new EventBroadcastServer({ port: 0 });
  await srv.start();
  try {
    srv.broadcast(mkEvent("a", 3000));
    srv.broadcast(mkEvent("b", 1000));
    srv.broadcast(mkEvent("a", 2000));

    const { port } = srv.server.address();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const received = await new Promise((resolve, reject) => {
      const events = [];
      ws.on("message", (data) => {
        events.push(JSON.parse(data.toString()));
        if (events.length === 3) resolve(events);
      });
      ws.on("error", reject);
    });
    ws.close();

    assert.deepEqual(
      received.map((e) => e.ts),
      [1000, 2000, 3000],
    );
  } finally {
    await srv.stop();
  }
});

test("/transcript with no sessionId spans multiple sessions; unknown routes 404", async () => {
  const srv = new EventBroadcastServer({ port: 0 });
  await srv.start();
  try {
    srv.broadcast(mkEvent("a", 1000));
    srv.broadcast(mkEvent("b", 1001));

    const lines = await transcript(srv, "?limit=50");
    const sessionIds = new Set(lines.map((l) => l.text));
    assert.equal(lines.length, 2);
    assert.ok(sessionIds.size > 0);

    const res = await fetch(`${await baseUrl(srv)}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await srv.stop();
  }
});
