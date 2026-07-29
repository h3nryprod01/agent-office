// Showroom: the chosen design (09 "Đầu màn hình") in all 10 skins, side by side.
// Same neon-on-dark look as the office, so what you pick here is what you get there.
// (The other 9 designs still live in robotKit.ts — swap `chosenBuilder` for
// `ROBOTS[n].build` to compare shapes again.)

import { t } from "../i18n";
import * as THREE from "three";
import { chosenBuilder, attachFace, drawFace, SKINS, type Face, type Mood, type Skin } from "./robotKit";

// one mood per pedestal so every expression is visible at a glance
const MOODS: Mood[] = ["work", "read", "run", "ask", "error", "done", "idle"];

const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);

let camera: THREE.OrthographicCamera;
// the lineup + labels span roughly this much world space — fit it at ANY window
// aspect (a hardcoded zoom clips the end robots in a narrow/portrait window)
const NEED_W = 19.5, NEED_H = 10;
function makeCamera(): void {
  const a = innerWidth / innerHeight;
  const d = Math.max(NEED_H / 2, NEED_W / (2 * a));
  camera = new THREE.OrthographicCamera(-d * a, d * a, d, -d, -60, 120);
  // elevated enough that the back row clears the front row's labels, still frontal
  // enough to read silhouettes.
  camera.position.set(2.5, 9, 14);
  camera.lookAt(0.9, 1.5, 0);
}
makeCamera();
function resize(): void { renderer.setSize(innerWidth, innerHeight); makeCamera(); }
addEventListener("resize", resize);
resize();

// ── lights (same recipe as the office) ──
const ambient = new THREE.AmbientLight(0xbcd0ff, 0.6);
scene.add(ambient);
const key = new THREE.DirectionalLight(0xfff0d8, 1.15);
key.position.set(8, 18, 12);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
const S = 16;
key.shadow.camera.left = -S; key.shadow.camera.right = S; key.shadow.camera.top = S; key.shadow.camera.bottom = -S;
key.shadow.camera.near = 1; key.shadow.camera.far = 60; key.shadow.bias = -0.0004;
scene.add(key);
const fill = new THREE.DirectionalLight(0x5b7cff, 0.4);
fill.position.set(-10, 8, -6);
scene.add(fill);

// ── floor plate ──
const floor = new THREE.Mesh(new THREE.BoxGeometry(24, 0.5, 11), new THREE.MeshStandardMaterial({ color: 0xdbe2ec, roughness: 0.97 }));
floor.position.set(0.9, -0.25, 0); floor.receiveShadow = true; scene.add(floor);
const grid = new THREE.GridHelper(24, 16, 0xaab6c7, 0xc7d0dd);
grid.position.set(0.9, 0.02, 0);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.45;
scene.add(grid);

// ── label sprite: "01 Name" + the short note, so no separate legend panel is needed ──
function makeLabel(no: string, name: string, note: string, hex: number): THREE.Sprite {
  const c = document.createElement("canvas"); c.width = 380; c.height = 108;
  const x = c.getContext("2d")!;
  const css = "#" + hex.toString(16).padStart(6, "0");
  x.fillStyle = "rgba(10,14,22,.93)";
  x.beginPath(); x.roundRect(4, 6, 372, 94, 16); x.fill();
  x.strokeStyle = css; x.lineWidth = 2; x.stroke();
  x.fillStyle = css;
  x.font = "bold 30px ui-monospace, monospace"; x.textAlign = "left"; x.fillText(no, 20, 48);
  x.fillStyle = "#e8ecf4";
  x.font = "bold 26px ui-monospace, monospace"; x.fillText(name, 68, 47);
  x.fillStyle = "#8fa0ba";
  x.font = "18px ui-monospace, monospace"; x.fillText(note, 20, 80);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set(2.75, 0.78, 1);
  return s;
}

// ── lay the 10 out: 2 rows of 5, back row offset so nothing hides ──
interface Slot { spin: THREE.Group; legs: THREE.Object3D[]; hover: boolean; phase: number; face?: Face; skin: Skin; mood: Mood; }
const slots: Slot[] = [];
SKINS.forEach((skin, i) => {
  const hex = skin.accent;
  const row = Math.floor(i / 5), col = i % 5;
  const x = (col - 2) * 3.4 + (row === 0 ? 1.7 : 0); // back row staggered into the front row's gaps
  const z = row === 0 ? -4.0 : 4.0;

  const stand = new THREE.Group();
  stand.position.set(x, 0, z);
  scene.add(stand);

  // pedestal
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.15, 0.16, 24), new THREE.MeshStandardMaterial({ color: 0xeef2f7, roughness: 0.85 }));
  ped.position.y = 0.08; ped.receiveShadow = true; stand.add(ped);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.025, 8, 40), new THREE.MeshBasicMaterial({ color: hex }));
  halo.position.y = 0.17; halo.rotation.x = Math.PI / 2; stand.add(halo);

  // the robot, on a spinner so we see every side
  const spin = new THREE.Group();
  spin.position.y = 0.16;
  const built = chosenBuilder(skin);
  spin.add(built.inner);
  stand.add(spin);

  const label = makeLabel(String(i + 1).padStart(2, "0"), skin.name, skin.body > 0x888888 ? t("robot.shellLight") : t("robot.shellDark"), hex);
  label.position.set(0, 3.15, 0);
  stand.add(label);

  slots.push({
    spin, legs: built.legs, hover: built.legs.length === 0, phase: i * 0.7,
    face: attachFace(built.inner, skin) ?? undefined, skin, mood: MOODS[i % MOODS.length],
  });
});

// ── controls ──
let walking = false;
let night = false;
document.getElementById("btn-walk")!.addEventListener("click", (e) => {
  walking = !walking;
  (e.currentTarget as HTMLElement).classList.toggle("on", walking);
  (e.currentTarget as HTMLElement).textContent = walking ? t("robot.walkStop") : t("robot.walkStart");
});
document.getElementById("btn-night")!.addEventListener("click", (e) => {
  night = !night;
  (e.currentTarget as HTMLElement).classList.toggle("on", night);
  ambient.intensity = night ? 0.12 : 0.6;
  key.intensity = night ? 0.14 : 1.15;
  fill.intensity = night ? 0.05 : 0.4;
  scene.background = new THREE.Color(night ? 0x04070d : 0x0d1117);
});

// ── loop ──
const clock = new THREE.Clock();
function loop(): void {
  const dt = clock.getDelta();
  const t = clock.elapsedTime;
  slots.forEach((s) => {
    if (s.face) drawFace(s.face, s.skin, s.mood, t);
    s.spin.rotation.y += dt * 0.5; // show every side
    if (s.hover) s.spin.position.y = 0.16 + Math.sin(t * 1.6 + s.phase) * 0.12; // hover bots bob
    if (walking && s.legs.length) {
      s.phase += dt * 9;
      const sw = Math.sin(s.phase) * 0.5;
      s.legs.forEach((l, i) => (l.rotation.x = i % 2 ? -sw : sw));
    } else if (s.legs.length) {
      s.legs.forEach((l) => (l.rotation.x = 0));
    }
  });
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
