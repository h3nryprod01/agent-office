// The 3D office as a mountable module (Path B, Phase 4 cutover).
//
// This is the renderer only: it owns a canvas + scene and is driven from
// outside by tick(state, dtMs). It holds NO event source and NO HUD, so the
// app can feed it the same repo-filtered state it feeds the Pixi office, and
// the app's own chrome (navbar, side panel, tabs) stays in charge.
//
// Mounted by src/main.ts as the "Văn phòng" view.

import { t, type Key } from "../i18n";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { statusLabel, type AgentModel, type OfficeState, type StationId } from "../sim/model";
import { ceoQueue } from "../sim/selectors";
import { ceoActivityDelay, nextCeoActivity, type CeoActivity } from "../render/ceoActivity";
import { type WallBoardData } from "../ui/wallBoardData";
import { chosenBuilder, attachFace, drawFace, SKINS, type Built, type Face, type Mood, type Skin } from "./robotKit";
import { daylightAt, hourOf, lerpHex, type Daylight } from "./daylight";
import { lookOf, displayName, withDemoLook, type AgentLook } from "./look";
import { buildAccessory } from "./accessories";
import { drawBadge, BADGE_PX } from "./badge";
import { markFor, markMaterial, MARK_PULSE, type MarkKind } from "./statusMark";
import * as PLAN from "./floorplan";
import { buildProps } from "./props";
import { THEMES, asRoomStyle, buildDecor, deskGrainTexture, floorTexture, type RoomStyle, type RoomTheme } from "./rooms";
import { SIT_LEG, advanceBlend, blendedAngles, initialBlend, poseModeFor, stepSpeed, turnToward, type PoseAngles, type PoseBlend } from "../render/pose";

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
  /** lane L8: pin the sky to an hour (0-24) for demos / screenshots; null = follow the real clock */
  setTimeOfDay(hour: number | null): void;
  /** lane L8: dev floor / content studio / sales floor — same stations, different room */
  setRoomStyle(style: RoomStyle): void;
  /** where an agent's head is on screen (client px), null when it is not in view — anchors HTML over a character */
  screenPos(agentId: string): { x: number; y: number } | null;
  roomStyle(): RoomStyle;
  /** models load async; false until the GLB kinds are ready */
  hasKind(kind: Kind): boolean;
  resize(): void;
  dispose(): void;
  /** dev-tools only: what each character is doing right now */
  debug(): { id: string; state: string; x: number; z: number; home: number; bubble: boolean; pose: string; sit: number; family: string }[];
  /** dev-tools only: what a screen point would pick */
  probePick(clientX: number, clientY: number): { agentId?: string; furnitureId?: string; hit?: string };
}

export interface Office3DOpts {
  /** clicking an agent (or their desk) */
  onPick?: (agentId: string) => void;
  /** clicking a tagged prop, e.g. "filing_cabinet" → the project folder */
  onFurniture?: (furnitureId: string, mods?: { shiftKey: boolean }) => void;
  /** clicking a desk or its screen (not the character): the desk's agent, if one sits there */
  onSeat?: (seat: { agentId?: string; part: "screen" | "desk"; ceo: boolean }) => void;
  /** right-clicking a character or its desk */
  onAgentMenu?: (agentId: string, clientX: number, clientY: number) => void;
  /** lane L8: which room to build (default: ?room=… or "dev") */
  roomStyle?: RoomStyle;
  /** lane L8: hand agents that carry no harness a demo uniform (default: on in ?mock=1 only) */
  demoLooks?: boolean;
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
/** what the body is actually painted: the harness uniform if it has one, else the per-name skin */
export const agentBodySkin = (a: AgentModel): Skin => lookOf(a).skin ?? agentSkin(a);
/** the agent's signature colour, for HUD chrome (ticker, legend, monitor tint) */
export const agentColor = (a: AgentModel): number => agentBodySkin(a).accent;

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

/** how far a seated agent's hips drop below their standing height */
const SIT_DROP = 0.14;
/** standing hip height of the screen-head robot (0.86 × its 1.24 scale) */
const HIP_Y = 1.066;
/** top of the chair seat — where seated hips land */
const SEAT_TOP = HIP_Y - SIT_DROP;

const RECONCILE_MS = 250; // how often live agents are re-matched to desks
// Canvas textures (desk monitors, faces) are redrawn on their OWN clock. Their
// content changes about once a second — repainting all of them every frame meant
// ~1300 canvas redraws + GPU texture uploads per second, which is most of the
// office's frame cost and is brutal on a weak GPU. 8 Hz is imperceptible here.
const PAINT_MS = 125;

export function createOffice3D(opts: Office3DOpts = {}): Office3DHandle {
  // lane L8 knobs: ?room=studio|estate, ?hour=21 (pin the sky), mock mode hands out demo uniforms
  const qs = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const demoLooks = opts.demoLooks ?? qs.get("mock") === "1";
  const view = (a: AgentModel): AgentModel => (demoLooks ? withDemoLook(a) : a);
  const hourRaw = qs.get("hour")?.trim() ?? "";
  let hourOverride: number | null = hourRaw !== "" && Number.isFinite(Number(hourRaw)) ? Number(hourRaw) : null;
  let roomStyle: RoomStyle = asRoomStyle(opts.roomStyle ?? qs.get("room"));
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

  // ── sky: a vertical gradient behind the plate + stars that fade in at night ──
  const skyCanvas = document.createElement("canvas");
  skyCanvas.width = 2; skyCanvas.height = 128;
  const skyTex = new THREE.CanvasTexture(skyCanvas);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  const hexCss = (n: number): string => "#" + n.toString(16).padStart(6, "0");
  // windows get their own, brighter gradient: the void stays dark, the view outside is a real sky
  const paneCanvas = document.createElement("canvas");
  paneCanvas.width = 2; paneCanvas.height = 128;
  const paneTex = new THREE.CanvasTexture(paneCanvas);
  paneTex.colorSpace = THREE.SRGBColorSpace;
  function gradient(c: HTMLCanvasElement, tex: THREE.CanvasTexture, top: number, bottom: number): void {
    const x = c.getContext("2d")!;
    const g = x.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, hexCss(top)); g.addColorStop(1, hexCss(bottom));
    x.fillStyle = g; x.fillRect(0, 0, 2, 128);
    tex.needsUpdate = true;
  }
  const paintSky = (top: number, bottom: number): void => gradient(skyCanvas, skyTex, top, bottom);
  const paintPane = (top: number, bottom: number): void => gradient(paneCanvas, paneTex, top, bottom);
  scene.background = skyTex;
  // one draw call: ~400 points on a plane under the plate, so they only show in the void around it
  const starMat = new THREE.PointsMaterial({ color: 0xcfdcff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
  {
    const pos = new Float32Array(400 * 3);
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 400; i++) { pos[i * 3] = (rnd() - 0.5) * 150; pos[i * 3 + 1] = -9; pos[i * 3 + 2] = (rnd() - 0.5) * 150; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(geo, starMat);
    stars.frustumCulled = false; stars.renderOrder = -1;
    scene.add(stars);
  }

  // ── materials/helpers ──
  const mat = (c: number, rough = 0.92, metal = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal });
  function box(w: number, h: number, d: number, m: THREE.Material, cast = true): THREE.Mesh {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.castShadow = cast; b.receiveShadow = true;
    return b;
  }
  // Room theming: materials that change colour per room register how to pick theirs,
  // so switching rooms is a loop over this list, not a rebuild of the scene.
  const themed: { m: THREE.MeshStandardMaterial; pick: (t: RoomTheme) => number }[] = [];
  const tmat = (pick: (t: RoomTheme) => number, rough = 0.92, metal = 0): THREE.MeshStandardMaterial => {
    const m = mat(pick(THEMES[roomStyle]), rough, metal);
    themed.push({ m, pick });
    return m;
  };
  const shade = (hex: number, k: number): number => {
    const ch = (sh: number): number => Math.min(255, Math.round(((hex >> sh) & 255) * k));
    return (ch(16) << 16) | (ch(8) << 8) | ch(0);
  };

  // ── room: a bright office plate floating in a dark void ──
  // Where everything goes is decided in floorplan.ts (and tested there); this file
  // only builds it.
  const { FLOOR_W, FLOOR_D, HX, HZ, WALL_H } = PLAN;
  const floorMat = mat(THEMES[roomStyle].floor, 0.95);
  const floor = box(FLOOR_W, 0.5, FLOOR_D, floorMat, false);
  floor.position.y = -0.25; floor.castShadow = false; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(FLOOR_W, 22, 0xc2cbd8, 0xd8dfe9);
  grid.position.y = 0.02;
  (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.45;
  scene.add(grid);
  const rimMat = tmat((t) => t.rim, 0.9);
  ([[0, -HZ + 0.3, FLOOR_W, 0.6], [0, HZ - 0.3, FLOOR_W, 0.6], [-HX + 0.3, 0, 0.6, FLOOR_D], [HX - 0.3, 0, 0.6, FLOOR_D]] as const)
    .forEach(([x, z, w, d]) => {
      const rim = box(w, 0.7, d, rimMat, false); rim.position.set(x, 0.1, z); rim.receiveShadow = true; scene.add(rim);
    });
  // Two walls, back and left: they are behind everything from this camera, so they
  // never hide an agent, and they give the boards, shelves and racks something to
  // hang on. Windows show the sky (the same gradient texture), so the time of day
  // reads from inside the room too.
  const wallMat = tmat((t) => t.wall, 0.95);
  const backWall = box(FLOOR_W + 0.3, WALL_H, 0.3, wallMat, false);
  backWall.position.set(-0.15, WALL_H / 2, -HZ - 0.15); scene.add(backWall);
  const leftWall = box(0.3, WALL_H, FLOOR_D, wallMat, false);
  leftWall.position.set(-HX - 0.15, WALL_H / 2, 0); scene.add(leftWall);
  const skirtMat = mat(0x3a4152, 0.8);
  const skirtB = box(FLOOR_W, 0.3, 0.06, skirtMat, false); skirtB.position.set(0, 0.15, -HZ + 0.02); scene.add(skirtB);
  const skirtL = box(0.06, 0.3, FLOOR_D, skirtMat, false); skirtL.position.set(-HX + 0.02, 0.15, 0); scene.add(skirtL);
  // ── wall boards: Scrum + Team Velocity, fed the same WallBoardData as the 2D office ──
  let night = false; // declared here: the boards redraw darker at night
  interface WallBoard { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; mesh: THREE.Mesh }
  function makeWallBoard(x: number, w: number, h: number): WallBoard {
    const c = document.createElement("canvas");
    c.width = Math.round(w * 64); c.height = Math.round(h * 64);
    const ctx = c.getContext("2d")!;
    const tex = new THREE.CanvasTexture(c);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
    mesh.position.set(x, 3.1, -HZ + 0.03); // hung on the back wall, unlit → reads as a screen
    scene.add(mesh);
    return { ctx, tex, mesh };
  }
  const scrumBoard = makeWallBoard(PLAN.BOARD_WORK.x, PLAN.BOARD_WORK.w, PLAN.BOARD_WORK.h);
  const veloBoard = makeWallBoard(PLAN.BOARD_SPEND.x, PLAN.BOARD_SPEND.w, PLAN.BOARD_SPEND.h);
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
      ([[t("wall.queued"), s.todo, "#94a3b8"], [t("wall.inProgress"), s.inProgress, "#ff9100"], [t("status.done"), s.done, "#00e676"]] as const)
        .forEach(([label, n, col], i) => {
          const x = 26 + i * 205;
          ctx.fillStyle = "#8fa0ba"; ctx.font = "26px ui-monospace, monospace"; ctx.fillText(label, x, 116);
          ctx.fillStyle = col; ctx.font = "bold 62px ui-monospace, monospace"; ctx.fillText(String(n), x, 180);
        });
      ctx.fillStyle = "#9fb2c9"; ctx.font = "24px ui-monospace, monospace";
      s.titles.slice(0, 3).forEach((t, i) => ctx.fillText("• " + t.slice(0, 36), 26, 232 + i * 30));
    });
    panel(veloBoard, t("wall.spend"), (ctx) => {
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

  const v3 = (p: PLAN.Pt): THREE.Vector3 => new THREE.Vector3(p.x, 0, p.z);
  const MEET_CENTER = v3(PLAN.MEET_CENTER);

  // ── places you can click: tagged with a furnitureId, named in a hover tooltip ──
  // main.ts wires each id to what it opens (folders, panels, a terminal); see late.furniture there
  const places: { id: string; obj: THREE.Object3D; tipY: number }[] = [];
  function place(obj: THREE.Object3D, id: string, tipY: number): void {
    obj.userData.furnitureId = id;
    places.push({ id, obj, tipY });
  }

  // ── furniture (props.ts builds it; the floor plan says where) ──
  const props = buildProps({ scene, box, mat, tmat, shade, place, paneTex });
  const { lampGlowMat, poolMat, wallScreenMats, racks } = props;
  place(scrumBoard.mesh, "board_work", 5.9);
  place(veloBoard.mesh, "board_spend", 5.9);

  /** where an agent stands for each station; index picks a slot within it */
  const STATION_SLOTS: Record<Exclude<StationId, "desk">, THREE.Vector3[]> = {
    bookshelf: PLAN.STATION_SLOTS.bookshelf.map(v3),
    arcade: PLAN.STATION_SLOTS.arcade.map(v3),
    // "meeting" = delegating to sub-agents — they gather at the same table the
    // stand-up uses, on the far side so a stand-up and a delegation don't overlap.
    meeting: PLAN.STATION_SLOTS.meeting.map(v3),
  };
  /** which way to face on arrival at a station (the meeting table faces its centre) */
  function stationFace(st: Exclude<StationId, "desk">, at: THREE.Vector3): number {
    if (st === "meeting") return Math.atan2(MEET_CENTER.x - at.x, MEET_CENTER.z - at.z);
    return PLAN.STATION_FACE[st];
  }
  /** the CEO decision line: a physical FIFO queue in front of the CEO desk */
  const ceoLineSlot = (i: number): THREE.Vector3 => v3(PLAN.ceoLineSlot(i));
  /** light each rack: one LED per live agent on that vendor (reconcile, 4 Hz) */
  function updateRacks(live: readonly AgentModel[]): void {
    racks.forEach((rack) => {
      const mine = live.filter((a) => lookOf(a).family === rack.family);
      rack.on = rack.on.map((_, i) => (i < mine.length ? lookOf(mine[i]).trim : null));
    });
  }

  // ── seats (pure furniture) ──
  interface Seat {
    group: THREE.Group; i: number;
    screen: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
    label: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; sprite: THREE.Sprite };
    light: THREE.PointLight;
    agentId?: string;
    /** what the label shows now — repaint only when it changes */
    labelKey?: string;
  }
  function makeSeat(i: number, ceo = false): Seat {
    const g = new THREE.Group();
    const dw = ceo ? 3.6 : 2.5; // the boss gets a wider desk
    const deskMat = tmat((t) => (ceo ? t.ceoDesk : t.deskTop), 0.6);
    deskMat.map = deskGrainTexture(); // wood grain, tinted by the room's desk colour
    const deskTop = box(dw, 0.18, 1.5, deskMat); deskTop.position.set(0, 1.28, 0.45); g.add(deskTop);
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
    screenMesh.name = "screen"; // clicking the monitor means "show the file it is on"
    screenMesh.position.set(0, 1.98, 0.97); g.add(screenMesh);
    // An office chair on a pedestal: the seat top sits where a seated agent's hips land
    // (standing hip height minus SIT_DROP), so sitting down reads as sitting down.
    const chairMat = mat(0x232c3b, 0.7);
    const chairBack = box(0.98, 1.0, 0.16, chairMat); chairBack.position.set(0, 1.45, -1.05); g.add(chairBack);
    const chairSeat = box(0.98, 0.16, 0.8, chairMat); chairSeat.position.set(0, SEAT_TOP - 0.08, -0.65); g.add(chairSeat);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, SEAT_TOP - 0.2, 10), mat(0x9aa4b4, 0.4, 0.3));
    post.position.set(0, (SEAT_TOP - 0.16) / 2 + 0.08, -0.65); post.castShadow = true; g.add(post);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 5), mat(0x1a212e, 0.6, 0.3));
    foot.position.set(0, 0.07, -0.65); foot.castShadow = true; g.add(foot);
    if (ceo) {
      // no cubicle wall for the boss — an open desk on a rug reads as "the CEO spot"
      const rug = box(5.6, 0.04, 4.4, mat(0x33415c, 0.98), false);
      rug.position.set(0, 0.03, -0.3); rug.receiveShadow = true; g.add(rug);
    } else {
      // width == seat spacing, so neighbours butt up into one long open-plan strip
      const part = box(PLAN.DESK_COLS[1] - PLAN.DESK_COLS[0], 1.6, 0.1, tmat((t) => t.partition, 0.96)); part.position.set(0, 0.8, -1.55); part.receiveShadow = true;
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
  const seats: Seat[] = [];
  PLAN.DESK_ROWS.forEach((z, r) => PLAN.DESK_COLS.forEach((x, c) => {
    const s = makeSeat(r * PLAN.DESK_COLS.length + c);
    s.group.position.set(x, 0, z);
    scene.add(s.group);
    seats.push(s);
  }));
  // The CEO desk: its own spot at the head of the room, under the board. Reserved —
  // only the pinned PM sits here (mirrors the 2D layout's CEO_SPOT).
  const CEO_SEAT = seats.length;
  const ceoSeat = makeSeat(CEO_SEAT, true);
  ceoSeat.group.position.set(PLAN.CEO_DESK.x, 0, PLAN.CEO_DESK.z);
  scene.add(ceoSeat.group);
  seats.push(ceoSeat);
  function seatStand(i: number): THREE.Vector3 {
    const p = seats[i].group.position;
    return new THREE.Vector3(p.x, 0, p.z - 0.55);
  }
  /** seats never move, so the stand points are computed once (the pose check runs per character per frame) */
  const seatStands: THREE.Vector3[] = seats.map((_, i) => seatStand(i));

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
    // lane L8 — uniform, pose and status mark
    look?: AgentLook;
    /** what the uniform was built from; a change rebuilds the body */
    sig: string;
    rig: Rig;
    badge?: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
    mark?: THREE.Sprite;
    markKind: MarkKind | null;
    blend: PoseBlend;
    /** current walking speed, u/s (ramps up and brakes — see render/pose.stepSpeed) */
    speed: number;
    /** the heading to settle into once it stops */
    faceYaw: number;
    /** the heading to take on arriving at the current target (a station faces its prop) */
    arriveYaw: number;
    /** desynchronises neighbours' idle/typing motion */
    seed: number;
  }
  /** joints the pose system drives; empty for the GLB kind, which animates through its own clips */
  interface Rig { head?: THREE.Object3D; arms?: [THREE.Object3D, THREE.Object3D] }
  const lookSig = (l: AgentLook | undefined): string => (l ? `${l.family}|${l.lane ?? ""}|${l.persona?.avatar ?? ""}` : "");
  const chars = new Map<string, Char>();
  const seatOf = new Map<string, number>();
  const ENTRANCE = v3(PLAN.ENTRANCE); // agents arrive and leave by the lift
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
    c.userData.keepGpu = true; // a skinned clone shares geometry + textures with the loaded model
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
  interface Dressed {
    inner: THREE.Object3D; mixer?: THREE.AnimationMixer; clips: THREE.AnimationClip[]; legs: THREE.Object3D[];
    face?: Face; rig: Rig; badge?: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
  }
  /** head gear + chest badge for a harness (or a persona avatar); no-ops for a body without joints */
  function dress(b: Built, look: AgentLook | undefined): Dressed["badge"] {
    if (!look) return undefined;
    if (b.head) { const acc = buildAccessory(look.accessory, look.trim); if (acc) b.head.add(acc); }
    if (!b.chest || (look.family === "unknown" && !look.persona?.avatar)) return undefined;
    const c = document.createElement("canvas"); c.width = c.height = BADGE_PX;
    const ctx = c.getContext("2d")!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const repaint = (): void => { drawBadge(ctx, look, repaint); tex.needsUpdate = true; };
    drawBadge(ctx, look, repaint);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    plate.position.z = 0.005;
    b.chest.add(plate);
    return { ctx, tex };
  }
  function buildInner(kind: Kind, skin: Skin, look?: AgentLook): Dressed {
    if (kind !== "screen" && MODELS[kind]) { const g = makeGlb(kind, skin); return { inner: g.inner, mixer: g.mixer, clips: g.clips, legs: [], rig: {} }; }
    const b = chosenBuilder(skin);
    const badge = dress(b, look);
    return { inner: b.inner, clips: [], legs: b.legs, face: attachFace(b.inner, skin) ?? undefined, rig: { head: b.head, arms: b.arms }, badge };
  }
  /**
   * Free a detached subtree's GPU memory. Shared materials (status marks, head gear,
   * room decor cache) are flagged `userData.shared` and left alone; sprites share
   * one global geometry in three.js, so only meshes have theirs disposed.
   */
  function disposeTree(root: THREE.Object3D): void {
    if (root.userData.keepGpu) return; // GLB clones: freeing would pull buffers from under the others
    root.children.forEach(disposeTree);
    const m = root as THREE.Mesh | THREE.Sprite;
    if (!(m as THREE.Mesh).isMesh && !(m as THREE.Sprite).isSprite) return;
    if ((m as THREE.Mesh).isMesh) m.geometry.dispose();
    (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => {
      if (mm.userData.shared) return;
      (mm as THREE.MeshBasicMaterial).map?.dispose();
      mm.dispose();
    });
  }
  /** the per-character fields the L8 systems add; spread into every Char literal */
  function fresh(d: Dressed, look: AgentLook | undefined, seed: number): Pick<Char, "look" | "sig" | "rig" | "badge" | "markKind" | "blend" | "speed" | "faceYaw" | "seed"> {
    return { look, sig: lookSig(look), rig: d.rig, badge: d.badge, markKind: null, blend: initialBlend("stand"), speed: 0, faceYaw: 0, seed };
  }
  function makeMark(): THREE.Sprite {
    const m = new THREE.Sprite(markMaterial("alert"));
    m.scale.set(0.95, 0.95, 1); m.position.set(0, 3.7, 0); m.visible = false; m.renderOrder = 5;
    return m;
  }
  function playClip(ch: Char, want: string): void {
    if (!ch.mixer || !ch.clips.length || ch.curClip === want) return;
    ch.curClip = want;
    const clip = findClip(ch.clips, want);
    if (!clip) return;
    ch.mixer.stopAllAction();
    ch.mixer.clipAction(clip).reset().fadeIn(0.2).play();
  }
  function makeChar(agentId: string, skin: Skin, home: number, look?: AgentLook): Char {
    const built = buildInner(curKind, skin, look);
    const group = new THREE.Group();
    group.add(built.inner);
    group.position.copy(ENTRANCE);
    group.userData.agentId = agentId;
    scene.add(group);
    const bubble = makeBubble();
    group.add(bubble.sprite);
    const mark = makeMark();
    group.add(mark);
    const ch: Char = {
      group, inner: built.inner, mixer: built.mixer, clips: built.clips, legs: built.legs, face: built.face, bubble, phase: 0, skin, home,
      state: "walkIn", target: seatStand(home), mark, arriveYaw: 0, ...fresh(built, look, hashStr(agentId) % 628 / 100),
    };
    playClip(ch, "Idle");
    chars.set(agentId, ch);
    return ch;
  }
  /** swap a character's body (new kind, or its uniform changed); position and state carry over */
  function rebuildBody(ch: Char, kind: Kind, skin: Skin, look: AgentLook | undefined): void {
    ch.group.remove(ch.inner);
    const built = buildInner(kind, skin, look);
    ch.group.add(built.inner);
    disposeTree(ch.inner);
    // only the body changes: heading, pose, speed and the status mark carry over, so a
    // late-arriving harness doesn't make a seated agent stand up or turn its back
    Object.assign(ch, {
      inner: built.inner, mixer: built.mixer, clips: built.clips, legs: built.legs, face: built.face, curClip: undefined, skin,
      look, sig: lookSig(look), rig: built.rig, badge: built.badge,
    });
    playClip(ch, "Idle");
  }
  function rebuildChars(kind: Kind): void {
    curKind = kind;
    chars.forEach((ch) => rebuildBody(ch, kind, ch.skin, ch.look));
  }
  // ── CEO avatar: represents you in the office. Wanders between activity spots
  // and heads back to the desk the moment someone is waiting on a decision.
  // Timing/choice come from render/ceoActivity.ts — pure and already unit-tested.
  const CEO_SPOT3D: Record<CeoActivity, THREE.Vector3> = {
    desk: v3(PLAN.CEO_SPOTS.desk), cooler: v3(PLAN.CEO_SPOTS.cooler), sofa: v3(PLAN.CEO_SPOTS.sofa),
    window: v3(PLAN.CEO_SPOTS.window), phone: v3(PLAN.CEO_SPOTS.phone), board: v3(PLAN.CEO_SPOTS.board),
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
      phase: 0, skin, home: CEO_SEAT, state: "atDesk", target: CEO_SPOT3D.desk.clone(), arriveYaw: 0, ...fresh(built, undefined, 1.3),
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
    // stands and idles; walks between spots; leans in to talk when someone is waiting on a decision
    poseStep(ceoChar, ceoChar.state === "walkIn" ? "walk" : blocked ? "talk" : "rest", false, dt);
    ceoChar.mixer?.update(dt);
    if (repaint && ceoChar.face) drawFace(ceoChar.face, ceoChar.skin, blocked ? "ask" : "work", elapsed);
  }

  // ── hiring-hall greeter: a new skill walks in, waves near reception, leaves ──
  const GREET_SPOT = v3(PLAN.GREET_SPOT);
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
      phase: 0, skin, home: 0, state: "walkIn", target: slot, greeter: { until: 0 }, arriveYaw: 0, ...fresh(built, undefined, greeterN),
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
  const TURN = 11; // rad/s — how fast a character swings round to face where it is going
  const _d = new THREE.Vector3();
  function stepChar(ch: Char, dt: number, instant = false): void {
    const moving = ch.state === "walkIn" || ch.state === "toMeet" || ch.state === "walkOut";
    if (!moving) {
      ch.speed = 0;
      // settle into the arrival heading instead of snapping to it
      ch.group.rotation.y = instant ? ch.faceYaw : turnToward(ch.group.rotation.y, ch.faceYaw, TURN, dt);
      return;
    }
    _d.copy(ch.target).sub(ch.group.position); _d.y = 0;
    const dist = _d.length();
    // time-lapse: at 16-60x the state moves far faster than 4.4 u/s, so walking
    // never arrives — snap to the target instead (what the 2D office did).
    if (!instant && dist > 0.12) {
      _d.normalize();
      ch.speed = stepSpeed(ch.speed, MOVE, dist, dt); // accelerate, brake into the goal
      ch.group.position.addScaledVector(_d, Math.min(ch.speed * dt, dist));
      ch.group.rotation.y = turnToward(ch.group.rotation.y, Math.atan2(_d.x, _d.z), TURN, dt);
      ch.phase += dt * 14 * (0.35 + 0.65 * (ch.speed / MOVE)); // cadence follows speed, so feet don't skate
      if (ch.clips.length) playClip(ch, "Walking");
      return;
    }
    ch.group.position.copy(ch.target);
    ch.speed = 0;
    if (ch.state === "walkOut") return;
    if (ch.state === "toMeet") { _d.copy(MEET_CENTER).sub(ch.group.position); ch.faceYaw = Math.atan2(_d.x, _d.z); ch.state = "atMeet"; }
    else { ch.faceYaw = ch.arriveYaw; ch.state = "atDesk"; }
    if (instant) ch.group.rotation.y = ch.faceYaw;
    playClip(ch, "Idle");
  }

  /**
   * Drive the rig for one frame: pick the pose, cross-fade into it, then write the
   * joint angles. Bodies without joints (the GLB kind) are left to their own clips.
   */
  function poseStep(ch: Char, mode: ReturnType<typeof poseModeFor>, seated: boolean, dt: number): void {
    if (!ch.rig.arms || !ch.rig.head) return;
    ch.blend = advanceBlend(ch.blend, mode, seated, dt);
    const a: PoseAngles = blendedAngles(ch.blend, elapsed, ch.phase, ch.speed / MOVE, ch.seed);
    const sit = ch.blend.sit;
    ch.rig.arms[0].rotation.set(a.armLx, 0, a.armLz);
    ch.rig.arms[1].rotation.set(a.armRx, 0, a.armRz);
    ch.rig.head.rotation.set(a.headPitch, 0, a.headRoll);
    const swing = Math.sin(ch.phase) * a.legSwing * (1 - sit);
    ch.legs.forEach((l, i) => { l.rotation.x = SIT_LEG * sit + (i % 2 ? -swing : swing); });
    ch.inner.rotation.x = a.lean;
    ch.inner.position.y = -SIT_DROP * sit + a.bob;
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
    const tint = "#" + agentColor(view(a)).toString(16).padStart(6, "0");
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
    const look = lookOf(a);
    const name = displayName(a);
    // who it works for, in a word: the lane for a worker, else the vendor (Claude is the default, so it stays unlabelled)
    const tag = look.lane ?? (look.family === "unknown" || look.family === "claude" ? "" : look.family);
    const key = `${name}|${a.status}|${tag}`;
    if (s.labelKey === key) return; // reconcile runs 4x/s; the label changes a few times a minute
    s.labelKey = key;
    const ctx = s.label.ctx; ctx.clearRect(0, 0, 256, 72);
    const hue = "#" + (statusHue[a.status] ?? 0x9aa6bd).toString(16).padStart(6, "0");
    const alert = markFor(a.status) === "alert" || a.status === "error";
    ctx.fillStyle = "rgba(10,14,22,.9)"; roundRect(ctx, 6, 8, 244, 52, 12); ctx.fill();
    if (alert) { ctx.strokeStyle = hue; ctx.lineWidth = 3; ctx.stroke(); } // a red outline you can see across the room
    ctx.fillStyle = "#e8ecf4"; ctx.font = "bold 22px ui-monospace, monospace"; ctx.textAlign = "center";
    ctx.fillText(name.length > 15 ? name.slice(0, 14) + "…" : name, 128, 32);
    ctx.fillStyle = hue;
    ctx.font = "16px ui-monospace, monospace"; ctx.fillText(statusLabel(a.status), 128, 52);
    ctx.beginPath(); ctx.arc(20, 30, 5, 0, Math.PI * 2); ctx.fill(); // status dot, same hue as the text
    if (tag) { ctx.textAlign = "right"; ctx.fillStyle = "#8fa0ba"; ctx.font = "13px ui-monospace, monospace"; ctx.fillText(tag.slice(0, 10), 242, 24); }
    ctx.textAlign = "left";
    s.label.tex.needsUpdate = true;
  }

  // ── pointer: drag to pan, click (no drag) to pick an agent ──
  // 4px dead zone so a real click still picks; any actual drag cancels the
  // focus-pan so the ticker can't wrestle the hand (same rule as the 2D office).
  const raycaster = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  /** what's under this screen point: a tagged prop, an agent, or nothing */
  function resolvePick(clientX: number, clientY: number): { agentId?: string; furnitureId?: string; hit?: string; seat?: { part: "screen" | "desk"; ceo: boolean } } {
    const r = canvas.getBoundingClientRect();
    ptr.x = ((clientX - r.left) / r.width) * 2 - 1;
    ptr.y = -((clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(ptr, camera);
    const targets: THREE.Object3D[] = [...places.map((p) => p.obj), ...seats.map((s) => s.group), ...[...chars.values()].map((c) => c.group)];
    const hits = raycaster.intersectObjects(targets, true);
    if (!hits.length) return {};
    let o: THREE.Object3D | null = hits[0].object;
    const hit = o.name || o.type;
    let agentId: string | undefined;
    let furnitureId: string | undefined;
    let seat: { part: "screen" | "desk"; ceo: boolean } | undefined;
    const part = hit === "screen" ? "screen" : "desk";
    while (o && !agentId && !furnitureId && !seat) {
      if (typeof o.userData.furnitureId === "string") furnitureId = o.userData.furnitureId;
      else if (typeof o.userData.agentId === "string") agentId = o.userData.agentId;
      else if (o.userData.seatIndex !== undefined) {
        const i = o.userData.seatIndex as number;
        agentId = seats[i].agentId ?? undefined;
        seat = { part, ceo: i === CEO_SEAT };
      }
      o = o.parent;
    }
    return { agentId, furnitureId, hit, ...(seat ? { seat } : {}) };
  }
  function pick(ev: PointerEvent): void {
    const { agentId, furnitureId, seat } = resolvePick(ev.clientX, ev.clientY);
    if (furnitureId) opts.onFurniture?.(furnitureId, { shiftKey: ev.shiftKey });
    else if (seat && opts.onSeat) opts.onSeat({ ...(agentId ? { agentId } : {}), ...seat });
    else if (agentId) opts.onPick?.(agentId);
  }
  const DRAG_PX = 4;
  let dragging = false, moved = false, downX = 0, downY = 0, lastX = 0, lastY = 0;
  canvas.style.cursor = "grab";
  function onDown(ev: PointerEvent): void {
    dragging = true; moved = false;
    downX = lastX = ev.clientX; downY = lastY = ev.clientY;
  }
  // ── hover: name the place under the pointer (tooltip above it) ──
  const tipCanvas = document.createElement("canvas"); tipCanvas.width = 512; tipCanvas.height = 80;
  const tipTex = new THREE.CanvasTexture(tipCanvas);
  tipTex.colorSpace = THREE.SRGBColorSpace;
  const tip = new THREE.Sprite(new THREE.SpriteMaterial({ map: tipTex, transparent: true, depthTest: false }));
  tip.scale.set(6.4, 1, 1); tip.visible = false; tip.renderOrder = 10;
  scene.add(tip);
  let tipId: string | null = null, lastHover = 0;
  const placeTop = new Map<string, THREE.Vector3>();
  function hover(ev: PointerEvent): void {
    const now = performance.now();
    if (now - lastHover < 60) return; // raycasting every pointermove is wasted work
    lastHover = now;
    const { agentId, furnitureId } = resolvePick(ev.clientX, ev.clientY);
    canvas.style.cursor = agentId || furnitureId ? "pointer" : "grab";
    if (furnitureId === tipId) return;
    tipId = furnitureId ?? null;
    const p = places.find((x) => x.id === furnitureId);
    tip.visible = !!p;
    if (!p) return;
    let top = placeTop.get(p.id);
    if (!top) { // centre of the prop, at its own tooltip height
      const b = new THREE.Box3().setFromObject(p.obj);
      top = new THREE.Vector3((b.min.x + b.max.x) / 2, p.tipY, (b.min.z + b.max.z) / 2);
      placeTop.set(p.id, top);
    }
    tip.position.copy(top);
    const x = tipCanvas.getContext("2d")!;
    x.clearRect(0, 0, 512, 80);
    x.fillStyle = "rgba(10,14,22,.94)"; roundRect(x, 4, 6, 504, 66, 14); x.fill();
    x.strokeStyle = "#38e0d0"; x.lineWidth = 3; x.stroke();
    x.fillStyle = "#e8ecf4"; x.font = "bold 26px ui-sans-serif, system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText(t(`office.place.${p.id}` as Key), 256, 40, 480);
    tipTex.needsUpdate = true;
  }
  function onMove(ev: PointerEvent): void {
    if (!dragging) { hover(ev); return; }
    if (!moved && Math.abs(ev.clientX - downX) + Math.abs(ev.clientY - downY) > DRAG_PX) {
      moved = true; focusId = null; canvas.style.cursor = "grabbing";
      tip.visible = false; tipId = null;
    }
    if (moved) panBy(ev.clientX - lastX, ev.clientY - lastY);
    lastX = ev.clientX; lastY = ev.clientY;
  }
  function onUp(ev: PointerEvent): void {
    canvas.style.cursor = "grab";
    if (ev.type === "pointerleave") { tip.visible = false; tipId = null; }
    // only a plain left click picks: a right click opens the menu, leaving the canvas is not a click
    if (ev.type === "pointerup" && ev.button === 0 && !ev.ctrlKey && dragging && !moved) pick(ev);
    dragging = false;
  }
  canvas.addEventListener("contextmenu", (ev) => {
    const { agentId } = resolvePick(ev.clientX, ev.clientY);
    if (!agentId || !opts.onAgentMenu) return;
    ev.preventDefault();
    opts.onAgentMenu(agentId, ev.clientX, ev.clientY);
  });
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
  function sendTo(ch: Char, target: THREE.Vector3, face = 0): void {
    if (ch.state === "toMeet" || ch.state === "atMeet" || ch.state === "walkOut") return; // stand-up / exit win
    ch.arriveYaw = face;
    if (ch.target.distanceTo(target) < 0.05) return;
    ch.target = target.clone();
    ch.state = "walkIn";
  }
  function reconcile(state: OfficeState, clockNow: number): void {
    const liveArr = [...state.agents.values()].filter((a) => a.despawnedAt === null).map(view);
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
    const stationYaw = new Map<string, number>();
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
        .forEach((a, i) => {
          if (!slots.length) return;
          const at = slots[i % slots.length];
          stationPos.set(a.agentId, at);
          stationYaw.set(a.agentId, stationFace(st as Exclude<StationId, "desk">, at));
        });
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
    updateRacks(liveArr);
    seats.forEach((s) => { s.agentId = undefined; s.label.sprite.visible = false; });
    liveArr.forEach((a) => {
      const idx = seatOf.get(a.agentId);
      if (idx === undefined) return;
      const s = seats[idx];
      s.agentId = a.agentId;
      s.label.sprite.visible = true;
      drawLabel(s, a);
      const ch = chars.get(a.agentId);
      const look = lookOf(a);
      if (!ch) { makeChar(a.agentId, look.skin ?? agentSkin(a), idx, look); return; }
      // the harness / lane / persona can arrive after spawn: dress the body again when it changes
      if (!ch.greeter && lookSig(look) !== ch.sig) rebuildBody(ch, curKind, look.skin ?? agentSkin(a), look);
      ch.home = idx; // may have been re-homed (e.g. just pinned as PM)
      if (!meeting) {
        const queued = queuePos.get(a.agentId), at = stationPos.get(a.agentId);
        sendTo(ch, queued ?? at ?? seatStand(idx), !queued && at ? stationYaw.get(a.agentId) ?? 0 : 0);
      }
      if (ch.state === "atDesk") playClip(ch, clipMap[a.status] ?? "Idle");
    });
    chars.forEach((ch, id) => {
      if (ch.greeter) return; // not an agent — it shows itself out
      if (!liveIds.has(id) && ch.state !== "walkOut") { ch.state = "walkOut"; ch.target = ENTRANCE.clone(); seatOf.delete(id); }
    });
  }

  let elapsed = 0;
  let sinceClock = 0;
  const CLOCK_MS = 20_000; // the sky moves slowly; re-reading the clock every 20s is plenty
  const _want = new THREE.Vector3();
  /** the ❗ / ✕ / ✓ above a character's head; pulses so a stuck agent is findable from across the room */
  function updateMark(ch: Char, status: Parameters<typeof markFor>[0], t: number): void {
    if (!ch.mark) return;
    const kind = markFor(status);
    if (kind !== ch.markKind) {
      ch.markKind = kind;
      ch.mark.visible = kind !== null;
      if (kind) ch.mark.material = markMaterial(kind);
    }
    if (!kind) return;
    const pulse = 1 + MARK_PULSE[kind] * Math.sin(t * 8);
    ch.mark.scale.set(0.95 * pulse, 0.95 * pulse, 1);
    // seated, the desk's name tag hangs right where the mark would be: lift it clear
    ch.mark.position.y = 3.7 + 0.75 * ch.blend.sit + Math.sin(t * 4) * 0.07;
  }
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

    // the sky follows the real clock (a pinned ?hour= / setTimeOfDay never drifts)
    sinceClock += dtMs;
    if (hourOverride === null && sinceClock >= CLOCK_MS) { sinceClock = 0; curDay = daylightAt(hourOf(new Date())); applyLighting(); }

    const dead: string[] = [];
    chars.forEach((ch, id) => {
      stepChar(ch, dt, instant);
      ch.mixer?.update(dt);
      const walking = ch.state === "walkIn" || ch.state === "toMeet" || ch.state === "walkOut";
      // greeters: once they reach reception they wave a while, then show themselves out
      if (ch.greeter) {
        if (ch.state === "atDesk") {
          if (!ch.greeter.until) { ch.greeter.until = elapsed + GREET_SECONDS; playClip(ch, "Wave"); }
          else if (elapsed > ch.greeter.until) { ch.state = "walkOut"; ch.target = ENTRANCE.clone(); }
        }
        poseStep(ch, walking ? "walk" : "wave", false, dt);
        if (repaint && ch.face) drawFace(ch.face, ch.skin, ch.state === "walkOut" ? "idle" : "done", elapsed);
      } else {
        const a = liveState?.agents.get(id);
        // pose: what the agent is doing, from its status and where it stands; sitting only at its own desk
        const live = a && a.despawnedAt === null ? a : undefined;
        const seated = ch.state === "atDesk" && !!live && live.station === "desk" && ch.group.position.distanceToSquared(seatStands[ch.home]) < 0.09;
        poseStep(ch, live ? poseModeFor(live.status, live.station, walking, seated) : walking ? "walk" : "stand", seated, dt);
        updateMark(ch, live?.status, elapsed);
        if (repaint && ch.face) {
          const mood = a && a.despawnedAt === null ? moodMap[a.status] ?? "work" : "idle";
          drawFace(ch.face, ch.skin, ch.state === "walkOut" ? "idle" : mood, elapsed);
        }
        if (ch.bubble) { // PM chat replies + agent messages pop for BUBBLE_MS
          const msg = a?.message;
          // no bubbles in time-lapse: at 16-60x they'd strobe (2D did the same)
          const show = !instant && !!msg && clockNow - msg.at < BUBBLE_MS && clockNow >= msg.at;
          ch.bubble.sprite.visible = show;
          ch.bubble.sprite.position.y = (ch.markKind ? 5.1 : 4.4) + 0.75 * ch.blend.sit; // clear of the ❗, which rises when seated
          if (show && msg) drawBubble(ch.bubble, msg.text);
        }
      }
      if (ch.state === "walkOut" && ch.group.position.distanceTo(ENTRANCE) < 0.25) dead.push(id);
    });
    dead.forEach((id) => { const g = chars.get(id)!.group; scene.remove(g); disposeTree(g); chars.delete(id); });

    if (repaint) {
      seats.forEach((s) => {
        const a = s.agentId ? state.agents.get(s.agentId) : undefined;
        drawScreen(s, a && a.despawnedAt === null ? a : null, t);
      });
    }
    // provider racks: lit lights flicker like disk activity; dark ones stay dark
    racks.forEach((r, ri) => r.leds.forEach((m, i) => {
      const on = r.on[i];
      m.color.setHex(on === null ? 0x1a2418 : Math.sin(t / 260 + i * 2.1 + ri) > -0.3 ? on : shade(on, 0.45));
    }));
    renderer.render(scene, camera);
  }

  // ── light + room ──
  // The sky and the sun follow the real clock (daylight.ts). "Lights off" is the
  // deliberate cinematic mode and stays darker than any natural hour.
  let lightsOff = false;
  let curDay: Daylight = daylightAt(hourOverride ?? hourOf(new Date()));
  function applyLighting(): void {
    const d = curDay;
    if (lightsOff) {
      ambient.color.setHex(0xbcd0ff); ambient.intensity = 0.1;
      key.color.setHex(0xfff0d8); key.intensity = 0.12; key.position.set(16, 26, 10);
      fill.intensity = 0.04;
      paintSky(0x04070d, 0x04070d);
      paintPane(0x0b1426, 0x16213a);
      (scene.fog as THREE.Fog).color.setHex(0x04070d);
    } else {
      ambient.color.setHex(d.ambientColor); ambient.intensity = d.ambientIntensity;
      key.color.setHex(d.sunColor); key.intensity = d.sunIntensity; key.position.set(d.sunPos[0], d.sunPos[1], d.sunPos[2]);
      fill.intensity = d.fillIntensity;
      paintSky(d.skyTop, d.skyBottom);
      paintPane(d.paneTop, d.paneBottom);
      (scene.fog as THREE.Fog).color.setHex(d.skyBottom);
    }
    const nightK = lightsOff ? 1 : d.night;
    starMat.opacity = nightK * 0.9;
    poolMat.opacity = nightK * 0.85;
    lampGlowMat.color.setHex(lerpHex(0xb9b3a2, 0xfff2d0, nightK)); // lamps switch on at dusk
    seats.forEach((s) => (s.light.intensity = lightsOff ? 2.4 : 0.5 + 1.4 * d.night));
    const dark = lightsOff || d.night > 0.7;
    if (dark !== night) { night = dark; drawBoards(); } // boards are canvases, not a tinted plane — redraw them darker
  }
  function setNight(on: boolean): void {
    lightsOff = on;
    applyLighting();
  }
  function setTimeOfDay(hour: number | null): void {
    hourOverride = hour !== null && Number.isFinite(hour) ? hour : null;
    sinceClock = 0;
    curDay = daylightAt(hourOverride ?? hourOf(new Date()));
    applyLighting();
  }

  let decor: THREE.Group | null = null;
  function applyRoom(style: RoomStyle): void {
    roomStyle = style;
    const th = THEMES[style];
    themed.forEach(({ m, pick }) => m.color.setHex(pick(th)));
    const tex = floorTexture(th.floorMap);
    floorMat.map = tex;
    if (tex) tex.repeat.set(FLOOR_W / th.floorTile, FLOOR_D / th.floorTile);
    floorMat.color.setHex(tex ? 0xffffff : th.floor);
    floorMat.roughness = th.floorMap === "marble" ? 0.4 : th.floorMap === "planks" ? 0.75 : 0.95;
    floorMat.needsUpdate = true;
    grid.visible = th.gridOpacity > 0;
    (grid.material as THREE.Material).opacity = th.gridOpacity;
    wallScreenMats.forEach((m, i) => m.color.setHex(th.screens[i]));
    if (decor) {
      scene.remove(decor);
      disposeTree(decor);
    }
    decor = buildDecor(style);
    scene.add(decor);
    if (!renderer.shadowMap.enabled) decor.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.receiveShadow = false; });
  }
  applyRoom(roomStyle);
  applyLighting();

  return {
    canvas,
    tick,
    setNight,
    setTimeOfDay,
    setRoomStyle: (style) => applyRoom(asRoomStyle(style)),
    roomStyle: () => roomStyle,
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
    screenPos: (agentId: string) => {
      const ch = chars.get(agentId);
      if (!ch || !ch.group.visible) return null;
      const p = new THREE.Vector3();
      ch.group.getWorldPosition(p);
      p.y += 2.9; // just above the head (and its status mark)
      p.project(camera);
      if (p.z > 1 || p.x < -1.05 || p.x > 1.05 || p.y < -1.05 || p.y > 1.05) return null;
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    },
    debug: () => [...chars.entries()].map(([id, c]) => ({
      id: id.slice(0, 8), state: c.state, home: c.home,
      x: Math.round(c.group.position.x * 10) / 10, z: Math.round(c.group.position.z * 10) / 10,
      bubble: c.bubble?.sprite.visible === true,
      pose: c.blend.mode, sit: Math.round(c.blend.sit * 100) / 100, family: c.look?.family ?? "-",
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
