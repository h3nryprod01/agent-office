// Head gear that tells you which vendor an agent runs on, from across the room.
// Built in head-local space (the screen-head's pivot sits at the neck; the bezel
// spans y 0..0.5, x ±0.36). Purely decorative: no shadows, tiny meshes, and the
// materials are shared per colour so 40 agents don't mean 40 materials.

import * as THREE from "three";
import type { Accessory } from "./look";

const matCache = new Map<number, THREE.MeshStandardMaterial>();
/** one shared glowing material per colour */
function glow(hex: number): THREE.MeshStandardMaterial {
  let m = matCache.get(hex);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.55, roughness: 0.45 });
    m.userData.shared = true; // cached across agents — never dispose with one body
    matCache.set(hex, m);
  }
  return m;
}
const bit = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z = 0): THREE.Mesh => {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  return o;
};

export function buildAccessory(kind: Accessory, trim: number): THREE.Group | null {
  if (kind === "none") return null;
  const g = new THREE.Group();
  g.name = `accessory:${kind}`;
  const m = glow(trim);
  switch (kind) {
    case "antenna": // Codex: a status antenna with a lit bulb
      g.add(bit(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 8), m, 0.22, 0.65));
      g.add(bit(new THREE.SphereGeometry(0.075, 12, 12), m, 0.22, 0.83));
      break;
    case "sparks": // Gemini: a pair of four-point sparkles at the temples
      for (const x of [-0.43, 0.43]) {
        const a = bit(new THREE.BoxGeometry(0.15, 0.15, 0.05), m, x, 0.42);
        a.rotation.z = Math.PI / 4;
        g.add(a);
        g.add(bit(new THREE.BoxGeometry(0.03, 0.3, 0.03), m, x, 0.42));
        g.add(bit(new THREE.BoxGeometry(0.3, 0.03, 0.03), m, x, 0.42));
      }
      break;
    case "hardhat": { // claude-worker: a hard hat in the lane's colour
      const dome = bit(new THREE.SphereGeometry(0.38, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), m, 0, 0.47);
      dome.scale.set(1, 0.7, 0.62);
      g.add(dome);
      g.add(bit(new THREE.BoxGeometry(0.82, 0.035, 0.36), m, 0, 0.475, 0.08)); // brim
      g.add(bit(new THREE.BoxGeometry(0.1, 0.05, 0.3), glow(0xffffff), 0, 0.74, 0)); // ridge
      break;
    }
    case "wings": // Hermes: winged helm
      for (const side of [-1, 1]) {
        const wing = new THREE.Group();
        wing.position.set(side * 0.4, 0.32, -0.02);
        wing.rotation.z = side * -0.5;
        [0.34, 0.27, 0.2].forEach((len, i) => {
          const f = bit(new THREE.BoxGeometry(len, 0.06, 0.04), m, side * (len / 2 + 0.02), 0.07 - i * 0.075);
          f.rotation.z = side * (0.12 - i * 0.12);
          wing.add(f);
        });
        g.add(wing);
      }
      break;
  }
  return g;
}
