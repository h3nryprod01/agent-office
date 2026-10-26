// Day-night cycle for the office: the real clock in, a lighting recipe out.
//
// Pure maths, no THREE: Office3D applies the numbers, and the tests pin the
// behaviour (rAF/WebGL can't run in a test environment).
//
// Design rules:
//  - The office stays READABLE at any hour. The darkest point of the cycle is a
//    moonlit room, not a black one — the deliberate "Lights off" cinematic mode
//    (Office3D.setNight) is still darker than the darkest natural hour.
//  - The void around the floor plate is dark in the day too (the app chrome is a
//    dark theme); the cycle tints it rather than painting a bright sky.

export interface Daylight {
  /** hour of day this was computed for, [0, 24) */
  hour: number;
  sunColor: number;
  sunIntensity: number;
  /** key-light position; the sun swings east→west, the moon sits opposite */
  sunPos: readonly [number, number, number];
  ambientColor: number;
  ambientIntensity: number;
  fillIntensity: number;
  /** gradient behind the floor plate: top of screen / bottom of screen */
  skyTop: number;
  skyBottom: number;
  /** what a window shows: brighter than the void, a real sky by day */
  paneTop: number;
  paneBottom: number;
  /** 0 = broad daylight, 1 = deep night — drives lamps, stars, window glow */
  night: number;
}

interface Key {
  h: number;
  sunI: number; sun: number; ambI: number; amb: number; top: number; bot: number; night: number;
  pt: number; pb: number;
}

// Keyframes around the clock. The table wraps: 24 == 0.
const KEYS: readonly Key[] = [
  { h: 0,    sunI: 0.30, sun: 0x86a0ff, ambI: 0.32, amb: 0x6f86cc, top: 0x04070d, bot: 0x0a111e, pt: 0x0b1426, pb: 0x16213a, night: 1 },
  { h: 5,    sunI: 0.30, sun: 0x86a0ff, ambI: 0.32, amb: 0x6f86cc, top: 0x05080f, bot: 0x0d1424, pt: 0x0d1730, pb: 0x22305a, night: 1 },
  { h: 6.5,  sunI: 0.75, sun: 0xff9d5c, ambI: 0.40, amb: 0xffcfa8, top: 0x15203a, bot: 0x58404c, pt: 0x5a6fa8, pb: 0xffb27a, night: 0.45 },
  { h: 8.5,  sunI: 1.10, sun: 0xffe0bc, ambI: 0.50, amb: 0xcdd9ff, top: 0x0d1522, bot: 0x1b2840, pt: 0x6fa9e0, pb: 0xc6e2f5, night: 0.05 },
  { h: 12,   sunI: 1.20, sun: 0xfff0d8, ambI: 0.55, amb: 0xbcd0ff, top: 0x0d1117, bot: 0x162030, pt: 0x5ea6e8, pb: 0xcfe8f8, night: 0 },
  { h: 15.5, sunI: 1.12, sun: 0xffe8c4, ambI: 0.52, amb: 0xc4d3ff, top: 0x0d1319, bot: 0x1a2536, pt: 0x6aa8e2, pb: 0xd2e6f2, night: 0.05 },
  { h: 17.5, sunI: 0.80, sun: 0xffa968, ambI: 0.42, amb: 0xffc9a0, top: 0x1a1a33, bot: 0x6a3f45, pt: 0x5a5fa0, pb: 0xff9a5c, night: 0.45 },
  { h: 19,   sunI: 0.42, sun: 0x9a86d8, ambI: 0.34, amb: 0x8d98dc, top: 0x0b0e1e, bot: 0x27243e, pt: 0x262c5e, pb: 0x7a5a86, night: 0.8 },
  { h: 20.5, sunI: 0.30, sun: 0x86a0ff, ambI: 0.32, amb: 0x6f86cc, top: 0x04070d, bot: 0x0a111e, pt: 0x0b1426, pb: 0x16213a, night: 1 },
  { h: 24,   sunI: 0.30, sun: 0x86a0ff, ambI: 0.32, amb: 0x6f86cc, top: 0x04070d, bot: 0x0a111e, pt: 0x0b1426, pb: 0x16213a, night: 1 },
];

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
export function lerpHex(a: number, b: number, k: number): number {
  const ch = (shift: number): number => Math.round(lerp((a >> shift) & 255, (b >> shift) & 255, k));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
// smoothstep so the transitions ease in and out instead of kinking at the keys
const ease = (k: number): number => k * k * (3 - 2 * k);

/** Wall-clock hour, fractional, in the viewer's local time. */
export function hourOf(d: Date): number {
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

export function daylightAt(hourIn: number): Daylight {
  const hour = ((hourIn % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && hour >= KEYS[i + 1].h) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const k = ease((hour - a.h) / (b.h - a.h));

  // Sun arcs over 6..18; outside that the "moon" takes the same key-light slot.
  // Always on the camera's side of the room (z > 0) so faces stay lit.
  const day = hour >= 6 && hour <= 18;
  const into = day ? hour - 6 : hour >= 18 ? hour - 18 : hour + 6; // hours into this arc, 0..12
  const arc = (Math.PI * into) / 12;
  const swing = Math.cos(arc), rise = Math.sin(arc);
  const sunPos: [number, number, number] = day
    ? [16 + 18 * swing, 7 + 21 * rise, 12]
    : [-6 - 8 * swing, 14 + 8 * rise, 14];

  return {
    hour,
    sunColor: lerpHex(a.sun, b.sun, k),
    sunIntensity: lerp(a.sunI, b.sunI, k),
    sunPos,
    ambientColor: lerpHex(a.amb, b.amb, k),
    ambientIntensity: lerp(a.ambI, b.ambI, k),
    fillIntensity: lerp(0.12, 0.35, 1 - lerp(a.night, b.night, k)),
    skyTop: lerpHex(a.top, b.top, k),
    skyBottom: lerpHex(a.bot, b.bot, k),
    paneTop: lerpHex(a.pt, b.pt, k),
    paneBottom: lerpHex(a.pb, b.pb, k),
    night: lerp(a.night, b.night, k),
  };
}
