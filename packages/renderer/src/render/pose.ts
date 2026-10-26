/**
 * Character poses as pure maths — no THREE, so it stays unit-testable.
 *
 * Office3D asks `poseModeFor` what an agent should be doing, keeps one
 * `PoseBlend` per character, and each frame applies `blendedAngles` to the
 * robot's joints. Changing mode cross-fades over BLEND_S instead of snapping,
 * and sitting down / standing up is a continuous 0..1 value.
 *
 * Joint conventions (the robot faces +z):
 *   arm.x   0 = hanging, negative = swung forward/up
 *   arm.z   0 = hanging, positive on the +x arm / negative on the -x arm = raised outward
 *   leg.x   0 = straight down, negative = lifted forward (sitting = ~ -1.35)
 *   lean    whole-torso pitch, positive = forward
 */

import type { AgentStatus } from "../../../protocol/src/events";
import type { StationId } from "../sim/model";

export type PoseMode = "stand" | "walk" | "type" | "read" | "play" | "wave" | "talk" | "slump" | "cheer" | "rest";

export interface PoseAngles {
  armLx: number; armLz: number;
  armRx: number; armRz: number;
  lean: number;
  headPitch: number; headRoll: number;
  /** vertical bounce added to the body (walk steps, cheering) */
  bob: number;
  /** hip swing amplitude for the walk cycle (0 = legs stay put) */
  legSwing: number;
}

/** seconds a mode change takes to settle */
export const BLEND_S = 0.22;
/** seconds to sit down or stand up */
export const SIT_S = 0.3;
/** leg angle when seated */
export const SIT_LEG = -1.35;

export interface PoseBlend {
  mode: PoseMode;
  prev: PoseMode;
  /** 0 = still fully in `prev`, 1 = fully in `mode` */
  w: number;
  /** 0 = standing, 1 = seated */
  sit: number;
}

export const initialBlend = (mode: PoseMode = "stand"): PoseBlend => ({ mode, prev: mode, w: 1, sit: 0 });

/** What an agent should be doing. `seated` = it has reached its own desk. */
export function poseModeFor(status: AgentStatus, station: StationId, moving: boolean, seated: boolean): PoseMode {
  if (moving) return "walk";
  switch (status) {
    case "waiting_permission":
    case "blocked":
      return "wave"; // hand up: "I need you"
    case "error":
      return "slump";
    case "done":
      return "cheer";
    case "reading":
      return "read";
    case "running_command":
      return "play";
    case "idle":
      return station === "meeting" ? "talk" : "rest";
    default: // working
      if (station === "meeting") return "talk";
      return seated ? "type" : "stand";
  }
}

const REST: PoseAngles = { armLx: 0, armLz: 0, armRx: 0, armRz: 0, lean: 0, headPitch: 0, headRoll: 0, bob: 0, legSwing: 0 };
const s = Math.sin;

/** the raw pose for one mode at time `t` seconds; `phase` is the walk-cycle phase */
export function anglesFor(mode: PoseMode, t: number, phase: number, speed01: number, seed = 0): PoseAngles {
  const ts = t + seed; // desynchronise neighbours so the room never moves in unison
  switch (mode) {
    case "walk": {
      const sw = s(phase) * 0.75 * speed01;
      return { ...REST, armLx: -sw, armRx: sw, armLz: -0.06, armRz: 0.06, lean: 0.07 * speed01, bob: Math.abs(s(phase)) * 0.08 * speed01, legSwing: 0.55 * speed01 };
    }
    case "type": {
      // a human rhythm: ~1.1s burst, ~0.5s pause (same as render/anim.typingRhythm)
      const active = ts % 1.6 < 1.1 ? 1 : 0.12;
      return { ...REST, armLx: -1.22 + s(ts * 20) * 0.15 * active, armRx: -1.22 + s(ts * 20 + Math.PI) * 0.15 * active, armLz: 0.1, armRz: -0.1, lean: 0.08, headPitch: 0.14 + s(ts * 0.9) * 0.03 };
    }
    case "read":
      return { ...REST, armLx: -0.95, armRx: -0.95, armLz: 0.32, armRz: -0.32, lean: 0.05, headPitch: 0.3 + s(ts * 1.1) * 0.05, headRoll: s(ts * 0.6) * 0.04 };
    case "play": // the arcade: both hands busy, one on the stick
      return { ...REST, armLx: -0.85 + s(ts * 9) * 0.2, armRx: -1.0 + s(ts * 11 + 1) * 0.18, armLz: 0.12, armRz: -0.12, lean: 0.1, headPitch: -0.06, bob: Math.abs(s(ts * 9)) * 0.02 };
    case "wave":
      return { ...REST, armRx: -0.25, armRz: 2.55 + s(ts * 7) * 0.32, armLz: -0.05, headPitch: -0.12, bob: 0.02 + Math.abs(s(ts * 3.5)) * 0.03 };
    case "talk":
      return { ...REST, armRx: -0.8 + s(ts * 3) * 0.5, armRz: 0.35, armLx: -0.3 + s(ts * 2.2 + 2) * 0.25, armLz: -0.1, headRoll: s(ts * 2) * 0.07, headPitch: s(ts * 1.3) * 0.06 };
    case "slump":
      return { ...REST, armLx: 0.2, armRx: 0.2, lean: 0.34, headPitch: 0.6, headRoll: 0.05 };
    case "cheer":
      return { ...REST, armLz: -2.35 + s(ts * 6) * 0.14, armRz: 2.35 + s(ts * 6 + 1) * 0.14, bob: Math.abs(s(ts * 4.5)) * 0.09, headPitch: -0.1 };
    case "rest": // idle: breathing, a slow glance
      return { ...REST, armLz: -0.07, armRz: 0.07, armLx: s(ts * 1.4) * 0.03, armRx: s(ts * 1.4 + 1) * 0.03, headRoll: s(ts * 0.5) * 0.05, bob: (s(ts * 1.6) * 0.5 + 0.5) * 0.015 };
    default:
      return { ...REST, armLz: -0.06, armRz: 0.06, headPitch: s(ts * 0.8) * 0.02 };
  }
}

/** Advance the blend by `dt` seconds towards `mode` and `seated`. Returns a new value. */
export function advanceBlend(b: PoseBlend, mode: PoseMode, seated: boolean, dt: number): PoseBlend {
  const changed = mode !== b.mode;
  // a mode change mid-blend starts from wherever the blend had got to; showing the
  // OLD target would visibly snap, so the half-finished pose becomes the new `prev`
  const prev = changed ? (b.w < 0.5 ? b.prev : b.mode) : b.prev;
  const w = changed ? 0 : Math.min(1, b.w + dt / BLEND_S);
  const goal = seated ? 1 : 0;
  const step = dt / SIT_S;
  const sit = b.sit < goal ? Math.min(goal, b.sit + step) : Math.max(goal, b.sit - step);
  return { mode, prev, w, sit };
}

const mix = (a: number, b: number, k: number): number => a + (b - a) * k;
const ease = (k: number): number => k * k * (3 - 2 * k);

/** the joint angles to apply this frame */
export function blendedAngles(b: PoseBlend, t: number, phase: number, speed01: number, seed = 0): PoseAngles {
  const cur = anglesFor(b.mode, t, phase, speed01, seed);
  if (b.w >= 1 || b.prev === b.mode) return cur;
  const old = anglesFor(b.prev, t, phase, speed01, seed);
  const k = ease(b.w);
  return {
    armLx: mix(old.armLx, cur.armLx, k), armLz: mix(old.armLz, cur.armLz, k),
    armRx: mix(old.armRx, cur.armRx, k), armRz: mix(old.armRz, cur.armRz, k),
    lean: mix(old.lean, cur.lean, k), headPitch: mix(old.headPitch, cur.headPitch, k),
    headRoll: mix(old.headRoll, cur.headRoll, k), bob: mix(old.bob, cur.bob, k),
    legSwing: mix(old.legSwing, cur.legSwing, k),
  };
}

// ── walking ─────────────────────────────────────────────────────────────────
// Smooth locomotion: accelerate from rest, brake into the target, turn instead of
// snapping. All pure so the feel can be pinned by tests.

/** u/s² — from standstill to MOVE in ~0.2s */
export const ACCEL = 42;

/**
 * The speed to travel at this frame: ramps up by ACCEL, but never faster than
 * lets it stop at the target (v² = 2·a·d), so it brakes instead of stopping dead.
 */
export function stepSpeed(speed: number, top: number, dist: number, dt: number): number {
  const brake = Math.sqrt(Math.max(0, 2 * ACCEL * dist));
  return Math.max(0, Math.min(speed + ACCEL * dt, top, brake));
}

/** shortest signed angle from `a` to `b`, in (-π, π] */
export function angleDelta(a: number, b: number): number {
  const d = (((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return d === -Math.PI ? Math.PI : d;
}

/** turn `yaw` towards `goal` at most `rate` rad/s, by the short way round */
export function turnToward(yaw: number, goal: number, rate: number, dt: number): number {
  const d = angleDelta(yaw, goal);
  const max = rate * dt;
  return yaw + Math.max(-max, Math.min(max, d));
}
