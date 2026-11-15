// Transient visuals: tracers, impact particles, muzzle flash, grenade projectiles, the
// planted charge and smoke clouds. Everything is pooled and updated in place — the hot
// loop allocates nothing.
import * as THREE from 'three';
import { G, pushEvent } from './state.js';
import { PALETTE } from './palette.js';
import { colliders, losClear } from './physics.js';

const TRACER_MAX = 48;
const PARTICLE_MAX = 420;

let scene = null;
let tracerGeo;
let tracerPos;
let tracerLife;
let tracerCursor = 0;
let points;
let pPos;
let pVel;
let pLife;
let pCursor = 0;
let flashLight;
let flashSprite;
let flashUntil = 0;
let bombMesh = null;
let bombLamp = null;

export const projectiles = []; // { mesh, vel, type, owner, team, fuseAt }
export const pendingBlasts = []; // frag damage waiting for weapons.applyDamage: { victim, dmg, attacker }
const smokeVisuals = [];       // { mesh, until }

export function initFx(s) {
  scene = s;
  tracerPos = new Float32Array(TRACER_MAX * 6);
  tracerLife = new Float32Array(TRACER_MAX);
  tracerGeo = new THREE.BufferGeometry();
  tracerGeo.setAttribute('position', new THREE.BufferAttribute(tracerPos, 3));
  const tracerMat = new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.85 });
  const lines = new THREE.LineSegments(tracerGeo, tracerMat);
  lines.frustumCulled = false;
  scene.add(lines);

  pPos = new Float32Array(PARTICLE_MAX * 3);
  pVel = new Float32Array(PARTICLE_MAX * 3);
  pLife = new Float32Array(PARTICLE_MAX);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  const pMat = new THREE.PointsMaterial({ color: 0xd8c9a8, size: 0.065, transparent: true, opacity: 0.9, depthWrite: false });
  points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  scene.add(points);
  for (let i = 0; i < PARTICLE_MAX; i += 1) pPos[i * 3 + 1] = -10;

  flashLight = new THREE.PointLight(0xffc37a, 0, 13, 1.8);
  scene.add(flashLight);
  const flashTex = makeFlashTexture();
  flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xffcf8a, transparent: true, depthWrite: false }));
  flashSprite.scale.set(0.55, 0.55, 1);
  flashSprite.visible = false;
  scene.add(flashSprite);
}

function makeFlashTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,240,200,1)');
  grad.addColorStop(0.35, 'rgba(255,180,80,0.75)');
  grad.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

export function spawnTracer(ax, ay, az, bx, by, bz) {
  const i = tracerCursor;
  tracerCursor = (tracerCursor + 1) % TRACER_MAX;
  tracerPos.set([ax, ay, az, bx, by, bz], i * 6);
  tracerLife[i] = 0.055;
  tracerGeo.attributes.position.needsUpdate = true;
}

export function spawnImpact(x, y, z, kind, n = 7) {
  for (let k = 0; k < n; k += 1) {
    const i = pCursor;
    pCursor = (pCursor + 1) % PARTICLE_MAX;
    pPos[i * 3] = x;
    pPos[i * 3 + 1] = y;
    pPos[i * 3 + 2] = z;
    const sp = kind === 'flesh' ? 1.1 : 2.2;
    pVel[i * 3] = (Math.random() - 0.5) * sp;
    pVel[i * 3 + 1] = Math.random() * sp * 0.9;
    pVel[i * 3 + 2] = (Math.random() - 0.5) * sp;
    pLife[i] = 0.28 + Math.random() * 0.25;
  }
}

export function muzzle(x, y, z) {
  flashSprite.position.set(x, y, z);
  flashSprite.visible = true;
  flashLight.position.set(x, y, z);
  flashLight.intensity = 30;
  flashUntil = G.time + 0.045;
}

const grenadeGeo = new THREE.SphereGeometry(0.09, 10, 8);
const grenadeMats = {
  frag: new THREE.MeshStandardMaterial({ color: 0x44513a, roughness: 0.6 }),
  flash: new THREE.MeshStandardMaterial({ color: 0xb9c0c7, roughness: 0.4, metalness: 0.5 }),
  smoke: new THREE.MeshStandardMaterial({ color: 0x707880, roughness: 0.6 }),
};

export function throwGrenade(owner, type, ox, oy, oz, dx, dy, dz) {
  const mesh = new THREE.Mesh(grenadeGeo, grenadeMats[type]);
  mesh.position.set(ox, oy, oz);
  scene.add(mesh);
  projectiles.push({
    mesh, type, owner, team: owner.team,
    vel: new THREE.Vector3(dx * 15, dy * 15 + 3.4, dz * 15),
    fuseAt: G.time + (type === 'frag' ? 1.7 : 1.15),
  });
  pushEvent('sound', { name: 'throwIt', x: ox, z: oz });
}

// The planted charge going off: a big flash, a particle burst and a shockwave event.
export function detonate(x, z) {
  spawnImpact(x, 1, z, 'blast', 90);
  spawnImpact(x, 2.5, z, 'blast', 40);
  flashLight.position.set(x, 2, z);
  flashLight.intensity = 900;
  flashUntil = G.time + 0.3;
  removeBombVisual();
  pushEvent('sound', { name: 'explosion', x, z });
  pushEvent('shake', { amount: 1.6, x, z });
}

export function placeBombVisual(x, z) {
  removeBombVisual();
  bombMesh = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.3, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.5, metalness: 0.3 }));
  body.position.y = 0.15;
  body.castShadow = true;
  bombMesh.add(body);
  bombLamp = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8),
    new THREE.MeshBasicMaterial({ color: PALETTE.charge }));
  bombLamp.position.set(0.14, 0.33, 0);
  bombMesh.add(bombLamp);
  bombMesh.position.set(x, 0, z);
  scene.add(bombMesh);
}

export function removeBombVisual() {
  if (bombMesh) {
    scene.remove(bombMesh);
    bombMesh = null;
    bombLamp = null;
  }
}

function explodeFrag(p) {
  const { x, y, z } = p.mesh.position;
  spawnImpact(x, y, z, 'blast', 42);
  flashLight.position.set(x, y + 0.4, z);
  flashLight.intensity = 320;
  flashUntil = G.time + 0.12;
  pushEvent('sound', { name: 'explosion', x, z });
  pushEvent('shake', { amount: 0.5, x, z });
  for (const f of G.fighters) {
    if (!f.alive) continue;
    const d = Math.hypot(f.pos.x - x, f.pos.z - z);
    if (d > 5.6) continue;
    if (!losClear(x, Math.max(y, 0.6), z, f.pos.x, f.pos.y + 1.1, f.pos.z)) continue;
    const dmg = Math.max(8, 96 * (1 - d / 6.2));
    pendingBlasts.push({ victim: f, dmg, attacker: p.owner });
  }
}

function explodeFlash(p) {
  const { x, y, z } = p.mesh.position;
  spawnImpact(x, y, z, 'flash', 20);
  flashLight.position.set(x, y + 0.3, z);
  flashLight.intensity = 420;
  flashUntil = G.time + 0.14;
  pushEvent('sound', { name: 'flash', x, z });
  for (const f of G.fighters) {
    if (!f.alive) continue;
    const d = Math.hypot(f.pos.x - x, f.pos.z - z);
    if (d > 17) continue;
    if (!losClear(x, Math.max(y, 0.8), z, f.pos.x, f.pos.y + 1.5, f.pos.z)) continue;
    // Looking toward the flash blinds fully; looking away only dazzles.
    const fx2 = -Math.sin(f.yaw);
    const fz2 = -Math.cos(f.yaw);
    const dot = (fx2 * (x - f.pos.x) + fz2 * (z - f.pos.z)) / (d || 1);
    const strength = dot > 0.25 ? 1 : dot > -0.4 ? 0.45 : 0.18;
    const dur = 3.1 * strength * Math.max(0.25, 1 - d / 19);
    if (dur > (f.blindedUntil - G.time)) f.blindedUntil = G.time + dur;
    if (f.isPlayer) pushEvent('flashblind', { dur });
  }
}

function explodeSmoke(p) {
  const { x, z } = p.mesh.position;
  pushEvent('sound', { name: 'throwIt', x, z });
  const until = G.time + 7.5;
  G.smokes.push({ x, z, r: 3.4, until });
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(3.4, 18, 12),
    new THREE.MeshStandardMaterial({ color: 0x9aa3ab, transparent: true, opacity: 0.52, roughness: 1, depthWrite: false }),
  );
  mesh.position.set(x, 1.5, z);
  mesh.scale.setScalar(0.2);
  scene.add(mesh);
  smokeVisuals.push({ mesh, until });
}

function stepProjectile(p, dt) {
  p.vel.y -= 11 * dt;
  p.mesh.position.addScaledVector(p.vel, dt);
  const pos = p.mesh.position;
  if (pos.y < 0.09) {
    pos.y = 0.09;
    p.vel.y = Math.abs(p.vel.y) * 0.35;
    p.vel.x *= 0.7;
    p.vel.z *= 0.7;
    if (p.type === 'smoke') { p.fuseAt = Math.min(p.fuseAt, G.time + 0.25); }
  }
  for (const c of colliders) {
    if (pos.x > c.minX && pos.x < c.maxX && pos.y > c.minY && pos.y < c.maxY && pos.z > c.minZ && pos.z < c.maxZ) {
      // Bounce back along the smallest penetration axis.
      const pens = [pos.x - c.minX, c.maxX - pos.x, pos.z - c.minZ, c.maxZ - pos.z, pos.y - c.minY, c.maxY - pos.y];
      const m = Math.min(...pens);
      if (m === pens[0]) { pos.x = c.minX - 0.05; p.vel.x = -Math.abs(p.vel.x) * 0.4; }
      else if (m === pens[1]) { pos.x = c.maxX + 0.05; p.vel.x = Math.abs(p.vel.x) * 0.4; }
      else if (m === pens[2]) { pos.z = c.minZ - 0.05; p.vel.z = -Math.abs(p.vel.z) * 0.4; }
      else if (m === pens[3]) { pos.z = c.maxZ + 0.05; p.vel.z = Math.abs(p.vel.z) * 0.4; }
      else if (m === pens[4]) { pos.y = c.minY - 0.05; p.vel.y = -Math.abs(p.vel.y) * 0.4; }
      else { pos.y = c.maxY + 0.05; p.vel.y = Math.abs(p.vel.y) * 0.4; }
    }
  }
}

export function updateFx(dt) {
  // Tracers fade by collapsing to a point.
  let tracerDirty = false;
  for (let i = 0; i < TRACER_MAX; i += 1) {
    if (tracerLife[i] <= 0) continue;
    tracerLife[i] -= dt;
    if (tracerLife[i] <= 0) {
      tracerPos[i * 6 + 3] = tracerPos[i * 6];
      tracerPos[i * 6 + 4] = tracerPos[i * 6 + 1];
      tracerPos[i * 6 + 5] = tracerPos[i * 6 + 2];
      tracerDirty = true;
    }
  }
  if (tracerDirty) tracerGeo.attributes.position.needsUpdate = true;

  let pDirty = false;
  for (let i = 0; i < PARTICLE_MAX; i += 1) {
    if (pLife[i] <= 0) continue;
    pLife[i] -= dt;
    pVel[i * 3 + 1] -= 5.5 * dt;
    pPos[i * 3] += pVel[i * 3] * dt;
    pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
    pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
    if (pLife[i] <= 0 || pPos[i * 3 + 1] < 0) pPos[i * 3 + 1] = -10;
    pDirty = true;
  }
  if (pDirty) points.geometry.attributes.position.needsUpdate = true;

  if (G.time > flashUntil) {
    flashLight.intensity = 0;
    flashSprite.visible = false;
  }

  for (let i = projectiles.length - 1; i >= 0; i -= 1) {
    const p = projectiles[i];
    stepProjectile(p, dt);
    if (G.time >= p.fuseAt) {
      if (p.type === 'frag') explodeFrag(p);
      else if (p.type === 'flash') explodeFlash(p);
      else explodeSmoke(p);
      scene.remove(p.mesh);
      projectiles.splice(i, 1);
    }
  }

  for (let i = smokeVisuals.length - 1; i >= 0; i -= 1) {
    const s = smokeVisuals[i];
    const grow = Math.min(1, s.mesh.scale.x + dt * 1.6);
    s.mesh.scale.setScalar(grow);
    if (G.time > s.until) {
      scene.remove(s.mesh);
      smokeVisuals.splice(i, 1);
    }
  }
  // Prune expired smoke from the state list the physics module reads.
  for (let i = G.smokes.length - 1; i >= 0; i -= 1) {
    if (G.smokes[i].until < G.time) G.smokes.splice(i, 1);
  }

  if (bombLamp) {
    const rate = G.phase === 'planted' && G.bombTimer < 10 ? 9 : 2.2;
    bombLamp.visible = Math.sin(G.time * rate * Math.PI) > -0.2;
  }
}
