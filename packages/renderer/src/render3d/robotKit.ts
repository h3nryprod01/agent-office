// The agent-robot designs, built from three.js primitives (no GLB).
// Shared by the showroom (/robots.html) and the office (main.ts) — same
// { inner, legs } contract, so any design drops in with no rework.
//
// Contract (asserted in test/robotKit.test.ts — measured, not assumed):
//   - every builder faces +z;
//   - designs WITH legs stand with feet at y≈0; designs with none hover above
//     y≈1 on purpose (hover, orb, cube) and glide instead of walking;
//   - `legs` holds hip pivots and is 0 or an even count — stepChar swings them
//     alternately, so a lone leg would limp forever;
//   - to be usable at a desk a design must reach past y≈2.49, the top of the
//     monitor it sits behind. Most clear it (retro is tallest at 3.04); `quad`
//     tops out at 2.16 and would be hidden by its own screen — it stays in the
//     kit as a showroom option, not a candidate for the office.
//
// Colour comes from a Skin (body / accent / screen), not a single hue, so a room
// full of agents reads as varied instead of ten shades of the same tint.

import * as THREE from "three";

export interface Skin {
  id: string;
  name: string;
  body: number;   // chassis / structure
  accent: number; // limbs + trim (glows)
  screen: number; // the lit face / lens
}
export interface Built {
  inner: THREE.Group;
  legs: THREE.Object3D[];
}
export type RobotBuilder = (skin: Skin) => Built;

/** 10 skins — 8 dark chassis + 2 light, each with a matching lit face. */
export const SKINS: Skin[] = [
  { id: "cyber", name: "Cyber", body: 0x1b2433, accent: 0x0deef3, screen: 0x18ffff },
  { id: "ember", name: "Lửa", body: 0x2b1f18, accent: 0xff9100, screen: 0xf5a623 },
  { id: "matrix", name: "Lục", body: 0x15251d, accent: 0x00e676, screen: 0x69f0ae },
  { id: "magenta", name: "Hồng tím", body: 0x241a2b, accent: 0xe040fb, screen: 0xff4081 },
  { id: "cobalt", name: "Coban", body: 0x161f33, accent: 0x448aff, screen: 0x18ffff },
  { id: "violet", name: "Tím", body: 0x1e1a33, accent: 0x7c4dff, screen: 0xb388ff },
  { id: "rose", name: "Hồng", body: 0x2b1a22, accent: 0xff4081, screen: 0xff80ab },
  { id: "mint", name: "Bạc hà", body: 0x16292a, accent: 0x69f0ae, screen: 0xa7ffeb },
  { id: "snow", name: "Trắng", body: 0xdfe6f0, accent: 0x0deef3, screen: 0x18ffff },
  { id: "sand", name: "Cát", body: 0xc9b79c, accent: 0xff9100, screen: 0xffd180 },
];

// ── materials ──
const neon = (hex: number, glow = 0.45): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: glow, roughness: 0.5 });
const matte = (hex: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8 });
const metal = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: 0x99a3b5, roughness: 0.35, metalness: 0.65 });
const lens = (hex: number): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 1.1, roughness: 0.15 });

// ── shape helpers ──
function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  return o;
}
const boxG = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cylG = (rt: number, rb: number, h: number, seg = 16) => new THREE.CylinderGeometry(rt, rb, h, seg);
const sphG = (r: number, seg = 18) => new THREE.SphereGeometry(r, seg, seg);
const capG = (r: number, h: number) => new THREE.CapsuleGeometry(r, h, 6, 14);

/** a hip pivot with a leg hanging from it (so rotation.x swings the whole leg) */
function legPivot(x: number, hipY: number, m: THREE.Material, w: number, len: number, d: number): THREE.Group {
  const p = new THREE.Group();
  p.position.set(x, hipY, 0);
  p.add(mesh(boxG(w, len, d), m, 0, -len / 2, 0));
  return p;
}
function finish(g: THREE.Group, scale: number): THREE.Group {
  g.scale.setScalar(scale);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

// ── 01. Khối vuông (blocky) — friendly voxel worker ──
const blocky: RobotBuilder = (s) => {
  const g = new THREE.Group();
  const n = neon(s.accent), b = matte(s.body);
  g.add(mesh(boxG(0.72, 0.85, 0.42), n, 0, 1.22, 0));
  g.add(mesh(boxG(0.5, 0.5, 0.5), b, 0, 1.88, 0));
  g.add(mesh(boxG(0.3, 0.07, 0.03), lens(s.screen), 0, 1.9, 0.26)); // visor
  [-0.47, 0.47].forEach((x) => g.add(mesh(boxG(0.16, 0.72, 0.22), n, x, 1.2, 0)));
  const legs = [-0.2, 0.2].map((x) => legPivot(x, 0.8, b, 0.25, 0.8, 0.27));
  legs.forEach((l) => g.add(l));
  return { inner: finish(g, 1.32), legs };
};

// ── 02. Viên nang (capsule) — soft rounded body, visor face ──
const capsule: RobotBuilder = (s) => {
  const g = new THREE.Group();
  const n = neon(s.accent), b = matte(s.body), m = metal();
  g.add(mesh(capG(0.34, 0.62), n, 0, 1.32, 0));
  g.add(mesh(sphG(0.3), b, 0, 1.95, 0));
  g.add(mesh(boxG(0.42, 0.12, 0.06), lens(s.screen), 0, 1.97, 0.26));
  [-0.44, 0.44].forEach((x) => g.add(mesh(capG(0.09, 0.42), m, x, 1.3, 0)));
  const legs = [-0.17, 0.17].map((x) => legPivot(x, 0.92, m, 0.18, 0.92, 0.2));
  legs.forEach((l) => g.add(l));
  return { inner: finish(g, 1.15), legs };
};

// ── 03. Bay lơ lửng (hover) — no legs; floats over a glowing ring ──
const hover: RobotBuilder = (s) => {
  const g = new THREE.Group();
  const n = neon(s.accent), b = matte(s.body);
  g.add(mesh(sphG(0.44), n, 0, 1.65, 0));
  g.add(mesh(boxG(0.5, 0.16, 0.12), b, 0, 1.72, 0.38));
  g.add(mesh(boxG(0.28, 0.07, 0.04), lens(s.screen), 0, 1.72, 0.45));
  g.add(mesh(new THREE.TorusGeometry(0.6, 0.06, 10, 28), lens(s.screen), 0, 1.34, 0).rotateX(Math.PI / 2));
  g.add(mesh(cylG(0.26, 0.26, 0.03), lens(s.screen), 0, 1.06, 0));
  return { inner: finish(g, 1.25), legs: [] };
};

// ── 04. Máy móc nặng (mech) — chunky industrial, shoulder pads ──
const mech: RobotBuilder = (s) => {
  const g = new THREE.Group();
  const n = neon(s.accent), b = matte(s.body), m = metal();
  g.add(mesh(boxG(0.95, 0.8, 0.6), n, 0, 1.45, 0));
  g.add(mesh(boxG(0.55, 0.36, 0.5), b, 0, 1.98, 0));
  g.add(mesh(boxG(0.36, 0.08, 0.06), lens(s.screen), 0, 2.0, 0.26));
  [-0.66, 0.66].forEach((x) => {
    g.add(mesh(boxG(0.34, 0.3, 0.5), m, x, 1.72, 0));
    g.add(mesh(boxG(0.26, 0.66, 0.28), b, x, 1.28, 0));
  });
  const legs = [-0.28, 0.28].map((x) => legPivot(x, 1.02, m, 0.36, 1.02, 0.4));
  legs.forEach((l) => g.add(l));
  return { inner: finish(g, 1.12), legs };
};

// ── 05. Người máy thon (android) — tall, slim, elegant ──
const android: RobotBuilder = (s) => {
  const g = new THREE.Group();
  const n = neon(s.accent), b = matte(s.body), m = metal();
  g.add(mesh(cylG(0.24, 0.3, 0.9, 14), n, 0, 1.5, 0));
  g.add(mesh(cylG(0.06, 0.06, 0.18), m, 0, 2.02, 0));
  g.add(mesh(capG(0.22, 0.16), b, 0, 2.24, 0));
  g.add(mesh(boxG(0.3, 0.07, 0.05), lens(s.screen), 0, 2.26, 0.2));
  [-0.36, 0.36].forEach((x) => g.add(mesh(capG(0.06, 0.6), m, x, 1.5, 0)));
  const legs = [-0.14, 0.14].map((x) => legPivot(x, 1.05, m, 0.14, 1.05, 0.16));
  legs.forEach((l) => g.add(l));
  return { inner: finish(g, 1.08), legs };
};

// ── 06. Cổ điển (retro) — 1950s tin robot: drum body, antenna, dial eyes ──
const retro: RobotBuilder = (s) => {
  const g = new THREE.Group();
  const n = neon(s.accent), m = metal(), b = matte(s.body);
  g.add(mesh(cylG(0.42, 0.46, 0.95, 18), n, 0, 1.35, 0));
  g.add(mesh(boxG(0.52, 0.46, 0.46), b, 0, 2.05, 0));
  [-0.13, 0.13].forEach((x) => g.add(mesh(sphG(0.08, 12), lens(s.screen), x, 2.08, 0.24)));
  g.add(mesh(cylG(0.02, 0.02, 0.3), m, 0, 2.42, 0));
  g.add(mesh(sphG(0.07, 12), lens(s.screen), 0, 2.6, 0));
  [-0.5, 0.5].forEach((x) => g.add(mesh(cylG(0.08, 0.08, 0.6), m, x, 1.35, 0)));
  const legs = [-0.19, 0.19].map((x) => legPivot(x, 0.88, m, 0.22, 0.88, 0.24));
  legs.forEach((l) => g.add(l));
  return { inner: finish(g, 1.14), legs };
};

// ── 07. Mắt thần (orb) — a single floating lens; pure minimal presence ──
const orb: RobotBuilder = (s) => {
  const g = new THREE.Group();
  const b = matte(s.body);
  g.add(mesh(sphG(0.5, 24), b, 0, 1.75, 0));
  g.add(mesh(sphG(0.27, 20), lens(s.screen), 0, 1.75, 0.34));
  g.add(mesh(new THREE.TorusGeometry(0.34, 0.045, 10, 26), neon(s.accent, 0.8), 0, 1.75, 0.3));
  g.add(mesh(cylG(0.28, 0.28, 0.03), lens(s.screen), 0, 1.16, 0));
  return { inner: finish(g, 1.25), legs: [] };
};

// ── 08. Bốn chân (quad) — low, animal-like crawler ──
const quad: RobotBuilder = (s) => {
  const g = new THREE.Group();
  const n = neon(s.accent), b = matte(s.body), m = metal();
  g.add(mesh(boxG(0.86, 0.46, 1.3), n, 0, 1.0, 0));
  g.add(mesh(boxG(0.5, 0.34, 0.44), b, 0, 1.06, 0.82));
  g.add(mesh(boxG(0.34, 0.08, 0.04), lens(s.screen), 0, 1.1, 1.04));
  g.add(mesh(boxG(0.1, 0.24, 0.1), m, 0, 1.32, 0.78));
  const legs: THREE.Object3D[] = [];
  ([[-0.4, 0.46], [0.4, 0.46], [-0.4, -0.46], [0.4, -0.46]] as const).forEach(([x, z]) => {
    const p = new THREE.Group();
    p.position.set(x, 0.82, z);
    p.add(mesh(boxG(0.16, 0.82, 0.16), m, 0, -0.41, 0));
    g.add(p); legs.push(p);
  });
  return { inner: finish(g, 1.5), legs };
};

// ── 09. Đầu màn hình (screen) — CHOSEN: head is a live monitor ──
// The face plate is returned as `inner.userData.face` so the office can later
// draw an expression / status onto it with a CanvasTexture.
const screenHead: RobotBuilder = (s) => {
  const g = new THREE.Group();
  const n = neon(s.accent), b = matte(s.body), m = metal();
  g.add(mesh(boxG(0.66, 0.8, 0.4), b, 0, 1.28, 0));       // torso
  g.add(mesh(boxG(0.2, 0.5, 0.06), n, 0, 1.28, 0.21));    // chest light strip
  g.add(mesh(boxG(0.72, 0.5, 0.12), b, 0, 1.95, 0));      // monitor bezel
  const face = mesh(boxG(0.6, 0.38, 0.02), lens(s.screen), 0, 1.95, 0.08);
  g.add(face);
  g.add(mesh(cylG(0.05, 0.05, 0.14), m, 0, 1.72, 0));     // neck
  [-0.43, 0.43].forEach((x) => g.add(mesh(boxG(0.14, 0.66, 0.2), n, x, 1.26, 0))); // arms
  const legs = [-0.18, 0.18].map((x) => legPivot(x, 0.86, b, 0.22, 0.86, 0.24));
  legs.forEach((l) => g.add(l));
  const inner = finish(g, 1.24);
  inner.userData.face = face; // hook for drawing a face/status later
  return { inner, legs };
};

// ── 10. Lập phương (cube) — a floating cube with detached hands ──
const cube: RobotBuilder = (s) => {
  const g = new THREE.Group();
  const n = neon(s.accent), b = matte(s.body);
  g.add(mesh(boxG(0.9, 0.9, 0.9), n, 0, 1.6, 0));
  [-0.2, 0.2].forEach((x) => g.add(mesh(sphG(0.09, 12), lens(s.screen), x, 1.7, 0.46)));
  g.add(mesh(boxG(0.5, 0.05, 0.02), b, 0, 1.42, 0.46));
  [-0.72, 0.72].forEach((x) => g.add(mesh(sphG(0.13, 12), b, x, 1.42, 0)));
  g.add(mesh(cylG(0.3, 0.3, 0.03), lens(s.screen), 0, 1.06, 0));
  return { inner: finish(g, 1.2), legs: [] };
};

/** every design. `note` is short enough to sit on the 3D label. */
export const ROBOTS: { id: string; name: string; note: string; build: RobotBuilder }[] = [
  { id: "blocky", name: "Khối vuông", note: "voxel, thân thiện", build: blocky },
  { id: "capsule", name: "Viên nang", note: "bo tròn, mềm, có visor", build: capsule },
  { id: "hover", name: "Bay lơ lửng", note: "không chân — bay", build: hover },
  { id: "mech", name: "Máy móc nặng", note: "to, công nghiệp, giáp vai", build: mech },
  { id: "android", name: "Người máy thon", note: "cao, mảnh, thanh lịch", build: android },
  { id: "retro", name: "Cổ điển", note: "robot thiếc 1950s", build: retro },
  { id: "orb", name: "Mắt thần", note: "một mắt bay — tối giản", build: orb },
  { id: "quad", name: "Bốn chân", note: "thú máy — thấp, bò", build: quad },
  { id: "screen", name: "Đầu màn hình", note: "đầu = màn hình", build: screenHead },
  { id: "cube", name: "Lập phương", note: "khối bay + tay rời", build: cube },
];

/** the design the office uses (chosen 2026-07-16) */
export const CHOSEN = "screen";
export const chosenBuilder: RobotBuilder = screenHead;

// ── the face on the screen-head ────────────────────────────────────────────────
// The whole point of design 09: the head is a monitor, so it can act out what the
// agent is doing. Features are drawn dark on the skin's lit screen colour — every
// skin's `screen` is bright, so one fixed dark ink reads on all of them.

export type Mood = "work" | "read" | "run" | "ask" | "error" | "done" | "idle";
export interface Face { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture }

const cssHex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const INK = "#0d1117";

/** swap the flat face plate for a live canvas. Returns null for designs with no screen. */
export function attachFace(inner: THREE.Object3D, skin: Skin): Face | null {
  const plate = inner.userData.face as THREE.Mesh | undefined;
  if (!plate) return null;
  const c = document.createElement("canvas"); c.width = 160; c.height = 100;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const tex = new THREE.CanvasTexture(c);
  plate.material = new THREE.MeshBasicMaterial({ map: tex }); // unlit → reads as a lit screen
  const f: Face = { ctx, tex };
  drawFace(f, skin, "idle", 0);
  return f;
}

/** draw the current expression. `t` is seconds (drives blinking + busy dots). */
export function drawFace(f: Face, skin: Skin, mood: Mood, t: number): void {
  const x = f.ctx, W = 160, H = 100;
  x.fillStyle = cssHex(skin.screen); x.fillRect(0, 0, W, H);
  x.fillStyle = "rgba(0,0,0,.07)"; // scanlines
  for (let i = 0; i < H; i += 4) x.fillRect(0, i, W, 2);
  x.fillStyle = INK; x.strokeStyle = INK; x.lineWidth = 7; x.lineCap = "round"; x.lineJoin = "round";

  const eyeY = 42, lx = 52, rx = 108;
  const openEye = (cx: number, w = 18, h = 24) => { x.beginPath(); x.roundRect(cx - w / 2, eyeY - h / 2, w, h, 6); x.fill(); };
  const lineEye = (cx: number) => { x.beginPath(); x.moveTo(cx - 11, eyeY); x.lineTo(cx + 11, eyeY); x.stroke(); };
  const arcEye = (cx: number) => { x.beginPath(); x.arc(cx, eyeY + 5, 11, Math.PI, 0); x.stroke(); };
  const xEye = (cx: number) => {
    x.beginPath();
    x.moveTo(cx - 10, eyeY - 10); x.lineTo(cx + 10, eyeY + 10);
    x.moveTo(cx + 10, eyeY - 10); x.lineTo(cx - 10, eyeY + 10); x.stroke();
  };

  const blinking = mood !== "error" && mood !== "done" && t % 4.2 > 4.05;
  if (blinking) { lineEye(lx); lineEye(rx); }
  else switch (mood) {
    case "error": xEye(lx); xEye(rx); break;
    case "done": arcEye(lx); arcEye(rx); break;
    case "idle": lineEye(lx); lineEye(rx); break;
    case "ask": openEye(lx, 22, 27); openEye(rx, 22, 27); break; // wide, attentive
    case "read": openEye(lx, 18, 13); openEye(rx, 18, 13); break; // half-lidded, scanning
    default: openEye(lx); openEye(rx);
  }

  x.lineWidth = 6; x.textAlign = "center";
  switch (mood) {
    case "done": x.beginPath(); x.arc(80, 62, 14, 0.15 * Math.PI, 0.85 * Math.PI); x.stroke(); break;
    case "error": x.beginPath(); x.arc(80, 84, 14, 1.15 * Math.PI, 1.85 * Math.PI); x.stroke(); break;
    case "ask": x.font = "bold 32px ui-monospace, monospace"; x.fillText("?", 80, 86); break;
    case "run":
      for (let i = 0; i < 3; i++) { // busy dots
        x.globalAlpha = Math.floor(t * 3) % 3 === i ? 1 : 0.28;
        x.beginPath(); x.arc(62 + i * 18, 74, 5, 0, Math.PI * 2); x.fill();
      }
      x.globalAlpha = 1;
      break;
    case "idle": x.font = "bold 20px ui-monospace, monospace"; x.fillText("z", 124, 28 - ((t * 8) % 10)); break;
    case "read": x.globalAlpha = 0.5; x.fillRect(40 + ((t * 40) % 78), 70, 14, 5); x.globalAlpha = 1; break;
    default: x.beginPath(); x.moveTo(66, 72); x.lineTo(94, 72); x.stroke(); // steady, working
  }
  f.tex.needsUpdate = true;
}
