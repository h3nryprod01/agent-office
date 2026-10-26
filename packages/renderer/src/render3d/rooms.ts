// Three rooms, one set of stations.
//
// A project's template says what KIND of work happens here, so the office looks
// like it: a dev floor, a content studio, a real-estate sales floor. Every room
// keeps the same functional stations in the same places (desk = edit, bookshelf =
// read files, arcade = run commands, meeting table = hand work to sub-agents), so
// the semantic mapping and every agent route work unchanged — only the colours,
// materials and the set dressing in the open strips of the floor differ.
//
// Everything here is procedural (canvas textures + primitives): no asset files,
// nothing to license.

import * as THREE from "three";
import { BEANBAGS, BROCHURES, HX, LEFT_WALL_DECOR, MAQUETTE, STUDIO_SET, CABINET } from "./floorplan";

export type RoomStyle = "dev" | "studio" | "estate";
export const ROOM_STYLES: readonly RoomStyle[] = ["dev", "studio", "estate"];

/** Template id (templates/<name>) → room. Unknown / missing → the dev floor. */
export function roomStyleForTemplate(template: string | null | undefined): RoomStyle {
  const t = (template ?? "").toLowerCase();
  if (/(content|studio|media|creative|marketing-studio)/.test(t)) return "studio";
  if (/(real-?estate|property|realty|housing)/.test(t)) return "estate";
  return "dev";
}

/** Anything a URL or caller hands us, narrowed to a real style (else "dev"). */
export function asRoomStyle(v: string | null | undefined): RoomStyle {
  return ROOM_STYLES.find((s) => s === v) ?? "dev";
}

export interface RoomTheme {
  floor: number;
  floorMap: "none" | "planks" | "marble";
  /** world units covered by one repeat of the floor texture */
  floorTile: number;
  gridOpacity: number;
  rim: number;
  /** the two back walls */
  wall: number;
  partition: number;
  deskTop: number;
  ceoDesk: number;
  sofa: number;
  shelf: number;
  arcadeBody: number;
  arcadeMarquee: number;
  /** the four standing wall screens */
  screens: readonly [number, number, number, number];
}

export const THEMES: Record<RoomStyle, RoomTheme> = {
  dev: {
    floor: 0xf2f5fa, floorMap: "none", floorTile: 4, gridOpacity: 0.45, rim: 0xfafcfe, wall: 0xdde3ec, partition: 0xe7ecf3,
    deskTop: 0x8a6a44, ceoDesk: 0x6d4a28, sofa: 0xe9edf3, shelf: 0x6b4d30, arcadeBody: 0x1b2433, arcadeMarquee: 0xff9100,
    screens: [0x0deef3, 0xff9100, 0x7c4dff, 0x00e676],
  },
  studio: {
    floor: 0xffffff, floorMap: "planks", floorTile: 5.5, gridOpacity: 0, rim: 0xf6e7d4, wall: 0xf1dcc6, partition: 0xf3dcc8,
    deskTop: 0xc8935e, ceoDesk: 0x9a5a38, sofa: 0xe2725b, shelf: 0x9a5a38, arcadeBody: 0x2d1b3a, arcadeMarquee: 0xff4fa3,
    screens: [0xff4fa3, 0xffc233, 0x39d7c8, 0x9b6bff],
  },
  estate: {
    floor: 0xffffff, floorMap: "marble", floorTile: 4, gridOpacity: 0, rim: 0xf4efe6, wall: 0xeee7da, partition: 0xece6dc,
    deskTop: 0xb98a5e, ceoDesk: 0x5c3d24, sofa: 0xd8c8a8, shelf: 0x8a6a44, arcadeBody: 0x2b3a4a, arcadeMarquee: 0xd4af37,
    screens: [0xd4af37, 0x4ea8de, 0xf0ebe0, 0x37b58f],
  },
};

// ── procedural textures ─────────────────────────────────────────────────────

function rng(seed: number): () => number { // mulberry32 — same room every boot
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTex(size: number, paint: (x: CanvasRenderingContext2D, n: number) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  paint(c.getContext("2d")!, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const texCache = new Map<string, THREE.CanvasTexture>();
function cached(key: string, make: () => THREE.CanvasTexture): THREE.CanvasTexture {
  let t = texCache.get(key);
  if (!t) { t = make(); texCache.set(key, t); }
  return t;
}

/** warm oak planks, 8 boards across one tile */
export function plankTexture(): THREE.CanvasTexture {
  return cached("planks", () => canvasTex(512, (x, n) => {
    const r = rng(11), boards = 8, h = n / boards;
    for (let i = 0; i < boards; i++) {
      const tone = 150 + r() * 36;
      x.fillStyle = `rgb(${tone + 28},${tone - 8},${tone - 52})`;
      x.fillRect(0, i * h, n, h);
      x.strokeStyle = "rgba(90,50,20,.16)"; x.lineWidth = 1;
      for (let g = 0; g < 7; g++) { // grain
        const y = i * h + 4 + r() * (h - 8);
        x.beginPath(); x.moveTo(0, y); x.bezierCurveTo(n * 0.3, y + (r() - 0.5) * 6, n * 0.6, y + (r() - 0.5) * 6, n, y + (r() - 0.5) * 3); x.stroke();
      }
      x.fillStyle = "rgba(60,30,10,.5)"; x.fillRect(0, i * h, n, 2); // seam
      const cut = r() * n; x.fillRect(cut, i * h, 2, h); // butt joint
    }
  }));
}

/** pale stone tiles with a few veins */
export function marbleTexture(): THREE.CanvasTexture {
  return cached("marble", () => canvasTex(512, (x, n) => {
    const r = rng(23);
    x.fillStyle = "#efeae0"; x.fillRect(0, 0, n, n);
    const cell = n / 2; // 2x2 tiles per texture
    for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
      const tone = 232 + Math.floor(r() * 14);
      x.fillStyle = `rgb(${tone},${tone - 4},${tone - 12})`;
      x.fillRect(cx * cell + 2, cy * cell + 2, cell - 4, cell - 4);
      x.strokeStyle = "rgba(150,140,125,.28)"; x.lineWidth = 1.5;
      for (let v = 0; v < 3; v++) {
        let px = cx * cell + r() * cell, py = cy * cell;
        x.beginPath(); x.moveTo(px, py);
        for (let s = 0; s < 5; s++) { px += (r() - 0.5) * 50; py += cell / 5; x.lineTo(px, py); }
        x.stroke();
      }
    }
    x.fillStyle = "rgba(120,110,95,.55)"; // grout
    x.fillRect(cell - 1, 0, 2, n); x.fillRect(0, cell - 1, n, 2); x.fillRect(0, 0, n, 1.5); x.fillRect(0, 0, 1.5, n);
  }));
}

/** fine wood grain for desk tops — greyscale-warm so the desk colour still tints it */
export function deskGrainTexture(): THREE.CanvasTexture {
  return cached("grain", () => canvasTex(256, (x, n) => {
    const r = rng(5);
    x.fillStyle = "#ffffff"; x.fillRect(0, 0, n, n);
    for (let i = 0; i < 46; i++) {
      const y = r() * n, a = 0.05 + r() * 0.12;
      x.strokeStyle = `rgba(70,40,15,${a})`; x.lineWidth = 0.6 + r() * 1.6;
      x.beginPath(); x.moveTo(0, y); x.bezierCurveTo(n * 0.3, y + (r() - 0.5) * 10, n * 0.7, y + (r() - 0.5) * 10, n, y + (r() - 0.5) * 6); x.stroke();
    }
  }));
}

/** soft round light pool, additive — lamps paint it on the floor at night */
export function poolTexture(): THREE.CanvasTexture {
  return cached("pool", () => canvasTex(128, (x, n) => {
    const g = x.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, "rgba(255,226,170,.85)"); g.addColorStop(0.5, "rgba(255,210,140,.28)"); g.addColorStop(1, "rgba(255,200,120,0)");
    x.fillStyle = g; x.fillRect(0, 0, n, n);
  }));
}

export function floorTexture(map: RoomTheme["floorMap"]): THREE.CanvasTexture | null {
  return map === "planks" ? plankTexture() : map === "marble" ? marbleTexture() : null;
}

// ── set dressing ─────────────────────────────────────────────────────────────

const mats = new Map<string, THREE.MeshStandardMaterial>();
const std = (hex: number, rough = 0.85, metal = 0): THREE.MeshStandardMaterial => {
  const k = `${hex}:${rough}:${metal}`;
  let m = mats.get(k);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal }); m.userData.shared = true; mats.set(k, m); }
  return m;
};
const lit = (hex: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: hex });
function block(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, cast = true): THREE.Mesh {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  b.position.set(x, y, z); b.castShadow = cast; b.receiveShadow = true;
  return b;
}
function labelTex(w: number, h: number, paint: (x: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  paint(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** a softbox on a tripod: a glowing panel studio people use for lighting */
function softbox(x: number, z: number, rotY: number): THREE.Group {
  const g = new THREE.Group();
  g.add(block(0.08, 2.2, 0.08, std(0x2a2f3a, 0.5, 0.6), 0, 1.1, 0));
  for (const a of [0, 2.1, 4.2]) {
    const leg = block(0.06, 1.3, 0.06, std(0x2a2f3a, 0.5, 0.6), Math.sin(a) * 0.4, 0.55, Math.cos(a) * 0.4, false);
    leg.rotation.set(Math.cos(a) * 0.3, 0, -Math.sin(a) * 0.3);
    g.add(leg);
  }
  const box = block(1.3, 1.0, 0.45, std(0x1a1d26), 0, 2.4, 0);
  g.add(box);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.86), lit(0xfff4dc));
  face.position.set(0, 2.4, 0.235);
  g.add(face);
  g.position.set(x, 0, z); g.rotation.y = rotY;
  return g;
}

function tripodCamera(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  for (const a of [0, 2.1, 4.2]) {
    const leg = block(0.06, 1.7, 0.06, std(0x2a2f3a, 0.5, 0.6), Math.sin(a) * 0.35, 0.8, Math.cos(a) * 0.35, false);
    leg.rotation.set(Math.cos(a) * 0.22, 0, -Math.sin(a) * 0.22);
    g.add(leg);
  }
  g.add(block(0.7, 0.5, 0.9, std(0x1a1d26, 0.4, 0.3), 0, 1.85, 0));
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.5, 16), std(0x10131a, 0.3, 0.5));
  lens.rotation.x = Math.PI / 2; lens.position.set(0, 1.85, 0.62); lens.castShadow = true;
  g.add(lens);
  g.add(block(0.12, 0.12, 0.12, lit(0xff3b3b), 0.2, 2.18, 0.1, false)); // REC light
  g.position.set(x, 0, z); g.rotation.y = Math.PI; // looking back at the set
  return g;
}

function beanbag(x: number, z: number, hex: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.75, 18, 12), std(hex, 0.95));
  m.scale.set(1, 0.62, 1); m.position.set(x, 0.46, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}

function backdrop(x: number, z: number): THREE.Group {
  // a seamless paper roll on two stands: the studio's signature. Kept low (it
  // stands in the front strip, and anything tall there would hide the desks).
  const g = new THREE.Group();
  g.add(block(5, 2.3, 0.1, std(0x39d7c8, 0.95), 0, 1.35, 0));
  g.add(block(5, 0.12, 1.2, std(0x39d7c8, 0.95), 0, 0.06, 0.6)); // the sweep rolling onto the floor
  g.add(block(0.12, 2.7, 0.12, std(0x2a2f3a, 0.5, 0.6), -2.6, 1.35, 0));
  g.add(block(0.12, 2.7, 0.12, std(0x2a2f3a, 0.5, 0.6), 2.6, 1.35, 0));
  g.add(block(5.4, 0.12, 0.12, std(0x2a2f3a, 0.5, 0.6), 0, 2.64, 0));
  g.position.set(x, 0, z);
  return g;
}

function moodboard(x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.add(block(6, 3.6, 0.1, std(0xd9c3a3, 0.95), 0, 0, 0, false));
  const r = rng(3), cols = [0xff4fa3, 0xffc233, 0x39d7c8, 0x9b6bff, 0xf5f0e6, 0xff7a45];
  for (let i = 0; i < 11; i++) {
    const w = 0.8 + r() * 0.7, h = 0.7 + r() * 0.7;
    const card = block(w, h, 0.04, std(cols[Math.floor(r() * cols.length)], 0.9), -2.5 + (i % 6) * 1, (Math.floor(i / 6) - 0.5) * 1.5 + (r() - 0.5) * 0.3, 0.08, false);
    card.rotation.z = (r() - 0.5) * 0.18;
    g.add(card);
  }
  g.position.set(x, y, z);
  return g;
}

function onAirSign(x: number, y: number, z: number): THREE.Mesh {
  const tex = labelTex(256, 96, (c) => {
    c.fillStyle = "#1a0a0a"; c.fillRect(0, 0, 256, 96);
    c.strokeStyle = "#ff3b3b"; c.lineWidth = 6; c.strokeRect(5, 5, 246, 86);
    c.fillStyle = "#ff3b3b"; c.font = "bold 54px ui-monospace, monospace"; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText("ON AIR", 128, 50);
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.98), new THREE.MeshBasicMaterial({ map: tex }));
  m.position.set(x, y, z);
  return m;
}

/** the scale model of a neighbourhood a sales floor keeps on show */
function maquette(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.add(block(6.2, 0.9, 3.8, std(0xf4efe6, 0.6), 0, 0.45, 0));
  g.add(block(5.8, 0.06, 3.4, std(0x7fa86a, 0.95), 0, 0.93, 0, false)); // the lawn
  const r = rng(41), tones = [0xf8f4ec, 0xe6dcc8, 0xd9e6f0, 0xf0d9c8];
  for (let i = 0; i < 12; i++) {
    const w = 0.5 + r() * 0.5, d = 0.5 + r() * 0.5, h = 0.35 + r() * 1.0;
    const bx = -2.5 + (i % 6) * 1 + (r() - 0.5) * 0.2, bz = (Math.floor(i / 6) - 0.5) * 1.6 + (r() - 0.5) * 0.3;
    g.add(block(w, h, d, std(tones[Math.floor(r() * tones.length)], 0.7), bx, 0.96 + h / 2, bz));
  }
  const tower = block(0.7, 1.7, 0.7, new THREE.MeshStandardMaterial({ color: 0x9fc9e8, roughness: 0.1, metalness: 0.6 }), 2.4, 0.96 + 0.85, 0.2);
  g.add(tower);
  for (let i = 0; i < 6; i++) { // trees
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 8), std(0x3f8a58, 0.9));
    t.position.set(-2.7 + i * 1.05, 1.22, 1.45 + (i % 2) * 0.1); t.castShadow = true;
    g.add(t);
  }
  g.position.set(x, 0, z);
  return g;
}

function brochureRack(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.add(block(1.6, 1.9, 0.5, std(0xd8c8a8, 0.7), 0, 0.95, 0));
  const r = rng(9), cols = [0xd4af37, 0x4ea8de, 0xf0ebe0, 0x37b58f];
  for (let row = 0; row < 3; row++) for (let i = 0; i < 4; i++) {
    g.add(block(0.3, 0.45, 0.04, std(cols[Math.floor(r() * cols.length)], 0.9), -0.55 + i * 0.37, 0.5 + row * 0.55, 0.27, false));
  }
  g.position.set(x, 0, z);
  return g;
}

function photoWall(x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const skies = [["#9fd0f0", "#f6e3b4"], ["#f4b88c", "#7aa6c8"], ["#bfe3d0", "#e9d9b0"]];
  skies.forEach(([a, b], i) => {
    const tex = labelTex(128, 96, (c) => {
      const grd = c.createLinearGradient(0, 0, 0, 96); grd.addColorStop(0, a); grd.addColorStop(1, b);
      c.fillStyle = grd; c.fillRect(0, 0, 128, 96);
      c.fillStyle = "#fbf8f1"; c.fillRect(34, 46, 60, 40); // the house
      c.fillStyle = "#b5533c"; c.beginPath(); c.moveTo(28, 48); c.lineTo(64, 24); c.lineTo(100, 48); c.fill();
      c.fillStyle = "#6d7f94"; c.fillRect(56, 62, 16, 24);
    });
    g.add(block(2.1, 1.6, 0.08, std(0x5c3d24, 0.6), -2.4 + i * 2.4, 0, 0, false));
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.84, 1.38), new THREE.MeshBasicMaterial({ map: tex }));
    p.position.set(-2.4 + i * 2.4, 0, 0.05);
    g.add(p);
  });
  g.position.set(x, y, z);
  return g;
}

/**
 * The set dressing for one room, in the strips of floor the stations leave open.
 * Returns a fresh group each call; the caller owns adding/removing it.
 * (`dev` has none: it is the original floor, untouched.)
 */
export function buildDecor(style: RoomStyle): THREE.Group {
  const g = new THREE.Group();
  g.name = `decor:${style}`;
  const wallX = -HX + 0.08; // just proud of the left wall
  const onLeftWall = (o: THREE.Object3D): THREE.Object3D => { o.rotation.y = Math.PI / 2; return o; };
  if (style === "studio") {
    const set = STUDIO_SET;
    g.add(backdrop(set.x, set.z));
    g.add(softbox(set.x - 3.6, set.z + 1.6, 0.7));
    g.add(softbox(set.x + 3.6, set.z + 1.6, -0.7));
    g.add(tripodCamera(set.x, set.z + 3.4));
    g.add(onLeftWall(moodboard(wallX, LEFT_WALL_DECOR.y, LEFT_WALL_DECOR.z)));
    g.add(onLeftWall(onAirSign(wallX, 3.7, CABINET.z)));
    g.add(beanbag(BEANBAGS[0].x, BEANBAGS[0].z, 0xe2725b));
    g.add(beanbag(BEANBAGS[1].x, BEANBAGS[1].z, 0xffc233));
  } else if (style === "estate") {
    g.add(maquette(MAQUETTE.x, MAQUETTE.z));
    g.add(brochureRack(BROCHURES.x, BROCHURES.z));
    g.add(onLeftWall(photoWall(wallX, LEFT_WALL_DECOR.y, LEFT_WALL_DECOR.z)));
  }
  return g;
}
