// The ❗ above an agent's head: the one thing in the room that should catch the
// eye from across it. Only states that need a human (or just ended) get a mark;
// working / reading / running already show on the face, the desk and the pose.
//
// Drawn as vector shapes (no emoji font, so it looks the same on every OS) onto
// three tiny shared textures — every agent's mark sprite reuses them.

import * as THREE from "three";
import type { AgentStatus } from "../../../protocol/src/events";

export type MarkKind = "alert" | "error" | "done";

export function markFor(status: AgentStatus | null | undefined): MarkKind | null {
  switch (status) {
    case "waiting_permission":
    case "blocked":
      return "alert";
    case "error":
      return "error";
    case "done":
      return "done";
    default:
      return null;
  }
}

/** how hard the mark pulses: alerts demand attention, "done" is a quiet tick */
export const MARK_PULSE: Record<MarkKind, number> = { alert: 0.16, error: 0.1, done: 0.03 };

const COLORS: Record<MarkKind, string> = { alert: "#ff4d4d", error: "#ff7a45", done: "#37d67a" };
const SIZE = 128;

function paint(kind: MarkKind): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const x = c.getContext("2d")!;
  const col = COLORS[kind], r = SIZE / 2;
  x.fillStyle = "rgba(10,14,22,.94)";
  x.beginPath(); x.arc(r, r, r - 6, 0, Math.PI * 2); x.fill();
  x.strokeStyle = col; x.lineWidth = 9; x.stroke();
  x.fillStyle = col; x.strokeStyle = col; x.lineCap = "round"; x.lineJoin = "round";
  if (kind === "alert") { // the exclamation mark
    x.beginPath(); x.roundRect(r - 8, 26, 16, 50, 8); x.fill();
    x.beginPath(); x.arc(r, 96, 9, 0, Math.PI * 2); x.fill();
  } else if (kind === "error") { // a cross
    x.lineWidth = 12;
    x.beginPath(); x.moveTo(r - 24, r - 24); x.lineTo(r + 24, r + 24); x.moveTo(r + 24, r - 24); x.lineTo(r - 24, r + 24); x.stroke();
  } else { // a tick
    x.lineWidth = 12;
    x.beginPath(); x.moveTo(r - 28, r + 2); x.lineTo(r - 8, r + 22); x.lineTo(r + 30, r - 22); x.stroke();
  }
  return c;
}

const mats = new Map<MarkKind, THREE.SpriteMaterial>();
/** the shared sprite material for a mark kind (created on first use) */
export function markMaterial(kind: MarkKind): THREE.SpriteMaterial {
  let m = mats.get(kind);
  if (!m) {
    m = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(paint(kind)), transparent: true, depthTest: false });
    m.userData.shared = true; // every agent's mark uses it — never dispose with one body
    mats.set(kind, m);
  }
  return m;
}
