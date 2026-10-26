// The office furniture: plants, lamps, lounge, windows, wall panels, the filing
// cabinet, the two stations on the walls (library, arcade), the meeting table,
// the lift + reception and the LLM provider racks.
//
// Positions come from floorplan.ts (tested there); this file only builds meshes.
// Office3D hands in its material helpers (so room theming keeps working) and a
// `place()` hook that makes a prop clickable.

import * as THREE from "three";
import { t } from "../i18n";
import type { AgentModel } from "../sim/model";
import * as PLAN from "./floorplan";
import { lookOf } from "./look";
import { poolTexture, type RoomTheme } from "./rooms";

export interface PropKit {
  scene: THREE.Scene;
  box: (w: number, h: number, d: number, m: THREE.Material, cast?: boolean) => THREE.Mesh;
  mat: (c: number, rough?: number, metal?: number) => THREE.MeshStandardMaterial;
  /** a material whose colour follows the room theme */
  tmat: (pick: (t: RoomTheme) => number, rough?: number, metal?: number) => THREE.MeshStandardMaterial;
  shade: (hex: number, k: number) => number;
  /** make a prop clickable: tags it with a furnitureId and names it in the hover tooltip */
  place: (obj: THREE.Object3D, id: string, tipY: number) => void;
  /** what windows show (Office3D repaints it with the time of day) */
  paneTex: THREE.Texture;
}

export interface Rack { family: string; trim: number; leds: THREE.MeshBasicMaterial[]; on: (number | null)[] }

export interface Props {
  /** lamp bulbs: dim by day, lit at dusk (Office3D lerps the colour) */
  lampGlowMat: THREE.MeshBasicMaterial;
  /** additive light pools under the lamps (opacity follows the night) */
  poolMat: THREE.MeshBasicMaterial;
  /** the four themed wall panels, in THEMES.screens order */
  wallScreenMats: THREE.MeshBasicMaterial[];
  racks: Rack[];
}

/** names on the provider racks — vendor names, not translated */
const FAMILY_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", "claude-worker": "Workers", hermes: "Hermes" };

/** a small sign: centred text on a dark plate */
export function labelTexture(text: string, color: string, w: number, h: number): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d")!;
  x.fillStyle = "#121722"; x.fillRect(0, 0, w, h);
  x.fillStyle = color; x.textAlign = "center"; x.textBaseline = "middle";
  x.font = `bold ${Math.round(h * 0.55)}px ui-monospace, monospace`;
  x.fillText(text, w / 2, h / 2 + 1, w - 12);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildProps(k: PropKit): Props {
  const { scene, box, mat, tmat, shade, place } = k;
  const { HX, HZ } = PLAN;
  /** box placed at (x, y, z) inside a parent — `add()` returns the parent, so never chain off it */
  const put = (parent: THREE.Object3D, m: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh => {
    m.position.set(x, y, z); parent.add(m); return m;
  };

  function makePlant(x: number, z: number, s = 1): void {
    const g = new THREE.Group();
    put(g, box(0.8, 0.8, 0.8, mat(0x6b4d30)), 0, 0.4, 0);
    [0, 1, 2].forEach((i) => {
      const l = put(g, box(0.45, 1.3, 0.45, mat(0x3f9d63)), (i - 1) * 0.36, 1.35, 0);
      l.rotation.z = (i - 1) * 0.42;
    });
    g.position.set(x, 0, z); g.scale.setScalar(s); scene.add(g);
  }
  // The lamps are dim by day and come on at dusk: one shared glow material plus a
  // soft additive light pool on the floor — no extra real lights, so the cost stays
  // at one material and a few flat quads.
  const lampGlowMat = new THREE.MeshBasicMaterial({ color: 0xb9b3a2 });
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const poolGeo = new THREE.PlaneGeometry(6, 6);
  function makeLamp(x: number, z: number, rot = 0): void {
    const g = new THREE.Group();
    put(g, box(0.07, 2.5, 0.07, mat(0xd7dde6, 0.4, 0.3)), 0, 1.25, 0);
    put(g, box(0.82, 0.34, 0.56, mat(0x141a24)), 0, 2.56, 0).rotation.x = -0.2;
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.4), lampGlowMat);
    glow.rotation.x = Math.PI / 2; glow.position.set(0, 2.37, 0.03); g.add(glow);
    g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
    const pool = new THREE.Mesh(poolGeo, poolMat);
    pool.rotation.x = -Math.PI / 2; pool.position.set(x, 0.035, z + 0.4); pool.renderOrder = 1;
    scene.add(pool);
  }
  function makeSofa(x: number, z: number, rot = 0): void {
    const g = new THREE.Group();
    put(g, box(3.2, 0.42, 1.3, tmat((t) => t.sofa)), 0, 0.52, 0);
    put(g, box(3.2, 0.8, 0.26, tmat((t) => t.sofa)), 0, 0.98, -0.52);
    [-1.6, 1.6].forEach((ax) => put(g, box(0.26, 0.58, 1.3, tmat((t) => shade(t.sofa, 0.96))), ax, 0.76, 0));
    g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
  }
  const wallScreenMats: THREE.MeshBasicMaterial[] = [];
  /** a lit panel hung flat on a wall; the room theme recolours it */
  function makeWallScreen(x: number, y: number, z: number, rotY: number, hex: number): void {
    const g = new THREE.Group();
    g.add(box(1.4, 0.9, 0.08, mat(0x141a24)));
    const screenMat = new THREE.MeshBasicMaterial({ color: hex });
    wallScreenMats.push(screenMat);
    const lit = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.68), screenMat);
    lit.position.z = 0.05; g.add(lit);
    g.position.set(x, y, z); g.rotation.y = rotY; scene.add(g);
  }
  /** a window onto the sky: the pane is a live texture, so it follows the clock */
  function makeWindow(x: number, y: number, z: number, rotY: number, w: number, h: number): void {
    const g = new THREE.Group();
    const frame = mat(0x6b7487, 0.5, 0.2);
    g.add(box(w + 0.3, h + 0.3, 0.1, frame, false));
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: k.paneTex, fog: false }));
    pane.position.z = 0.06; g.add(pane);
    put(g, box(0.08, h, 0.08, frame, false), 0, 0, 0.09);
    put(g, box(w, 0.08, 0.08, frame, false), 0, 0, 0.09);
    g.position.set(x, y, z); g.rotation.y = rotY; scene.add(g);
  }
  PLAN.LAMPS.forEach(([x, z, r]) => makeLamp(x, z, r));
  PLAN.PLANTS.forEach(([x, z, sc]) => makePlant(x, z, sc));
  makeSofa(PLAN.SOFA.x, PLAN.SOFA.z, Math.PI / 2); // lounge against the left wall, facing the room
  makeWindow(PLAN.WINDOW_BACK.x, PLAN.WINDOW_BACK.y, -HZ + 0.06, 0, PLAN.WINDOW_BACK.w, PLAN.WINDOW_BACK.h);
  makeWindow(-HX + 0.06, PLAN.WINDOW_LEFT.y, PLAN.WINDOW_LEFT.z, Math.PI / 2, PLAN.WINDOW_LEFT.w, PLAN.WINDOW_LEFT.h);
  // four themed panels: over the library, and over the provider racks
  makeWallScreen(PLAN.LIBRARY[0].x, 4.4, -HZ + 0.05, 0, 0x0deef3);
  makeWallScreen(PLAN.LIBRARY[1].x, 4.4, -HZ + 0.05, 0, 0xff9100);
  makeWallScreen(-HX + 0.05, 4.6, PLAN.RACKS[1].z, Math.PI / 2, 0x7c4dff);
  makeWallScreen(-HX + 0.05, 4.6, PLAN.RACKS[3].z, Math.PI / 2, 0x00e676);

  // filing cabinet — click it to open the outputs panel. Against the left wall,
  // facing the room: the back corners project up under the app's overlay panels,
  // where it would render but never be clickable.
  const cabinet = new THREE.Group();
  put(cabinet, box(1.5, 2.3, 1.1, mat(0x8d99ae, 0.7)), 0, 1.15, 0);
  [0.35, 1.15, 1.95].forEach((y) => put(cabinet, box(1.3, 0.62, 0.06, mat(0x5b6478, 0.6)), 0, y, 0.56));
  cabinet.position.set(PLAN.CABINET.x, 0, PLAN.CABINET.z);
  cabinet.rotation.y = Math.PI / 2;
  scene.add(cabinet);
  place(cabinet, "filing_cabinet", 3);

  // ── stations on the walls (semantic-mapping §2): an agent stands where the work happens ──
  // the library (two bookshelves) = reading files
  const library = new THREE.Group();
  PLAN.LIBRARY.forEach((p) => {
    const shelf = new THREE.Group();
    shelf.add(box(3.4, 3.2, 0.5, tmat((t) => t.shelf)));
    [0.5, 1.4, 2.3].forEach((y) => {
      put(shelf, box(3.2, 0.1, 0.7, mat(0x8a6a44)), 0, y - 1.6 + 0.05, 0.1);
      for (let i = 0; i < 7; i++) {
        put(shelf, box(0.16, 0.5, 0.34, mat([0x8b5cf6, 0x0deef3, 0xff9100, 0x00e676, 0xff4081][(i + Math.round(p.x)) % 5])), -1.4 + i * 0.45, y - 1.6 + 0.3, 0.1);
      }
    });
    shelf.position.set(p.x, 1.6, p.z);
    library.add(shelf);
  });
  scene.add(library);
  place(library, "library", 4);
  // the arcade (two cabinets on the left wall) = running commands (terminal as arcade machine)
  const arcade = new THREE.Group();
  PLAN.ARCADES.forEach((p) => {
    const arc = new THREE.Group();
    arc.add(box(1.6, 2.4, 1.0, tmat((t) => t.arcadeBody)));
    const arcScreen = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.8), new THREE.MeshBasicMaterial({ color: 0x00e676 }));
    arcScreen.position.set(0, 0.5, 0.51); arc.add(arcScreen);
    put(arc, box(1.6, 0.4, 1.0, tmat((t) => t.arcadeMarquee)), 0, 1.4, 0);
    arc.position.set(p.x, 1.2, p.z);
    arc.rotation.y = Math.PI / 2; // screen towards the room
    arcade.add(arc);
  });
  scene.add(arcade);
  place(arcade, "arcade", 3.4);

  const meetingTable = new THREE.Group();
  const meetTop = new THREE.Mesh(new THREE.CylinderGeometry(PLAN.MEET_R, PLAN.MEET_R, 0.14, 28), mat(0xe9edf3));
  meetTop.position.y = 0.95; meetTop.castShadow = true; meetTop.receiveShadow = true; meetingTable.add(meetTop);
  const meetLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.34, 0.9, 16), mat(0xc3ccd8));
  meetLeg.position.y = 0.45; meetLeg.castShadow = true; meetingTable.add(meetLeg);
  meetingTable.position.set(PLAN.MEET_CENTER.x, 0, PLAN.MEET_CENTER.z);
  scene.add(meetingTable);
  place(meetingTable, "meeting_table", 2.2);

  // ── the lift: how agents arrive and leave, and the way to the other floors ──
  const lift = new THREE.Group();
  const { w, h } = PLAN.LIFT;
  put(lift, box(w + 0.5, h + 0.4, 0.3, mat(0x4a5163, 0.5, 0.2), false), 0, (h + 0.4) / 2, 0);
  const doorMat = mat(0xb9c2d0, 0.35, 0.3);
  [-1, 1].forEach((side) => put(lift, box(w / 2 - 0.06, h, 0.08, doorMat, false), side * (w / 4), h / 2, 0.18));
  const ind = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.34), new THREE.MeshBasicMaterial({ map: labelTexture("▲ ▼", "#ffb547", 128, 40) }));
  ind.position.set(0, h + 0.2, 0.17); lift.add(ind);
  lift.position.set(PLAN.LIFT.x, 0, -HZ + 0.15);
  scene.add(lift);
  place(lift, "elevator", h + 1.1);

  // reception — where new hires check in; beside the lift, clear of everyone's path out of it
  const rec = new THREE.Group();
  const { w: rw, d: rd } = PLAN.RECEPTION;
  put(rec, box(rw, 1.15, rd, tmat((t) => t.partition, 0.6)), 0, 0.575, 0);
  put(rec, box(rw + 0.2, 0.1, rd + 0.2, tmat((t) => t.ceoDesk, 0.5)), 0, 1.2, 0);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(rw * 0.8, 0.5), new THREE.MeshBasicMaterial({ map: labelTexture(t("office.place.receptionSign"), "#ffd166", 320, 64) }));
  sign.position.set(0, 0.62, rd / 2 + 0.01); rec.add(sign);
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xd4af37, 0.35, 0.3));
  bell.position.set(-rw / 2 + 0.4, 1.25, 0); rec.add(bell);
  rec.position.set(PLAN.RECEPTION.x, 0, PLAN.RECEPTION.z);
  scene.add(rec);
  place(rec, "reception", 2.4);

  // ── LLM providers: one rack per vendor family on the left wall. Its lights show
  // how many live agents run on that vendor right now (workers: one light per lane
  // colour). Vendor health (balance, rate limits) is the multi-vendor lane's data —
  // when it arrives, it slots into the same lights.
  const racks: Rack[] = [];
  const bank = new THREE.Group();
  PLAN.RACKS.forEach((r) => {
    const trim = lookOf({ harness: r.family } as AgentModel).trim;
    const g = new THREE.Group();
    put(g, box(1.0, 3.8, 1.4, mat(0x11161f, 0.5, 0.3)), 0, 1.9, 0);
    put(g, box(1.02, 0.12, 1.42, mat(trim, 0.4)), 0, 3.86, 0); // vendor colour cap
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.34), new THREE.MeshBasicMaterial({ map: labelTexture(FAMILY_LABEL[r.family] ?? r.family, "#" + trim.toString(16).padStart(6, "0"), 192, 52) }));
    plate.position.set(0.51, 3.45, 0); plate.rotation.y = Math.PI / 2; g.add(plate);
    const rack: Rack = { family: r.family, trim, leds: [], on: [] };
    for (let i = 0; i < 6; i++) {
      const m = new THREE.MeshBasicMaterial({ color: 0x1a2418 });
      put(g, new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.9), m), 0.52, 2.95 - i * 0.42, 0);
      rack.leds.push(m); rack.on.push(null);
    }
    g.position.set(r.x, 0, r.z);
    bank.add(g);
    racks.push(rack);
  });
  scene.add(bank);
  place(bank, "server_rack", 4.6);

  return { lampGlowMat, poolMat, wallScreenMats, racks };
}
