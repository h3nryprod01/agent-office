// One-off manual test client: connects to the daemon's WebSocket, prints
// every normalized event it receives for a few seconds, then exits. Used to
// verify end-to-end wiring (tail -> normalize -> broadcast -> client).
//
// Usage: node scripts/test-client.mjs [ws://127.0.0.1:8787] [durationMs]

import WebSocket from "ws";

const url = process.argv[2] ?? "ws://127.0.0.1:8787";
const durationMs = Number(process.argv[3] ?? 5000);
const ws = new WebSocket(url);

let count = 0;
const startedAt = Date.now();

ws.on("open", () => {
  console.log(`[test-client] connected to ${url}`);
});

ws.on("message", (data) => {
  count++;
  const event = JSON.parse(data.toString());
  console.log(
    `[${count}] ${event.type} ${event.tool ?? ""} ${event.status ?? ""} | ${event.agent} | ${event.detail.slice(0, 60)}`
  );
});

ws.on("error", (err) => {
  console.error("[test-client] error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log(`[test-client] received ${count} events in ${Date.now() - startedAt}ms, closing`);
  ws.close();
  process.exit(0);
}, durationMs);
