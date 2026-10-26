// What an agent looks like, decided from the shared agent contract:
//   agent.harness  claude | codex | gemini | claude-worker | hermes
//   agent.lane     optional, e.g. "deepseek" (worker lanes)
//   agent.persona  optional { name, role, avatar, voice, tone }
//
// harness is on AgentModel today; lane and persona arrive from the L3 (multi-
// vendor) and L6 (persona) lanes. They are read structurally, so this file needs
// no change to sim/model.ts and an agent that has none of them looks exactly as
// it always did.
//
// Pure data, no THREE: Office3D builds the meshes, the tests pin the mapping.

import type { AgentModel } from "../sim/model";
import type { Skin } from "./robotKit";

export type HarnessFamily = "claude" | "codex" | "gemini" | "claude-worker" | "hermes" | "unknown";
export type Accessory = "none" | "antenna" | "sparks" | "hardhat" | "wings";

export interface Persona {
  name?: string;
  role?: string;
  /** an emoji / short text, or an image URL (same origin, data: or https:) */
  avatar?: string;
  voice?: string;
  tone?: string;
}

export interface AgentLook {
  family: HarnessFamily;
  lane: string | null;
  /** null = keep the agent's usual per-name skin (Claude agents stay varied) */
  skin: Skin | null;
  accessory: Accessory;
  /** colour of the accessory and of the chest badge */
  trim: number;
  /** one letter or symbol for the chest badge when there is no persona avatar */
  glyph: string;
  persona: Persona | null;
}

/** Accepts the daemon's raw ids ("claude-code") and the contract's ("claude"). */
export function harnessFamily(h: string | null | undefined): HarnessFamily {
  const v = (h ?? "").trim().toLowerCase();
  if (!v) return "unknown";
  if (v === "claude" || v === "claude-code") return "claude";
  if (v === "codex") return "codex";
  if (v === "gemini") return "gemini";
  if (v === "claude-worker" || v === "worker") return "claude-worker";
  if (v === "hermes") return "hermes";
  return "unknown";
}

/** brand-ish hue per worker lane, so a glance at the hard hat says which vendor */
export const LANE_COLORS: Record<string, number> = {
  deepseek: 0x3d6bff,
  mimo: 0xff7a1a,
  glm: 0x2fd27a,
  kimi: 0xb26bff,
};
const LANE_FALLBACK = 0xc9a66b;

/** blend towards white — keeps a skin's lit face bright enough for the dark face ink */
function lighten(hex: number, k: number): number {
  const ch = (s: number): number => Math.round(((hex >> s) & 255) * (1 - k) + 255 * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

const FAMILY_SKINS: Record<"codex" | "gemini" | "hermes", Skin> = {
  codex: { id: "codex", name: "Codex", body: 0xcfd6e2, accent: 0x8f9bb3, screen: 0xd6ecff },
  gemini: { id: "gemini", name: "Gemini", body: 0x1c2040, accent: 0x7aa6ff, screen: 0xbcd0ff },
  hermes: { id: "hermes", name: "Hermes", body: 0x2e2612, accent: 0xffc83d, screen: 0xffe49a },
};

function laneSkin(lane: string | null): Skin {
  const accent = (lane && LANE_COLORS[lane]) || LANE_FALLBACK;
  return { id: `worker-${lane ?? "x"}`, name: lane ?? "Worker", body: 0x232a38, accent, screen: lighten(accent, 0.6) };
}

/**
 * The persona comes from another lane's data (roster files people edit by hand),
 * so it is untrusted: keep only string fields. A number where a string belongs would
 * otherwise throw inside the render loop and freeze the office.
 */
function asPersona(v: unknown): Persona | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  return { name: str("name"), role: str("role"), avatar: str("avatar"), voice: str("voice"), tone: str("tone") };
}

export function lookOf(agent: AgentModel): AgentLook {
  const loose = agent as AgentModel & { lane?: string | null; persona?: unknown };
  const family = harnessFamily(agent.harness);
  const lane = typeof loose.lane === "string" && loose.lane ? loose.lane.toLowerCase() : null;
  const persona = asPersona(loose.persona);
  switch (family) {
    case "codex":
      return { family, lane, persona, skin: FAMILY_SKINS.codex, accessory: "antenna", trim: 0xd6ecff, glyph: "</>" };
    case "gemini":
      return { family, lane, persona, skin: FAMILY_SKINS.gemini, accessory: "sparks", trim: 0x9ec0ff, glyph: "✦" };
    case "hermes":
      return { family, lane, persona, skin: FAMILY_SKINS.hermes, accessory: "wings", trim: 0xffc83d, glyph: "H" };
    case "claude-worker": {
      const s = laneSkin(lane);
      return { family, lane, persona, skin: s, accessory: "hardhat", trim: s.accent, glyph: (lane ?? "w")[0].toUpperCase() };
    }
    case "claude":
      return { family, lane, persona, skin: null, accessory: "none", trim: 0xff8a65, glyph: "✳" };
    default:
      return { family, lane, persona, skin: null, accessory: "none", trim: 0x7f8aa0, glyph: "" };
  }
}

/** What to print on the name tag: the persona's name wins over the raw agent name. */
export function displayName(agent: AgentModel): string {
  const p = asPersona((agent as AgentModel & { persona?: unknown }).persona);
  return (p?.name && p.name.trim()) || agent.name;
}

/**
 * Is this avatar string an image to load (vs text to draw)? Only inline data or a
 * same-origin path: fetching from any https host would tell that host who is
 * watching the office (on-prem tool — avatars belong on the daemon, not the web).
 */
export function avatarIsImage(avatar: string): boolean {
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(avatar)) return true;
  // a root-relative path; "//host" and "/\host" are protocol-relative = another host
  return /^\/(?![\/\\])[^\s\\]*\.(png|jpe?g|gif|webp)(\?[^\s]*)?$/i.test(avatar);
}

// ── mock mode ────────────────────────────────────────────────────────────────
// ?mock=1 has no daemon, so agents carry no harness/lane/persona. To SEE the
// uniforms the demo hands out a deterministic spread — only to agents that have
// none, and only in mock mode, so real data is never overwritten.

const DEMO_HARNESSES = ["claude", "claude", "codex", "claude-worker", "gemini", "claude-worker", "hermes", "claude-worker"];
const DEMO_LANES = ["deepseek", "mimo", "glm", "kimi"];
const DEMO_AVATARS = ["🦊", "🐼", "🦉", "🐙", "🦄"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** A copy of `a` with a deterministic fake harness / lane / persona when it has none. */
export function withDemoLook(a: AgentModel): AgentModel {
  if (a.harness) return a;
  const h = hash(a.agentId);
  const harness = DEMO_HARNESSES[h % DEMO_HARNESSES.length];
  const demo: AgentModel & { lane?: string; persona?: Persona } = { ...a, harness };
  const has = a as AgentModel & { lane?: unknown; persona?: unknown };
  if (harness === "claude-worker" && !has.lane) demo.lane = DEMO_LANES[(h >> 3) % DEMO_LANES.length];
  if (h % 5 === 0 && !has.persona) demo.persona = { name: a.name, avatar: DEMO_AVATARS[(h >> 2) % DEMO_AVATARS.length] };
  return demo;
}
