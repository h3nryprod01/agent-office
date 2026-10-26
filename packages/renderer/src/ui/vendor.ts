// Which vendor is behind an agent: one dot + label per harness / worker lane.
// Pure data + string builders so they unit-test without a browser. This is the
// minimal marker lane L3 owns (side panel, Spend table); the office drawing —
// uniforms per vendor — belongs to the visual lane and can reuse `vendorOf`.

export interface Vendor {
  key: string;
  label: string;
  color: string;
}

const HARNESS: Record<string, Vendor> = {
  "claude-code": { key: "claude", label: "Claude", color: "#d97757" },
  codex: { key: "codex", label: "Codex", color: "#10a37f" },
  gemini: { key: "gemini", label: "Gemini", color: "#4285f4" },
  hermes: { key: "hermes", label: "Hermes", color: "#a78bfa" },
};

// Worker lanes: Claude Code driving another vendor's model.
const LANE: Record<string, Vendor> = {
  deepseek: { key: "deepseek", label: "DeepSeek", color: "#4d6bfe" },
  mimo: { key: "mimo", label: "MiMo", color: "#ff6900" },
  glm: { key: "glm", label: "GLM", color: "#2dd4bf" },
  kimi: { key: "kimi", label: "Kimi", color: "#e5e7eb" },
};
const WORKER_FALLBACK: Vendor = { key: "worker", label: "Worker", color: "#94a3b8" };
const OTHER_LANE_COLOR = "#94a3b8";

export function vendorOf(harness: string | null | undefined, lane: string | null | undefined): Vendor | null {
  if (!harness) return null;
  // a non-Anthropic model (lane) wins over the harness, whichever Claude config dir it ran from
  if (lane && (harness === "claude-worker" || harness === "claude-code")) {
    return LANE[lane] ?? { key: lane, label: lane, color: OTHER_LANE_COLOR };
  }
  if (harness === "claude-worker") return WORKER_FALLBACK;
  return HARNESS[harness] ?? { key: harness, label: harness, color: OTHER_LANE_COLOR };
}

/** Coloured dot + vendor name, "" when the harness is unknown. */
export function vendorBadgeHtml(harness: string | null | undefined, lane: string | null | undefined): string {
  const v = vendorOf(harness, lane);
  if (!v) return "";
  return `<span class="vendor-badge" style="--vc:${v.color}"><i class="vendor-dot"></i>${esc(v.label)}</span>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
