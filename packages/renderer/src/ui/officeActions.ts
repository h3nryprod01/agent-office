// What the office's props and characters do on the host machine. Every call names an agent or a
// project; the daemon picks the actual folder or file from what it saw itself (never a path).

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** Open the folder an agent works in (Finder / Explorer). */
export const revealAgentFolder = (agentId: string) => post("/reveal", { agentId });
/** Select the last file the agent wrote; falls back to its folder when the office saw no file yet. */
export async function revealAgentFile(agentId: string) {
  const res = await post("/reveal", { agentId, lastFile: true });
  return res.status === 404 ? revealAgentFolder(agentId) : res;
}
/** Open a project's own folder. */
export const revealProject = (project: string) => post("/reveal", { project });
/** A terminal in the project's folder (the arcade machine). */
export const openProjectTerminal = (project: string) => post("/sessions/open-terminal", { project });

export const MAX_DROP_BYTES = 4 * 1024 * 1024;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A file dropped on the office → <project>/inbox/<name>. Resolves to the stored path, or an error. */
export async function uploadToInbox(project: string, file: File): Promise<{ path: string } | { error: string }> {
  if (file.size > MAX_DROP_BYTES) return { error: "too-large" };
  const res = await post("/docs/upload", { project, name: file.name, data: toBase64(await file.arrayBuffer()) });
  if (res.ok && typeof res.body?.path === "string") return { path: res.body.path };
  return { error: typeof res.body?.error === "string" ? res.body.error : `HTTP ${res.status}` };
}
