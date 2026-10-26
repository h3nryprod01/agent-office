// lane L5: a tiny JSON key-value file for channel state that must survive a restart
// (which project a DM is "in", which day's digest already went out). One file, whole-object
// rewrite via tmp + rename. Not for anything big or contended.

import fs from "node:fs";
import path from "node:path";

export class JsonState {
  /** @param {string|null} file  null = in-memory only (tests, or no writable home) */
  constructor(file) {
    this.file = file;
    this.data = {};
    if (!file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.data = parsed;
    } catch {
      // missing or corrupt — start empty; the next set() rewrites it
    }
  }

  get(key, fallback = undefined) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data = { ...this.data, [key]: value };
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch {
      // best-effort: losing this only means a user re-picks a project after a restart
    }
  }
}
