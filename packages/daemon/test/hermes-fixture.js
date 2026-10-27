// Builds a synthetic Hermes state.db (column names and types copied from the
// real schema; every value invented). Not a test file: node --test only picks
// up *.test.js.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** node:sqlite needs Node >= 22.13 unflagged; older runtimes skip the Hermes tests (the daemon itself degrades gracefully). */
export const hasSqlite = await import("node:sqlite").then(() => true, () => false);

export async function makeHermesDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(path.join(os.tmpdir(), "ao-hermes-"));
  const dbPath = path.join(dir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT,
      started_at REAL NOT NULL, ended_at REAL, message_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0, estimated_cost_usd REAL, actual_cost_usd REAL,
      cost_status TEXT, title TEXT, cwd TEXT, git_repo_root TEXT, last_activity_at REAL);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL);
  `);
  const addSession = (s) =>
    db
      .prepare(
        `INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens, cache_read_tokens,
           estimated_cost_usd, actual_cost_usd, cost_status, cwd, last_activity_at)
         VALUES (@id, @source, @model, @started_at, @input_tokens, @output_tokens, @cache_read_tokens,
           @estimated_cost_usd, @actual_cost_usd, @cost_status, @cwd, @last_activity_at)`,
      )
      .run({
        source: "telegram", model: "demo-model", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
        estimated_cost_usd: null, actual_cost_usd: null, cost_status: null, cwd: null, last_activity_at: null,
        ...s,
      });
  const addMessage = (m) =>
    db
      .prepare(
        `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp)
         VALUES (@session_id, @role, @content, @tool_call_id, @tool_calls, @tool_name, @timestamp)`,
      )
      .run({ content: null, tool_call_id: null, tool_calls: null, tool_name: null, ...m });
  return { dir, dbPath, db, addSession, addMessage };
}

/** OpenAI-style tool_calls array as Hermes stores it. */
export const toolCalls = (...calls) =>
  JSON.stringify(
    calls.map(([id, name, args]) => ({
      id, call_id: id, response_item_id: `fc_${id}`, type: "function",
      function: { name, arguments: JSON.stringify(args) },
    })),
  );
