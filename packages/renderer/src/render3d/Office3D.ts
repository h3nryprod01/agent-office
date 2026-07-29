// The 3D office as a mountable module (Path B, Phase 4 cutover).
//
// This is the renderer only: it owns a canvas + scene and is driven from
// outside by tick(state, dtMs). It holds NO event source and NO HUD, so the
// app can feed it the same repo-filtered state it feeds the Pixi office, and
// the app's own chrome (navbar, side panel, tabs) stays in charge.
//
// Mounted by src/main.ts as the "Văn phòng" view.

import { t } from "../i18n";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { statusLabel, type AgentModel, type OfficeState, type StationId } from "../sim/model";
import { ceoQueue } from "../sim/selectors";
import { ceoActivityDelay, nextCeoActivity, type CeoActivity } from "../render/ceoActivity";
import { type WallBoardData } from "../ui/wallBoardData";
import { chosenBuilder, attachFace, drawFace, SKINS, type Face, type Mood, type Skin } from "./robotKit";

/** "screen" is the shipped character (procedural, no asset); "robot" is a CC0 GLB
 *  alternate, loaded only if something calls setKind("robot"). A Mixamo-derived
 *  "human" kind was dropped: unreachable, unused, and its licence was unverified. */
export type Kind = "screen" | "robot";

export interface Office3DHandle {
  canvas: HTMLCanvasElement;
  /** feed the (already repo-filtered) state; drives reconcile + render.
   *  `opts.now` is the replay's virtual clock (bubble timing) and `opts.instant`
   *  is time-lapse — both mirror what AgentLayer.tick took in the 2D office. */
  tick(state: OfficeState, dtMs: number, opts?: { now?: number; instant?: boolean }): void;
  setNight(on: boolean): void;
  /** returns the new meeting state */
  toggleMeeting(): boolean;
  setKind(kind: Kind): void;
  kind(): Kind;
  /** pin an agent (the repo's PM) to the CEO desk; null clears it */
  pinAgent(agentId: string | null): void;
  /** paint the Scrum / Velocity wall boards */
  renderBoards(data: WallBoardData): void;
  /** a newly hired skill walks in, waves at reception, then leaves */
  walkInGreeter(skillName: string): void;
  /** ease the camera until this agent is centred; null cancels */
  focusAgent(agentId: string | null): void;
  /** undo any drag/focus pan — put the office back in the middle */
  recenter(): void;
  /** drop the expensive bits when the machine can't keep up (see main.ts watchdog).
   *  Shadows alone are ~34% of the frame; on a box without GPU acceleration the
   *  office renders but crawls, and a try/catch can't catch "slow". */
  setQuality(level: "high" | "low"): void;
  /** models load async; false until the GLB kinds are ready */
  hasKind(kind: Kind): boolean;
  resize(): void;
  dispose(): void;
  /** dev-tools only: what each character is doing right now */
  debug(): { id: string; state: string; x: number; z: number; home: number; bubble: boolean }[];
  /** dev-tools only: what a screen point would pick */
  probePick(clientX: number, clientY: number): { agentId?: string; furnitureId?: string; hit?: string };
}

export interface Office3DOpts {
  /** clicking an agent (or their desk) */
  onPick?: (agentId: string) => void;
  /** clicking a tagged prop, e.g. "filing_cabinet" → outputs panel */
  onFurniture?: (furnitureId: string) => void;
}

// ── agent → skin (body / accent / screen), so a full room reads varied ──
const ROLE_SKIN: Record<string, string> = { marketing: "ember", content: "matrix", planner: "violet", designer: "magenta" };
function hashStr(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
export function agentSkin(a: AgentModel): Skin {
  const n = (a.name || "").toLowerCase();
  const role = Object.keys(ROLE_SKIN).find((r) => n.startsWith(r));
  const byRole = role ? SKINS.find((s) => s.id === ROLE_SKIN[role]) : undefined;
  return byRole ?? SKINS[hashStr(a.name || a.agentId) % SKINS.length];
}
/** the agent's signature colour, for HUD chrome (ticker, legend, monitor tint) */
export const agentColor = (a: AgentModel): number => agentSkin(a).accent;

const statusHue: Record<string, number> = {
  waiting_permission: 0xff5252, blocked: 0xff5252, error: 0xff5252,
  running_command: 0xff9100, reading: 0x448aff, working: 0x00e676, idle: 0x64748b, done: 0x00e676,
};
const clipMap: Record<string, string> = {
  waiting_permission: "Wave", blocked: "No", error: "No", done: "ThumbsUp",
  running_command: "Idle", working: "Idle", reading: "Idle", idle: "Idle",
};
const moodMap: Record<string, Mood> = {
  working: "work", reading: "read", running_command: "run", waiting_permission: "ask",
  blocked: "error", error: "error", done: "done", idle: "idle",
};

const RECONCILE_MS = 250; // how often live agents are re-matched to desks
// Canvas textures (desk monitors, faces) are redrawn on their OWN clock. Their
// content changes about once a second — repainting all of them every frame meant
// ~1300 canvas redraws + GPU texture uploads per second, which is most of the
// office's frame cost and is brutal on a weak GPU. 8 Hz is imperceptible here.
const PAINT_MS = 125;

export function createOffice3D(opts: Office3DOpts = {}): Office3DHandle {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.Fog(0x0d1117, 34, 82);

  // Fixed iso rig that pans (never rotates): panOffset shifts the eye and the
  // look-at together, so the view slides across the floor like the 2D drag-pan.
  let camera: THREE.OrthographicCamera;
  const CAM_EYE = new THREE.Vector3(20, 17, 20);
  const CAM_TARGET = new THREE.Vector3(0, 1.5, 0);
  const panOffset = new THREE.Vector3();
  function applyCamera(): void {
    camera.position.copy(CAM_EYE).add(panOffset);
    camera.lookAt(CAM_TARGET.x + panOffset.x, CAM_TARGET.y + panOffset.y, CAM_TARGET.z + panOffset.z);
  }
  function makeCamera(): void {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    const a = w / h;
    // frames the whole floor on a landscape window; widens for narrow ones
    const d = Math.max(18.5, 30 / a);
    camera = new THREE.OrthographicCamera(-d * a, d * a, d, -d, -90, 180);
    applyCamera();
  }
  function resize(): void {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    makeCamera();
  }
  makeCamera();
  /** drag the floor: pixel delta → world slide along the camera's own axes */
  const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();
  function panBy(dxPx: number, dyPx: number): void {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const ux = (camera.right - camera.left) / w;
    const uy = (camera.top - camera.bottom) / h;
    camera.matrixWorld.extractBasis(_r, _u, _f);
    panOffset.addScaledVector(_r, -dxPx * ux);
    panOffset.addScaledVector(_u, dyPx * uy);
    applyCamera();
  }

  // ── lighting ──
  const ambient = new THREE.AmbientLight(0xbcd0ff, 0.55);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xfff0d8, 1.2);
  key.position.set(16, 26, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const S = 20;
  key.shadow.camera.left = -S; key.shadow.camera.right = S; key.shadow.camera.top = S; key.shadow.camera.bottom = -S;
  key.shadow.camera.near = 1; key.shadow.camera.far = 80; key.shadow.bias = -0.0004;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x5b7cff, 0.35);
  fill.position.set(-12, 10, -8);
  scene.add(fill);

  // ── materials/helpers ──
  const mat = (c: number, rough = 0.92, metal = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal });
  function box(w: number, h: number, d: number, m: THREE.Material, cast = true): THREE.Mesh {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.castShadow = cast; b.receiveShadow = true;
    return b;
  }

  // ── room: a bright office plate floating in a dark void ──
  // Deliberately wider than the desks need — like the demo, the floor has room to
  // breathe, and the props (lounge, plants, lamps, meeting area) live in that margin.
  const FLOOR_W = 44, FLOOR_D = 34;
  const HX = FLOOR_W / 2, HZ = FLOOR_D / 2; // 22, 17
  const floor = box(FLOOR_W, 0.5, FLOOR_D, mat(0xf2f5fa, 0.95), false);
  floor.position.y = -0.25; floor.castShadow = false; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(FLOOR_W, 22, 0xc2cbd8, 0xd8dfe9);
  grid.position.y = 0.02;
  (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.45;
  scene.add(grid);
  const rimMat = mat(0xfafcfe, 0.9);
  ([[0, -HZ + 0.3, FLOOR_W, 0.6], [0, HZ - 0.3, FLOOR_W, 0.6], [-HX + 0.3, 0, 0.6, FLOOR_D], [HX - 0.3, 0, 0.6, FLOOR_D]] as const)
    .forEach(([x, z, w, d]) => {
      const rim = box(w, 0.7, d, rimMat, false); rim.position.set(x, 0.1, z); rim.receiveShadow = true; scene.add(rim);
    });
  // ── wall boards: Scrum + Team Velocity, fed the same WallBoardData as the 2D office ──
  let night = false; // declared here: the boards redraw darker at night
  interface WallBoard { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture }
  function makeWallBoard(x: number, w: number, h: number): WallBoard {
    const c = document.createElement("canvas");
    c.width = Math.round(w * 64); c.height = Math.round(h * 64);
    const ctx = c.getContext("2d")!;
    const tex = new THREE.CanvasTexture(c);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
    mesh.position.set(x, 3.1, -HZ - 0.05); // hung on the back wall, unlit → reads as a screen
    scene.add(mesh);
    return { ctx, tex };
  }
  const scrumBoard = makeWallBoard(-5.5, 10, 5);
  const veloBoard = makeWallBoard(6.5, 6.5, 5);
  let boardData: WallBoardData = { scrum: null, velocityUsd: null };
  function drawBoards(): void {
    const panel = (b: WallBoard, title: string, body: (ctx: CanvasRenderingContext2D, W: number, H: number) => void): void => {
      const { ctx, tex } = b;
      const W = ctx.canvas.width, H = ctx.canvas.height;
      ctx.fillStyle = night ? "#06222a" : "#0b3440"; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "#0deef3"; ctx.lineWidth = 8; ctx.strokeRect(5, 5, W - 10, H - 10);
      ctx.textAlign = "left";
      ctx.fillStyle = "#7fe9dd"; ctx.font = "bold 42px ui-monospace, monospace";
      ctx.fillText(title, 26, 60);
      body(ctx, W, H);
      tex.needsUpdate = true;
    };
    panel(scrumBoard, t("wall.scrumBoard"), (ctx) => {
      const s = boardData.scrum;
      if (!s) {
        ctx.fillStyle = "#4b6b73"; ctx.font = "30px ui-monospace, monospace";
        ctx.fillText(t("wall.daemonOffline"), 26, 128);
        return;
      }
      ([[t("wall.queued"), s.todo, "#94a3b8"], [t("wall.inProgress"), s.inProgress, "#ff9100"], ["Xong", s.done, "#00e676"]] as const)
        .forEach(([label, n, col], i) => {
          const x = 26 + i * 205;
          ctx.fillStyle = "#8fa0ba"; ctx.font = "26px ui-monospace, monospace"; ctx.fillText(label, x, 116);
          ctx.fillStyle = col; ctx.font = "bold 62px ui-monospace, monospace"; ctx.fillText(String(n), x, 180);
        });
      ctx.fillStyle = "#9fb2c9"; ctx.font = "24px ui-monospace, monospace";
      s.titles.slice(0, 3).forEach((t, i) => ctx.fillText("• " + t.slice(0, 36), 26, 232 + i * 30));
    });
    panel(veloBoard, t("wall.productivity"), (ctx) => {
      const v = boardData.velocityUsd;
      if (v === null) {
        ctx.fillStyle = "#4b6b73"; ctx.font = "30px ui-monospace, monospace";
        ctx.fillText(t("wall.daemonOffline"), 26, 128);
        return;
      }
      ctx.fillStyle = "#8fa0ba"; ctx.font = "26px ui-monospace, monospace"; ctx.fillText(t("wall.last24h"), 26, 116);
      ctx.fillStyle = "#f5a623"; ctx.font = "bold 72px ui-monospace, monospace";
      ctx.fillText("$" + v.toFixed(2), 26, 194);
    });
  }
  drawBoards(); // seed: shows "daemon ngoại tuyến" until main.ts feeds real data

  const MEET_CENTER = new THREE.Vector3(-13.5, 0, 11.5);

  // ── props ──
  function makePlant(x: number, z: number, s = 1): void {
    const g = new THREE.Group();
    const pot = box(0.8, 0.8, 0.8, mat(0x6b4d30)); pot.position.y = 0.4; g.add(pot);
    [0, 1, 2].forEach((i) => {
      const l = box(0.45, 1.3, 0.45, mat(0x3f9d63));
      l.position.set((i - 1) * 0.36, 1.35, 0); l.rotation.z = (i - 1) * 0.42; g.add(l);
    });
    g.position.set(x, 0, z); g.scale.setScalar(s); scene.add(g);
  }
  function makeLamp(x: number, z: number, rot = 0): void {
    const g = new THREE.Group();
    const pole = box(0.07, 2.5, 0.07, mat(0xd7dde6)); pole.position.y = 1.25; g.add(pole);
    const shade = box(0.82, 0.34, 0.56, mat(0x141a24)); shade.position.y = 2.56; shade.rotation.x = -0.2; g.add(shade);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.4), new THREE.MeshBasicMaterial({ color: 0xfff2d0 }));
    glow.rotation.x = Math.PI / 2; glow.position.set(0, 2.37, 0.03); g.add(glow);
    g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
  }
  function makeColumn(x: number, z: number): void {
    const c = box(0.42, 8, 0.42, mat(0xeef2f7), false); c.position.set(x, 4, z); c.receiveShadow = true; scene.add(c);
  }
  function makeSofa(x: number, z: number, rot = 0): void {
    const g = new THREE.Group();
    const seat = box(3.2, 0.42, 1.3, mat(0xe9edf3)); seat.position.y = 0.52; g.add(seat);
    const back = box(3.2, 0.8, 0.26, mat(0xe9edf3)); back.position.set(0, 0.98, -0.52); g.add(back);
    [-1.6, 1.6].forEach((ax) => { const arm = box(0.26, 0.58, 1.3, mat(0xdfe4ec)); arm.position.set(ax, 0.76, 0); g.add(arm); });
    g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
  }
  function makeWallScreen(x: number, z: number, rot: number, hex: number): void {
    const g = new THREE.Group();
    const pole = box(0.06, 2.2, 0.06, mat(0xc9d2dd)); pole.position.y = 1.1; g.add(pole);
    const panel = box(1.4, 0.9, 0.08, mat(0x141a24)); panel.position.y = 2.45; g.add(panel);
    const lit = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.68), new THREE.MeshBasicMaterial({ color: hex }));
    lit.position.set(0, 2.45, 0.05); g.add(lit);
    g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
  }
  // lamps down the central walkway (z ≈ -1, between the two desk rows) + open corners
  ([[-18, -1, 0], [-10.5, -1, 0], [-3.5, -1, 0], [3.5, -1, 0], [10.5, -1, 0], [18, -1, 0],
    [-17.5, 8.5, 0.5], [12, -12.5, -0.4], [8, 13, 0.3]] as const)
    .forEach(([x, z, r]) => makeLamp(x, z, r));
  ([[20, 7, 1], [-20, -12, 1.15], [18.5, -7, 0.9], [-17, 15, 1], [14.5, 15, 0.85], [0, 15.2, 1.05], [-20.5, -3, 0.9]] as const)
    .forEach(([x, z, s]) => makePlant(x, z, s));
  ([[-21, -15.8], [21, -15.8], [-21, 15.8]] as const).forEach(([x, z]) => makeColumn(x, z));
  makeSofa(-19.5, 3, Math.PI / 2); // lounge against the left edge, facing the room

  // filing cabinet — click it to open the outputs panel (same as the 2D office).
  // Tagged with a furnitureId so the raycast can resolve it without a special case.
  const cabinet = new THREE.Group();
  const cabBody = box(1.5, 2.3, 1.1, mat(0x8d99ae, 0.7)); cabBody.position.y = 1.15; cabinet.add(cabBody);
  [0.35, 1.15, 1.95].forEach((y) => {
    const drawer = box(1.3, 0.62, 0.06, mat(0x5b6478, 0.6));
    drawer.position.set(0, y, 0.56); cabinet.add(drawer);
  });
  // left-middle of the plate: the back corners project up under the app's own
  // overlay panels, where the cabinet renders but can never be clicked.
  cabinet.position.set(-20, 0, 7.5);
  cabinet.userData.furnitureId = "filing_cabinet";
  scene.add(cabinet);

  // ── stations (semantic-mapping §2): the office's core metaphor — an agent
  // stands where the work happens. model.station is set by the reducer from the
  // tool in flight, and alert statuses keep the old station (= freeze in place).
  {
    // bookshelf = reading files
    const shelf = new THREE.Group();
    shelf.add(box(3.4, 3.2, 0.5, mat(0x6b4d30)));
    [0.5, 1.4, 2.3].forEach((y) => {
      const board = box(3.2, 0.1, 0.7, mat(0x8a6a44)); board.position.set(0, y - 1.6 + 0.05, 0.1); shelf.add(board);
      for (let i = 0; i < 7; i++) {
        const bk = box(0.16, 0.5, 0.34, mat([0x8b5cf6, 0x0deef3, 0xff9100, 0x00e676, 0xff4081][i % 5]));
        bk.position.set(-1.4 + i * 0.45, y - 1.6 + 0.3, 0.1); shelf.add(bk);
      }
    });
    shelf.position.set(-9, 1.6, -14.6);
    scene.add(shelf);
    // arcade cabinet = running commands (terminal as arcade machine)
    const arc = new THREE.Group();
    arc.add(box(1.6, 2.4, 1.0, mat(0x1b2433)));
    const arcScreen = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.8), new THREE.MeshBasicMaterial({ color: 0x00e676 }));
    arcScreen.position.set(0, 0.5, 0.51); arc.add(arcScreen);
    const marquee = box(1.6, 0.4, 1.0, mat(0xff9100)); marquee.position.y = 1.4; arc.add(marquee);
    arc.position.set(9, 1.2, -14.6);
    scene.add(arc);
  }
  /** where an agent stands for each station; index picks a slot within it */
  const STATION_SLOTS: Record<Exclude<StationId, "desk">, THREE.Vector3[]> = {
    bookshelf: [[-10.6, -12.8], [-9, -12.8], [-7.4, -12.8], [-10.6, -11.4], [-7.4, -11.4]].map(([x, z]) => new THREE.Vector3(x, 0, z)),
    arcade: [[7.4, -12.8], [9, -12.8], [10.6, -12.8], [7.4, -11.4], [10.6, -11.4]].map(([x, z]) => new THREE.Vector3(x, 0, z)),
    // "meeting" = delegating to sub-agents — they gather at the same table the
    // stand-up uses, on the far side so a stand-up and a delegation don't overlap.
    meeting: [0, 1, 2, 3, 4].map((k) => {
      const ang = Math.PI + (k - 2) * 0.42;
      return new THREE.Vector3(MEET_CENTER.x + Math.sin(ang) * 2.5, 0, MEET_CENTER.z + Math.cos(ang) * 2.5);
    }),
  };
  /** the CEO decision line: a physical FIFO queue in front of the CEO desk */
  const ceoLineSlot = (i: number): THREE.Vector3 => new THREE.Vector3(-2.4 + (i % 5) * 1.2, 0, -10.2);
  makeWallScreen(-21.7, -8, Math.PI / 2, 0x0deef3);
  makeWallScreen(21.7, -4, -Math.PI / 2, 0xff9100);
  makeWallScreen(-21.7, 6, Math.PI / 2, 0x7c4dff);
  makeWallScreen(21.7, 8, -Math.PI / 2, 0x00e676);

  const meetTop = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.45, 0.14, 28), mat(0xe9edf3));
  meetTop.position.set(MEET_CENTER.x, 0.95, MEET_CENTER.z); meetTop.castShadow = true; meetTop.receiveShadow = true; scene.add(meetTop);
  const meetLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.34, 0.9, 16), mat(0xc3ccd8));
  meetLeg.position.set(MEET_CENTER.x, 0.45, MEET_CENTER.z); meetLeg.castShadow = true; scene.add(meetLeg);

  const SRV_X = 19, SRV_Z = -12;
  const server = box(1.4, 4, 1.4, mat(0x11161f)); server.position.set(SRV_X, 2, SRV_Z); scene.add(server);
  const serverLeds: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const led = box(0.9, 0.18, 0.05, new THREE.MeshBasicMaterial({ color: 0x1a3524 }));
    led.position.set(SRV_X, 3.4 - i * 0.5, SRV_Z + 0.72); led.castShadow = false;
    scene.add(led); serverLeds.push(led);
  }

  // ── seats (pure furniture) ──
  interface Seat {
    group: THREE.Group; i: number;
    screen: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
    label: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; sprite: THREE.Sprite };
    light: THREE.PointLight;
    agentId?: string;
  }
  function makeSeat(i: number, ceo = false): Seat {
    const g = new THREE.Group();
    const dw = ceo ? 3.6 : 2.5; // the boss gets a wider desk
    const deskTop = box(dw, 0.18, 1.5, mat(ceo ? 0x6d4a28 : 0x8a6a44)); deskTop.position.set(0, 1.28, 0.45); g.add(deskTop);
    const lx = dw / 2 - 0.15;
    [[-lx, -0.15], [lx, -0.15], [-lx, 1.05], [lx, 1.05]].forEach(([x, z]) => {
      const leg = box(0.14, 1.2, 0.14, mat(0x5c4127)); leg.position.set(x, 0.6, z); g.add(leg);
    });
    const kbd = box(1.1, 0.06, 0.42, mat(0x1b2433)); kbd.position.set(0, 1.4, 0.6); g.add(kbd);
    const mug = box(0.24, 0.3, 0.24, mat(0xd9654b)); mug.position.set(0.86, 1.52, 0.15); g.add(mug);
    const frame = box(1.7, 1.02, 0.12, mat(0x0e1420)); frame.position.set(0, 1.98, 0.9); g.add(frame);
    const stand = box(0.16, 0.5, 0.16, mat(0x0e1420)); stand.position.set(0, 1.5, 0.9); g.add(stand);
    const sc = document.createElement("canvas"); sc.width = 256; sc.height = 152;
    const sctx = sc.getContext("2d")!;
    const stex = new THREE.CanvasTexture(sc);
    const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.86), new THREE.MeshBasicMaterial({ map: stex }));
    screenMesh.position.set(0, 1.98, 0.97); g.add(screenMesh);
    const chairBack = box(0.98, 1.0, 0.16, mat(0x232c3b)); chairBack.position.set(0, 1.65, -1.05); g.add(chairBack);
    const chairSeat = box(0.98, 0.16, 0.8, mat(0x232c3b)); chairSeat.position.set(0, 1.12, -0.65); g.add(chairSeat);
    if (ceo) {
      // no cubicle wall for the boss — an open desk on a rug reads as "the CEO spot"
      const rug = box(5.6, 0.04, 4.4, mat(0x33415c, 0.98), false);
      rug.position.set(0, 0.03, -0.3); rug.receiveShadow = true; g.add(rug);
    } else {
      // width == seat spacing, so neighbours butt up into one long open-plan strip
      const part = box(7, 1.6, 0.1, mat(0xe7ecf3, 0.96)); part.position.set(0, 0.8, -1.55); part.receiveShadow = true;
      (part.material as THREE.MeshStandardMaterial).emissive.setHex(0x424c5e); g.add(part);
    }
    const lc = document.createElement("canvas"); lc.width = 256; lc.height = 72;
    const lctx = lc.getContext("2d")!;
    const ltex = new THREE.CanvasTexture(lc);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ltex, transparent: true, depthTest: false }));
    sprite.scale.set(3.4, 0.96, 1); sprite.position.set(0, 3.45, -0.2); g.add(sprite);
    const light = new THREE.PointLight(0x39d7c8, 0.5, 6, 2); light.position.set(0, 1.98, 1.25); g.add(light);
    g.userData.seatIndex = i;
    return { group: g, i, screen: { ctx: sctx, tex: stex }, label: { ctx: lctx, tex: ltex, sprite }, light };
  }
  const COLS = 5, ROWS = 2;
  const seats: Seat[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const s = makeSeat(r * COLS + c);
      s.group.position.set(-14 + c * 7, 0, -6 + r * 10); // spacing 7 == partition width
      scene.add(s.group);
      seats.push(s);
    }
  }
  // The CEO desk: its own spot at the head of the room, under the board. Reserved —
  // only the pinned PM sits here (mirrors the 2D layout's CEO_SPOT).
  const CEO_SEAT = seats.length;
  const ceoSeat = makeSeat(CEO_SEAT, true);
  ceoSeat.group.position.set(0, 0, -12.5);
  scene.add(ceoSeat.group);
  seats.push(ceoSeat);
  function seatStand(i: number): THREE.Vector3 {
    const p = seats[i].group.position;
    return new THREE.Vector3(p.x, 0, p.z - 0.55);
  }

  // ── characters ──
  type CharModel = { scene: THREE.Object3D; anims: THREE.AnimationClip[]; scale: number; y: number };
  const MODELS: Record<string, CharModel> = {};
  let curKind: Kind = "screen";
  interface Char {
    group: THREE.Group; inner: THREE.Object3D;
    mixer?: THREE.AnimationMixer; clips: THREE.AnimationClip[]; curClip?: string;
    legs: THREE.Object3D[]; phase: number;
    face?: Face;
    skin: Skin; home: number;
    state: "walkIn" | "atDesk" | "toMeet" | "atMeet" | "walkOut";
    target: THREE.Vector3;
    bubble?: Bubble; // speech bubble (agents only)
    /** a hiring-hall greeter, not an agent: reconcile ignores it, and it leaves on its own */
    greeter?: { until: number };
  }
  const chars = new Map<string, Char>();
  const seatOf = new Map<string, number>();
  const ENTRANCE = new THREE.Vector3(19, 0, 14); // the "door", front-right of the plate
  let pinnedId: string | null = null; // the PM — owns the CEO desk
  let focusId: string | null = null; // camera is easing to centre this agent

  function findClip(anims: THREE.AnimationClip[], name: string): THREE.AnimationClip | undefined {
    return THREE.AnimationClip.findByName(anims, name)
      ?? anims.find((c) => c.name.toLowerCase() === name.toLowerCase())
      ?? anims.find((c) => /idle/i.test(c.name))
      ?? anims[0];
  }
  function makeGlb(kind: Kind, skin: Skin): { inner: THREE.Object3D; mixer: THREE.AnimationMixer; clips: THREE.AnimationClip[] } {
    const m = MODELS[kind];
    const c = cloneSkinned(m.scene) as THREE.Object3D;
    c.scale.setScalar(m.scale); c.rotation.y = Math.PI; c.position.y = m.y;
    c.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((x) => x.clone()) : mesh.material.clone();
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((mm) => {
        const sm = mm as THREE.MeshStandardMaterial;
        if (sm.color) sm.color.setHex(skin.accent);
        if (sm.emissive) { sm.emissive.setHex(skin.accent); sm.emissiveIntensity = 0.32; }
      });
    });
    return { inner: c, mixer: new THREE.AnimationMixer(c), clips: m.anims };
  }
  function buildInner(kind: Kind, skin: Skin): { inner: THREE.Object3D; mixer?: THREE.AnimationMixer; clips: THREE.AnimationClip[]; legs: THREE.Object3D[]; face?: Face } {
    if (kind !== "screen" && MODELS[kind]) { const g = makeGlb(kind, skin); return { inner: g.inner, mixer: g.mixer, clips: g.clips, legs: [] }; }
    const b = chosenBuilder(skin);
    return { inner: b.inner, clips: [], legs: b.legs, face: attachFace(b.inner, skin) ?? undefined };
  }
  function playClip(ch: Char, want: string): void {
    if (!ch.mixer || !ch.clips.length || ch.curClip === want) return;
    ch.curClip = want;
    const clip = findClip(ch.clips, want);
    if (!clip) return;
    ch.mixer.stopAllAction();
    ch.mixer.clipAction(clip).reset().fadeIn(0.2).play();
  }
  function makeChar(agentId: string, skin: Skin, home: number): Char {
    const built = buildInner(curKind, skin);
    const group = new THREE.Group();
    group.add(built.inner);
    group.position.copy(ENTRANCE);
    group.userData.agentId = agentId;
    scene.add(group);
    const bubble = makeBubble();
    group.add(bubble.sprite);
    const ch: Char = { group, inner: built.inner, mixer: built.mixer, clips: built.clips, legs: built.legs, face: built.face, bubble, phase: 0, skin, home, state: "walkIn", target: seatStand(home) };
    playClip(ch, "Idle");
    chars.set(agentId, ch);
    return ch;
  }
  function rebuildChars(kind: Kind): void {
    curKind = kind;
    chars.forEach((ch) => {
      ch.group.remove(ch.inner);
      const built = buildInner(kind, ch.skin);
      ch.group.add(built.inner);
      ch.inner = built.inner; ch.mixer = built.mixer; ch.clips = built.clips; ch.legs = built.legs; ch.face = built.face; ch.curClip = undefined;
      playClip(ch, "Idle");
    });
  }
  // ── CEO avatar: represents you in the office. Wanders between activity spots
  // and heads back to the desk the moment someone is waiting on a decision.
  // Timing/choice come from render/ceoActivity.ts — pure and already unit-tested.
  const CEO_SPOT3D: Record<CeoActivity, THREE.Vector3> = {
    desk: new THREE.Vector3(0, 0, -11.4),
    cooler: new THREE.Vector3(-6.5, 0, -10.5),
    sofa: new THREE.Vector3(-18.4, 0, 3),
    window: new THREE.Vector3(13, 0, -13.5),
    phone: new THREE.Vector3(5.5, 0, -10.5),
    board: new THREE.Vector3(-5.5, 0, -13.8),
  };
  let ceoChar: Char | null = null;
  let ceoAct: CeoActivity = "desk";
  let ceoNextAt = 0; // seconds on the `elapsed` clock
  let ceoQueueLen = 0;
  function ensureCeo(): void {
    if (ceoChar) return;
    const skin = SKINS.find((s) => s.id === "cobalt") ?? SKINS[0];
    const built = buildInner(curKind, skin);
    const group = new THREE.Group();
    group.add(built.inner);
    group.position.copy(CEO_SPOT3D.desk);
    const label = makeNameSprite("CEO", skin.accent);
    label.position.set(0, 3.3, 0);
    group.add(label);
    scene.add(group);
    ceoChar = {
      group, inner: built.inner, mixer: built.mixer, clips: built.clips, legs: built.legs, face: built.face,
      phase: 0, skin, home: CEO_SEAT, state: "atDesk", target: CEO_SPOT3D.desk.clone(),
    };
  }
  function stepCeo(dt: number, instant = false, repaint = true): void {
    ensureCeo();
    if (!ceoChar) return;
    const blocked = ceoQueueLen > 0;
    const changeDue = elapsed >= ceoNextAt;
    const want = nextCeoActivity(ceoAct, blocked, changeDue, Math.random);
    if (want !== ceoAct) { ceoAct = want; sendTo(ceoChar, CEO_SPOT3D[want]); }
    if (changeDue) ceoNextAt = elapsed + ceoActivityDelay(Math.random()) / 1000;
    stepChar(ceoChar, dt, instant);
    ceoChar.mixer?.update(dt);
    if (repaint && ceoChar.face) drawFace(ceoChar.face, ceoChar.skin, blocked ? "ask" : "work", elapsed);
  }

  // ── hiring-hall greeter: a new skill walks in, waves near reception, leaves ──
  const GREET_SPOT = new THREE.Vector3(12, 0, 9);
  const GREET_SECONDS = 9;
  let greeterN = 0;
  function walkInGreeter(skillName: string): void {
    const id = `greeter:${skillName}:${greeterN}`;
    const skin = SKINS[hashStr(skillName) % SKINS.length];
    const built = buildInner(curKind, skin);
    const group = new THREE.Group();
    group.add(built.inner);
    group.position.copy(ENTRANCE);
    scene.add(group);
    // simultaneous walk-ins line up instead of stacking on one spot
    const slot = GREET_SPOT.clone();
    slot.x -= (greeterN % 3) * 1.6;
    greeterN++;
    const ch: Char = {
      group, inner: built.inner, mixer: built.mixer, clips: built.clips, legs: built.legs, face: built.face,
      phase: 0, skin, home: 0, state: "walkIn", target: slot, greeter: { until: 0 },
    };
    const label = makeNameSprite(skillName, skin.accent);
    label.position.set(0, 3.3, 0);
    group.add(label);
    playClip(ch, "Idle");
    chars.set(id, ch);
  }
  function meetSlot(k: number): THREE.Vector3 {
    const ang = (k / 8) * Math.PI * 2;
    return new THREE.Vector3(MEET_CENTER.x + Math.sin(ang) * 2.5, 0, MEET_CENTER.z + Math.cos(ang) * 2.5);
  }
  let meeting = false;
  function toggleMeeting(): boolean {
    meeting = !meeting;
    let k = 0;
    chars.forEach((ch) => {
      if (ch.state === "walkOut" || ch.greeter) return; // greeters aren't invited
      if (meeting) { ch.state = "toMeet"; ch.target = meetSlot(k++); }
      else { ch.state = "walkIn"; ch.target = seatStand(ch.home); }
    });
    return meeting;
  }
  const MOVE = 8.5; // walk speed (u/s) — bumped from 4.4 so agents don't crawl; tune here
  const _d = new THREE.Vector3();
  function stepChar(ch: Char, dt: number, instant = false): void {
    const moving = ch.state === "walkIn" || ch.state === "toMeet" || ch.state === "walkOut";
    if (!moving) { ch.legs.forEach((l) => (l.rotation.x = 0)); return; }
    _d.copy(ch.target).sub(ch.group.position); _d.y = 0;
    const dist = _d.length();
    // time-lapse: at 16-60x the state moves far faster than 4.4 u/s, so walking
    // never arrives — snap to the target instead (what the 2D office did).
    if (!instant && dist > 0.12) {
      _d.normalize();
      ch.group.position.addScaledVector(_d, Math.min(MOVE * dt, dist));
      ch.group.rotation.y = Math.atan2(_d.x, _d.z);
      if (ch.clips.length) playClip(ch, "Walking");
      else {
        ch.phase += dt * 14; // leg-swing cadence — matches the faster MOVE above
        const sw = Math.sin(ch.phase) * 0.5;
        ch.legs.forEach((l, i) => (l.rotation.x = i % 2 ? -sw : sw));
      }
      return;
    }
    ch.group.position.copy(ch.target);
    ch.legs.forEach((l) => (l.rotation.x = 0));
    if (ch.state === "walkOut") return;
    if (ch.state === "toMeet") { _d.copy(MEET_CENTER).sub(ch.group.position); ch.group.rotation.y = Math.atan2(_d.x, _d.z); ch.state = "atMeet"; }
    else { ch.group.rotation.y = 0; ch.state = "atDesk"; }
    playClip(ch, "Idle");
  }

  // The GLB kinds load ON DEMAND. The office ships as "screen" (procedural, no
  // asset), so eager-loading meant every boot pulled ~3MB of models that could
  // never be rendered unless someone actually switched kind.
  const loader = new GLTFLoader();
  const loadModel = (url: string) =>
    new Promise<{ scene: THREE.Object3D; anims: THREE.AnimationClip[] }>((res, rej) =>
      loader.load(url, (g) => res({ scene: g.scene, anims: g.animations }), undefined, rej));
  const GLB: Record<string, { url: string; scale: number; y: number }> = {
    robot: { url: "/models/RobotExpressive.glb", scale: 0.34, y: 1.05 },
  };
  async function ensureModel(kind: Kind): Promise<boolean> {
    if (kind === "screen") return true;
    if (MODELS[kind]) return true;
    const cfg = GLB[kind];
    if (!cfg) return false;
    try {
      const g = await loadModel(cfg.url);
      MODELS[kind] = { ...g, scale: cfg.scale, y: cfg.y };
      return true;
    } catch {
      return false; // model missing → caller keeps the current kind
    }
  }

  // ── monitor + desk label ──
  // ── speech bubbles: the PM's chat replies pop over the agent (same 4s window
  // and the same model.message{text,at} the 2D sprite used) ──
  const BUBBLE_MS = 4_000;
  interface Bubble { sprite: THREE.Sprite; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; text: string }
  function makeBubble(): Bubble {
    const c = document.createElement("canvas"); c.width = 320; c.height = 128;
    const ctx = c.getContext("2d")!;
    const tex = new THREE.CanvasTexture(c);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(4.4, 1.76, 1);
    sprite.position.set(0, 4.4, 0);
    sprite.visible = false;
    return { sprite, ctx, tex, text: "" };
  }
  function drawBubble(b: Bubble, text: string): void {
    if (b.text === text) return; // only repaint when the line actually changes
    b.text = text;
    const x = b.ctx, W = 320, H = 128;
    x.clearRect(0, 0, W, H);
    x.fillStyle = "rgba(12,17,26,.95)";
    x.beginPath(); x.roundRect(6, 6, W - 12, H - 32, 14); x.fill();
    x.strokeStyle = "#38e0d0"; x.lineWidth = 2; x.stroke();
    x.beginPath(); x.moveTo(W / 2 - 13, H - 26); x.lineTo(W / 2 + 13, H - 26); x.lineTo(W / 2, H - 4);
    x.closePath(); x.fillStyle = "rgba(12,17,26,.95)"; x.fill();
    x.fillStyle = "#e8ecf4"; x.font = "20px ui-monospace, monospace"; x.textAlign = "center";
    const lines: string[] = [];
    let line = "";
    for (const w of text.split(/\s+/)) {
      const candidate = line ? line + " " + w : w;
      if (x.measureText(candidate).width > W - 44) { if (line) lines.push(line); line = w; } else line = candidate;
      if (lines.length >= 3) break;
    }
    if (line && lines.length < 3) lines.push(line);
    lines.slice(0, 3).forEach((l, i) => x.fillText(l, W / 2, 40 + i * 26));
    b.tex.needsUpdate = true;
  }

  /** a floating name tag (used by greeters, who have no desk to hang a label on) */
  function makeNameSprite(text: string, hex: number): THREE.Sprite {
    const c = document.createElement("canvas"); c.width = 256; c.height = 64;
    const x = c.getContext("2d")!;
    x.fillStyle = "rgba(10,14,22,.92)";
    x.beginPath(); x.roundRect(4, 6, 248, 50, 12); x.fill();
    x.strokeStyle = "#" + hex.toString(16).padStart(6, "0"); x.lineWidth = 2; x.stroke();
    x.fillStyle = "#e8ecf4"; x.font = "bold 22px ui-monospace, monospace"; x.textAlign = "center";
    x.fillText(text.slice(0, 18), 128, 38);
    const tex = new THREE.CanvasTexture(c);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    s.scale.set(3, 0.75, 1);
    return s;
  }
  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawScreen(s: Seat, a: AgentModel | null, nowMs: number): void {
    const ctx = s.screen.ctx;
    ctx.fillStyle = night ? "#04171e" : "#082330"; ctx.fillRect(0, 0, 256, 152);
    if (!a) { ctx.fillStyle = "#12303a"; ctx.font = "12px monospace"; ctx.fillText(t("wall.empty"), 90, 80); s.screen.tex.needsUpdate = true; return; }
    const tint = "#" + agentColor(a).toString(16).padStart(6, "0");
    ctx.fillStyle = tint; ctx.fillRect(0, 0, 256, 26);
    ctx.fillStyle = "#04141a"; ctx.font = "bold 15px monospace"; ctx.fillText(a.name, 8, 18);
    ctx.fillStyle = "#" + (statusHue[a.status] ?? 0x7fe9dd).toString(16).padStart(6, "0");
    ctx.font = "13px monospace"; ctx.fillText(statusLabel(a.status), 10, 48);
    for (let i = 0; i < 5; i++) {
      const w = 26 + (Math.sin(nowMs / 380 + i * 1.3 + s.i) * 0.5 + 0.5) * 200;
      ctx.fillStyle = i % 2 ? "rgba(45,212,191,.55)" : "rgba(56,189,248,.5)";
      ctx.fillRect(10, 62 + i * 16, w, 9);
    }
    s.screen.tex.needsUpdate = true;
  }
  function drawLabel(s: Seat, a: AgentModel): void {
    const ctx = s.label.ctx; ctx.clearRect(0, 0, 256, 72);
    ctx.fillStyle = "rgba(10,14,22,.9)"; roundRect(ctx, 6, 8, 244, 52, 12); ctx.fill();
    ctx.fillStyle = "#e8ecf4"; ctx.font = "bold 22px ui-monospace, monospace"; ctx.textAlign = "center";
    ctx.fillText(a.name, 128, 32);
    ctx.fillStyle = "#" + (statusHue[a.status] ?? 0x9aa6bd).toString(16).padStart(6, "0");
    ctx.font = "16px ui-monospace, monospace"; ctx.fillText(statusLabel(a.status), 128, 52);
    ctx.textAlign = "left";
    s.label.tex.needsUpdate = true;
  }

  // ── pointer: drag to pan, click (no drag) to pick an agent ──
  // 4px dead zone so a real click still picks; any actual drag cancels the
  // focus-pan so the ticker can't wrestle the hand (same rule as the 2D office).
  const raycaster = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  /** what's under this screen point: a tagged prop, an agent, or nothing */
  function resolvePick(clientX: number, clientY: number): { agentId?: string; furnitureId?: string; hit?: string } {
    const r = canvas.getBoundingClientRect();
    ptr.x = ((clientX - r.left) / r.width) * 2 - 1;
    ptr.y = -((clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(ptr, camera);
    const targets: THREE.Object3D[] = [cabinet, ...seats.map((s) => s.group), ...[...chars.values()].map((c) => c.group)];
    const hits = raycaster.intersectObjects(targets, true);
    if (!hits.length) return {};
    let o: THREE.Object3D | null = hits[0].object;
    const hit = o.name || o.type;
    let agentId: string | undefined;
    let furnitureId: string | undefined;
    while (o && !agentId && !furnitureId) {
      if (typeof o.userData.furnitureId === "string") furnitureId = o.userData.furnitureId;
      else if (typeof o.userData.agentId === "string") agentId = o.userData.agentId;
      else if (o.userData.seatIndex !== undefined) agentId = seats[o.userData.seatIndex as number].agentId;
      o = o.parent;
    }
    return { agentId, furnitureId, hit };
  }
  function pick(ev: PointerEvent): void {
    const { agentId, furnitureId } = resolvePick(ev.clientX, ev.clientY);
    if (furnitureId) opts.onFurniture?.(furnitureId);
    else if (agentId) opts.onPick?.(agentId);
  }
  const DRAG_PX = 4;
  let dragging = false, moved = false, downX = 0, downY = 0, lastX = 0, lastY = 0;
  canvas.style.cursor = "grab";
  function onDown(ev: PointerEvent): void {
    dragging = true; moved = false;
    downX = lastX = ev.clientX; downY = lastY = ev.clientY;
  }
  function onMove(ev: PointerEvent): void {
    if (!dragging) return;
    if (!moved && Math.abs(ev.clientX - downX) + Math.abs(ev.clientY - downY) > DRAG_PX) {
      moved = true; focusId = null; canvas.style.cursor = "grabbing";
    }
    if (moved) panBy(ev.clientX - lastX, ev.clientY - lastY);
    lastX = ev.clientX; lastY = ev.clientY;
  }
  function onUp(ev: PointerEvent): void {
    canvas.style.cursor = "grab";
    if (dragging && !moved) pick(ev);
    dragging = false;
  }
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", onUp);
  canvas.addEventListener("pointercancel", onUp);

  // ── reconcile: live agents → desks + characters ──
  let sinceReconcile = 1e9;
  let sincePaint = 1e9;
  let liveState: OfficeState | null = null;
  /** walk this character to a new goal (no-op if it's already heading there) */
  function sendTo(ch: Char, target: THREE.Vector3): void {
    if (ch.state === "toMeet" || ch.state === "atMeet" || ch.state === "walkOut") return; // stand-up / exit win
    if (ch.target.distanceTo(target) < 0.05) return;
    ch.target = target.clone();
    ch.state = "walkIn";
  }
  function reconcile(state: OfficeState, clockNow: number): void {
    const liveArr = [...state.agents.values()].filter((a) => a.despawnedAt === null);
    const liveIds = new Set(liveArr.map((a) => a.agentId));

    // Where each agent belongs this tick, in priority order:
    //   1. the CEO decision line (a real FIFO queue; the pinned PM stays put)
    //   2. its station (bookshelf / arcade / meeting) — the semantic-mapping metaphor
    //   3. its own desk
    const waiting = ceoQueue(state, clockNow);
    ceoQueueLen = waiting.length; // drives the CEO back to its desk
    const queuePos = new Map<string, THREE.Vector3>();
    waiting
      .filter((a) => a.agentId !== pinnedId)
      .forEach((a, i) => queuePos.set(a.agentId, ceoLineSlot(i)));
    const stationPos = new Map<string, THREE.Vector3>();
    const byStation = new Map<string, AgentModel[]>();
    liveArr.forEach((a) => {
      if (a.station === "desk" || queuePos.has(a.agentId)) return;
      const l = byStation.get(a.station) ?? [];
      l.push(a);
      byStation.set(a.station, l);
    });
    byStation.forEach((list, st) => {
      const slots = STATION_SLOTS[st as Exclude<StationId, "desk">] ?? [];
      // sort by id so slots don't shuffle between ticks as the set changes
      [...list].sort((x, y) => x.agentId.localeCompare(y.agentId))
        .forEach((a, i) => { if (slots.length) stationPos.set(a.agentId, slots[i % slots.length]); });
    });
    // the pinned PM owns the CEO desk; it stays reserved even when they're away
    if (pinnedId && liveIds.has(pinnedId)) seatOf.set(pinnedId, CEO_SEAT);
    const taken = new Set<number>([CEO_SEAT]);
    seatOf.forEach((idx, id) => { if (liveIds.has(id)) taken.add(idx); });
    liveArr.forEach((a) => {
      if (seatOf.has(a.agentId)) return;
      let free = 0; while (free < seats.length && taken.has(free)) free++;
      if (free < seats.length) { seatOf.set(a.agentId, free); taken.add(free); }
    });
    seats.forEach((s) => { s.agentId = undefined; s.label.sprite.visible = false; });
    liveArr.forEach((a) => {
      const idx = seatOf.get(a.agentId);
      if (idx === undefined) return;
      const s = seats[idx];
      s.agentId = a.agentId;
      s.label.sprite.visible = true;
      drawLabel(s, a);
      const ch = chars.get(a.agentId);
      if (!ch) { makeChar(a.agentId, agentSkin(a), idx); return; }
      ch.home = idx; // may have been re-homed (e.g. just pinned as PM)
      if (!meeting) sendTo(ch, queuePos.get(a.agentId) ?? stationPos.get(a.agentId) ?? seatStand(idx));
      if (ch.state === "atDesk") playClip(ch, clipMap[a.status] ?? "Idle");
    });
    chars.forEach((ch, id) => {
      if (ch.greeter) return; // not an agent — it shows itself out
      if (!liveIds.has(id) && ch.state !== "walkOut") { ch.state = "walkOut"; ch.target = ENTRANCE.clone(); seatOf.delete(id); }
    });
  }

  let elapsed = 0;
  const _want = new THREE.Vector3();
  function tick(state: OfficeState, dtMs: number, opts?: { now?: number; instant?: boolean }): void {
    liveState = state;
    const clockNow = opts?.now ?? Date.now(); // replay drives bubbles off its own clock
    const instant = opts?.instant === true;
    sinceReconcile += dtMs;
    if (sinceReconcile >= RECONCILE_MS) { reconcile(state, clockNow); sinceReconcile = 0; }
    sincePaint += dtMs;
    const repaint = sincePaint >= PAINT_MS;
    if (repaint) sincePaint = 0;

    const dt = Math.min(dtMs, 100) / 1000; // clamp: a backgrounded tab must not teleport agents
    elapsed += dt;
    const t = elapsed * 1000;

    // focus-pan: ease the view until the agent sits at screen centre, then release
    if (focusId) {
      const fc = chars.get(focusId);
      if (!fc) focusId = null;
      else {
        _want.set(fc.group.position.x - CAM_TARGET.x, panOffset.y, fc.group.position.z - CAM_TARGET.z);
        panOffset.lerp(_want, Math.min(1, dt * 4));
        applyCamera();
        if (panOffset.distanceTo(_want) < 0.08) focusId = null;
      }
    }

    stepCeo(dt, instant, repaint);

    const dead: string[] = [];
    chars.forEach((ch, id) => {
      stepChar(ch, dt, instant);
      ch.mixer?.update(dt);
      // greeters: once they reach reception they wave a while, then show themselves out
      if (ch.greeter) {
        if (ch.state === "atDesk") {
          if (!ch.greeter.until) { ch.greeter.until = elapsed + GREET_SECONDS; playClip(ch, "Wave"); }
          else if (elapsed > ch.greeter.until) { ch.state = "walkOut"; ch.target = ENTRANCE.clone(); }
        }
        if (repaint && ch.face) drawFace(ch.face, ch.skin, ch.state === "walkOut" ? "idle" : "done", elapsed);
      } else {
        const a = liveState?.agents.get(id);
        if (repaint && ch.face) {
          const mood = a && a.despawnedAt === null ? moodMap[a.status] ?? "work" : "idle";
          drawFace(ch.face, ch.skin, ch.state === "walkOut" ? "idle" : mood, elapsed);
        }
        if (ch.bubble) { // PM chat replies + agent messages pop for BUBBLE_MS
          const msg = a?.message;
          // no bubbles in time-lapse: at 16-60x they'd strobe (2D did the same)
          const show = !instant && !!msg && clockNow - msg.at < BUBBLE_MS && clockNow >= msg.at;
          ch.bubble.sprite.visible = show;
          if (show && msg) drawBubble(ch.bubble, msg.text);
        }
      }
      if (ch.state === "walkOut" && ch.group.position.distanceTo(ENTRANCE) < 0.25) dead.push(id);
    });
    dead.forEach((id) => { scene.remove(chars.get(id)!.group); chars.delete(id); });

    if (repaint) {
      seats.forEach((s) => {
        const a = s.agentId ? state.agents.get(s.agentId) : undefined;
        drawScreen(s, a && a.despawnedAt === null ? a : null, t);
      });
    }
    serverLeds.forEach((led, i) => ((led.material as THREE.MeshBasicMaterial).color.setHex(Math.sin(t / 300 + i * 2) > 0 ? (i % 2 ? 0x4ade80 : 0xf59e0b) : 0x1a2418)));
    renderer.render(scene, camera);
  }

  function setNight(on: boolean): void {
    night = on;
    ambient.intensity = on ? 0.1 : 0.55;
    key.intensity = on ? 0.12 : 1.2;
    fill.intensity = on ? 0.04 : 0.35;
    scene.background = new THREE.Color(on ? 0x04070d : 0x0d1117);
    (scene.fog as THREE.Fog).color.setHex(on ? 0x04070d : 0x0d1117);
    drawBoards(); // boards are canvases, not a tinted plane — redraw them darker
    seats.forEach((s) => (s.light.intensity = on ? 2.4 : 0.5));
  }

  return {
    canvas,
    tick,
    setNight,
    toggleMeeting,
    setKind: (k) => { void ensureModel(k).then((ok) => { if (ok) rebuildChars(k); }); },
    kind: () => curKind,
    pinAgent: (id) => { pinnedId = id; },
    focusAgent: (id) => { focusId = id; },
    recenter: () => { focusId = null; panOffset.set(0, 0, 0); applyCamera(); },
    setQuality: (level) => {
      const low = level === "low";
      renderer.shadowMap.enabled = !low;
      renderer.setPixelRatio(low ? 1 : Math.min(devicePixelRatio, 2));
      key.castShadow = !low;
      scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.receiveShadow = !low; });
      resize();
    },
    renderBoards: (d) => { boardData = d; drawBoards(); },
    walkInGreeter,
    hasKind: (k) => k === "screen" || !!MODELS[k],
    resize,
    probePick: resolvePick,
    debug: () => [...chars.entries()].map(([id, c]) => ({
      id: id.slice(0, 8), state: c.state, home: c.home,
      x: Math.round(c.group.position.x * 10) / 10, z: Math.round(c.group.position.z * 10) / 10,
      bubble: c.bubble?.sprite.visible === true,
    })),
    dispose() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      renderer.dispose();
      canvas.remove();
    },
  };
}
