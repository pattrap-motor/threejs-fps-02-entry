// Fighters and bot brains. One factory builds every combatant (the player's body too);
// bots get a box-built mesh and a brain that perceives through line of sight and hearing,
// follows the map's navigation graph, fights in bursts, and plays the objective —
// pushing a site, planting the charge, holding angles, retaking and defusing.
import * as THREE from 'three';
import { G } from './state.js';
import { PALETTE, TEAM_COLORS } from './palette.js';
import { moveBody, losClear, bodyHeight } from './physics.js';
import { yawToward, dist2d } from './map.js';
import { newWeapon, currentWeapon, tryFire, startReload, throwSelected } from './weapons.js';

export const BOT_NAMES = {
  0: ['Vex', 'Onyx', 'Rook', 'Sable'],
  1: ['Hale', 'Ivers', 'Marsh', 'Quill', 'Tarn'],
};

// Accelerate a body toward a wish velocity and integrate it. Shared by bots and the
// player controller so everyone moves by the same rules.
export function driveBody(f, dt, wishX, wishZ, speed) {
  const blend = Math.min(1, dt * (f.onGround ? 11 : 2.2));
  f.vel.x += (wishX * speed - f.vel.x) * blend;
  f.vel.z += (wishZ * speed - f.vel.z) * blend;
  f.speedNow = Math.hypot(f.vel.x, f.vel.z);
  moveBody(f, dt);
}

function buildBotMesh(team) {
  const color = TEAM_COLORS[team];
  const dark = team === 0 ? PALETTE.breakersDark : PALETTE.wardensDark;
  const group = new THREE.Group();
  const mat = (c, rough = 0.85) => new THREE.MeshStandardMaterial({ color: c, roughness: rough });
  const add = (geo, material, x, y, z) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    group.add(m);
    return m;
  };
  // Legs hang from a hip pivot at 0.82 so the walk swing rotates them at the hip:
  // each leg's geometry is pre-translated to span from the pivot down to the ground.
  const legGeo = new THREE.BoxGeometry(0.17, 0.82, 0.21);
  legGeo.translate(0, -0.41, 0);
  const legL = add(legGeo, mat(PALETTE.trousers), -0.12, 0.82, 0);
  const legR = add(legGeo, mat(PALETTE.trousers), 0.12, 0.82, 0);
  const torso = add(new THREE.BoxGeometry(0.54, 0.64, 0.3), mat(color), 0, 1.13, 0);
  add(new THREE.BoxGeometry(0.56, 0.2, 0.32), mat(dark), 0, 0.92, 0);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.07, 0.02),
    new THREE.MeshBasicMaterial({ color }));
  stripe.position.set(0, 1.3, -0.16);
  group.add(stripe);
  const headPivot = new THREE.Group();
  headPivot.position.y = 1.45;
  group.add(headPivot);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.27, 0.27), mat(PALETTE.skin, 0.7));
  head.position.y = 0.14;
  head.castShadow = true;
  headPivot.add(head);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.1, 0.31), mat(dark));
  cap.position.y = 0.3;
  headPivot.add(cap);
  const armPivot = new THREE.Group();
  armPivot.position.set(0.18, 1.34, 0);
  group.add(armPivot);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.52), mat(color));
  arm.position.set(0, -0.02, -0.2);
  armPivot.add(arm);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.8), mat(PALETTE.gunmetal, 0.5));
  gun.position.set(0.02, 0.02, -0.55);
  gun.castShadow = true;
  armPivot.add(gun);
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.42, 0.11), mat(color));
  armL.position.set(-0.3, 1.16, -0.08);
  armL.rotation.x = 0.5;
  group.add(armL);
  return { group, legL, legR, torso, headPivot, armPivot };
}

// The brain's starting shape, shared by bots and by the demo-mode player body.
export function makeBrain(spawn) {
  return {
    state: 'move',
    role: 'push',
    site: 'A',
    hold: null,
    path: [],
    pathI: 0,
    destX: spawn.x,
    destZ: spawn.z,
    thinkAt: 0,
    visible: null,
    visibleAt: -9,
    reactionAt: 0,
    lastKnown: null,
    burstLeft: 0,
    burstWaitUntil: 0,
    strafeDir: 1,
    strafeAt: 0,
    crouchUntil: 0,
    scanPhase: G.rng ? G.rng.range(0, 6) : 0,
    usedFlash: false,
    repathAt: 0,
  };
}

let nextId = 1;

export function createFighter(scene, team, isPlayer, name, spawn) {
  const f = {
    id: nextId,
    team,
    isPlayer,
    name,
    alive: true,
    pos: { x: spawn.x, y: 0, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: team === 0 ? 0 : Math.PI,
    pitch: 0,
    crouch: 0,
    crouchTarget: 0,
    onGround: true,
    speedNow: 0,
    hp: 100,
    armor: 0,
    money: 800,
    weapons: { primary: null, sidearm: newWeapon('p9') },
    slot: 'sidearm',
    grenades: { frag: 0, flash: 0, smoke: 0 },
    reloadUntil: 0,
    nextShotAt: 0,
    nextThrowAt: 0,
    kick: 0,
    ads: 0,
    kills: 0,
    deaths: 0,
    shotsFired: 0,
    blindedUntil: 0,
    lastAttacker: null,
    lastHurtAt: -9,
    deathAt: 0,
    lastWeaponId: 'p9',
    skill: 0.55 + (isPlayer ? 0.3 : 0) ,
    walkPhase: 0,
    brain: null,
    mesh: null,
    parts: null,
  };
  nextId += 1;
  if (!isPlayer) {
    f.skill = 0.5 + G.rng.next() * 0.45;
    const built = buildBotMesh(team);
    f.mesh = built.group;
    f.parts = built;
    f.mesh.position.set(f.pos.x, 0, f.pos.z);
    scene.add(f.mesh);
    f.brain = makeBrain(spawn);
  }
  return f;
}

// Dijkstra over the navigation graph, snapped from the two endpoints.
export function findPath(map, sx, sz, tx, tz) {
  const { nodes, adj } = map.nav;
  const nearest = (x, z) => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      const d = dist2d(x, z, nodes[i].x, nodes[i].z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const start = nearest(sx, sz);
  const goal = nearest(tx, tz);
  const dist = new Array(nodes.length).fill(Infinity);
  const prev = new Array(nodes.length).fill(-1);
  const done = new Array(nodes.length).fill(false);
  dist[start] = 0;
  for (let n = 0; n < nodes.length; n += 1) {
    let u = -1;
    let ud = Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      if (!done[i] && dist[i] < ud) { ud = dist[i]; u = i; }
    }
    if (u === -1 || u === goal) break;
    done[u] = true;
    for (const e of adj[u]) {
      if (dist[u] + e.cost < dist[e.to]) {
        dist[e.to] = dist[u] + e.cost;
        prev[e.to] = u;
      }
    }
  }
  const path = [];
  let cur = goal;
  while (cur !== -1 && cur !== start) {
    path.push({ x: nodes[cur].x, z: nodes[cur].z });
    cur = prev[cur];
  }
  path.reverse();
  path.push({ x: tx, z: tz });
  return path;
}

function canSee(f, e) {
  const d = dist2d(f.pos.x, f.pos.z, e.pos.x, e.pos.z);
  if (d > 62) return false;
  if (d > 4) {
    const fx = -Math.sin(f.yaw);
    const fz = -Math.cos(f.yaw);
    const dot = (fx * (e.pos.x - f.pos.x) + fz * (e.pos.z - f.pos.z)) / (d || 1);
    if (dot < 0.34) return false; // ~70 degree half-angle cone
  }
  const eyeY = f.pos.y + 1.55;
  return losClear(f.pos.x, eyeY, f.pos.z, e.pos.x, e.pos.y + 1.15, e.pos.z);
}

function setDest(f, map, x, z) {
  const b = f.brain;
  if (dist2d(b.destX, b.destZ, x, z) < 0.6 && b.path.length) return;
  b.destX = x;
  b.destZ = z;
  b.path = findPath(map, f.pos.x, f.pos.z, x, z);
  b.pathI = 0;
}

// Steering toward the current path point; returns true when the destination is reached.
function followPath(f, dt, speed) {
  const b = f.brain;
  while (b.pathI < b.path.length) {
    const p = b.path[b.pathI];
    if (dist2d(f.pos.x, f.pos.z, p.x, p.z) < 1.0) b.pathI += 1;
    else break;
  }
  const target = b.path[b.pathI] || { x: b.destX, z: b.destZ };
  const dx = target.x - f.pos.x;
  const dz = target.z - f.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.7 && b.pathI >= b.path.length - 1) {
    driveBody(f, dt, 0, 0, 0);
    return true;
  }
  // Gentle separation so teammates do not stack on one tile.
  let sx = 0;
  let sz = 0;
  for (const o of G.fighters) {
    if (o === f || !o.alive) continue;
    const od = dist2d(f.pos.x, f.pos.z, o.pos.x, o.pos.z);
    if (od > 0.01 && od < 0.95) {
      sx += ((f.pos.x - o.pos.x) / od) * (0.95 - od);
      sz += ((f.pos.z - o.pos.z) / od) * (0.95 - od);
    }
  }
  const wx = dx / (d || 1) + sx * 1.4;
  const wz = dz / (d || 1) + sz * 1.4;
  const wl = Math.hypot(wx, wz) || 1;
  f.yaw = turnToward(f.yaw, Math.atan2(-wx / wl, -wz / wl), dt * 7);
  driveBody(f, dt, wx / wl, wz / wl, speed);
  return false;
}

export function turnToward(current, target, maxStep) {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const step = Math.max(-maxStep, Math.min(maxStep, diff));
  return current + step;
}

function aimDirection(f, e, headChance) {
  const h = bodyHeight(e);
  const aimY = e.pos.y + (G.rng.chance(headChance) ? h - 0.1 : h * 0.68);
  let dx = e.pos.x - f.pos.x;
  let dy = aimY - (f.pos.y + 1.5);
  let dz = e.pos.z - f.pos.z;
  const d = Math.hypot(dx, dy, dz) || 1;
  dx /= d; dy /= d; dz /= d;
  // Aim error: worse for weaker bots, worse while moving, better when holding still.
  const err = (1.06 - f.skill) * 0.052 * (f.speedNow > 0.6 ? 1.7 : 1);
  const ex = (G.rng.next() * 2 - 1) * err;
  const ey = (G.rng.next() * 2 - 1) * err * 0.7;
  const ez = (G.rng.next() * 2 - 1) * err;
  const vx = dx - dz * ex;
  const vz = dz + dx * ex;
  const vy = dy + ey + ez * 0.2;
  const l = Math.hypot(vx, vy, vz) || 1;
  return { x: vx / l, y: vy / l, z: vz / l };
}

function engage(f, dt, e) {
  const b = f.brain;
  const d = dist2d(f.pos.x, f.pos.z, e.pos.x, e.pos.z);
  f.yaw = turnToward(f.yaw, yawToward(f.pos.x, f.pos.z, e.pos.x, e.pos.z), dt * 11);
  f.pitch = Math.max(-0.4, Math.min(0.4, (e.pos.y + 1.1 - (f.pos.y + 1.5)) / (d || 1)));
  // Range keeping and strafing: hold 7–20 m, sidestep on a timer, sometimes crouch.
  if (G.time > b.strafeAt) {
    b.strafeAt = G.time + G.rng.range(0.55, 1.25);
    b.strafeDir = G.rng.chance(0.5) ? 1 : -1;
    if (d > 13 && G.rng.chance(0.4)) b.crouchUntil = G.time + G.rng.range(0.8, 1.6);
  }
  f.crouchTarget = G.time < b.crouchUntil ? 1 : 0;
  const fxv = -Math.sin(f.yaw);
  const fzv = -Math.cos(f.yaw);
  // Strafe perpendicular to the facing, with range-keeping mixed in.
  let wx = -fzv * b.strafeDir;
  let wz = fxv * b.strafeDir;
  if (d > 20) { wx += fxv * 0.9; wz += fzv * 0.9; }
  if (d < 5.5) { wx -= fxv * 0.8; wz -= fzv * 0.8; }
  const wl = Math.hypot(wx, wz) || 1;
  driveBody(f, dt, wx / wl, wz / wl, 3.1);
  // Fire in bursts once the reaction time has passed and any flash has worn off.
  if (G.time < b.reactionAt || G.time < f.blindedUntil) return;
  if (b.burstLeft <= 0) {
    if (G.time < b.burstWaitUntil) return;
    const w = currentWeapon(f);
    b.burstLeft = w && w.def.id === 'longbow' ? 1 : G.rng.int(3, 7);
  }
  const dir = aimDirection(f, e, 0.22);
  if (tryFire(f, dir.x, dir.y, dir.z)) {
    b.burstLeft -= 1;
    if (b.burstLeft <= 0) b.burstWaitUntil = G.time + G.rng.range(0.35, 0.85);
  } else {
    const w = currentWeapon(f);
    if (w && w.mag === 0) startReload(f);
  }
}

export function updateBot(f, dt, map) {
  const b = f.brain;
  if (!f.alive) return;
  f.crouch += (f.crouchTarget - f.crouch) * Math.min(1, dt * 9);
  const phase = G.phase;
  if (phase !== 'live' && phase !== 'planted') {
    driveBody(f, dt, 0, 0, 0);
    return;
  }

  // --- perception, on a think tick -------------------------------------------
  if (G.time >= b.thinkAt) {
    b.thinkAt = G.time + 0.12;
    let seen = null;
    let seenDist = Infinity;
    if (G.time >= f.blindedUntil) {
      for (const e of G.fighters) {
        if (!e.alive || e.team === f.team) continue;
        if (canSee(f, e)) {
          const d = dist2d(f.pos.x, f.pos.z, e.pos.x, e.pos.z);
          if (d < seenDist) { seenDist = d; seen = e; }
        }
      }
    }
    if (seen) {
      if (b.visible !== seen) b.reactionAt = G.time + 0.46 - f.skill * 0.24;
      b.visible = seen;
      b.visibleAt = G.time;
      b.lastKnown = { x: seen.pos.x, z: seen.pos.z, t: G.time };
    } else {
      if (b.visible && G.time - b.visibleAt > 0.4) b.visible = null;
      // Hearing: fresh enemy gunfire pulls attention.
      for (let i = G.noises.length - 1; i >= 0; i -= 1) {
        const n = G.noises[i];
        if (n.team === f.team || G.time - n.t > 1.6) continue;
        if (dist2d(f.pos.x, f.pos.z, n.x, n.z) < (n.quiet ? 9 : 27)) {
          if (!b.lastKnown || G.time - b.lastKnown.t > 2) b.lastKnown = { x: n.x, z: n.z, t: n.t };
        }
        break;
      }
    }
    // Reload when the magazine runs dry and nobody is in the face.
    const w = currentWeapon(f);
    if (w && w.mag === 0 && !b.visible) startReload(f);
    if (w && w.mag <= 2 && w.reserve === 0 && f.slot === 'primary') f.slot = 'sidearm';
  }

  const visible = b.visible && b.visible.alive ? b.visible : null;

  // --- objective states ---------------------------------------------------------
  if (G.bomb.state === 'planted' && f.team === 1) {
    // Wardens retake: move to the charge; the closest one defuses when it is safe.
    if (!visible && dist2d(f.pos.x, f.pos.z, G.bomb.x, G.bomb.z) < 1.7) {
      driveBody(f, dt, 0, 0, 0);
      f.crouchTarget = 1;
      b.state = 'defuse';
      return;
    }
    if (visible) { engage(f, dt, visible); b.state = 'engage'; return; }
    setDest(f, map, G.bomb.x, G.bomb.z);
    followPath(f, dt, 4.5);
    b.state = 'retake';
    return;
  }
  if (G.bomb.state === 'planted' && f.team === 0) {
    // Breakers fall back to hold points around the planted site.
    const site = map.sites.find((s) => s.id === G.bomb.site) || map.sites[0];
    const holds = map.holds[site.id];
    const hold = holds[f.id % holds.length];
    if (visible) { engage(f, dt, visible); b.state = 'engage'; return; }
    if (dist2d(f.pos.x, f.pos.z, hold.x, hold.z) > 1.6) {
      setDest(f, map, hold.x, hold.z);
      followPath(f, dt, 4.4);
    } else {
      holdAngle(f, dt, hold);
    }
    b.state = 'hold';
    return;
  }

  if (visible) { engage(f, dt, visible); b.state = 'engage'; return; }

  // The carrier plants when the site is reached and no enemy is in sight.
  if (G.bomb.carrier === f && phase === 'live') {
    const site = map.sites.find((s) => s.id === b.site) || map.sites[0];
    if (dist2d(f.pos.x, f.pos.z, site.x, site.z) < site.r - 1.2) {
      driveBody(f, dt, 0, 0, 0);
      f.crouchTarget = 1;
      b.state = 'plant';
      return;
    }
  }
  f.crouchTarget = 0;

  // A dropped charge is picked up by the nearest pushing Breaker walking over it.
  // (Handled by proximity in rounds.js; bots simply route past it toward the site.)

  // --- movement toward the role's objective --------------------------------------
  if (b.role === 'hold' && b.hold) {
    if (dist2d(f.pos.x, f.pos.z, b.hold.x, b.hold.z) > 1.6) {
      setDest(f, map, b.hold.x, b.hold.z);
      followPath(f, dt, 4.4);
      b.state = 'move';
    } else {
      holdAngle(f, dt, b.hold);
      b.state = 'hold';
    }
    // A holder with fresh information rotates toward the contact.
    if (b.lastKnown && G.time - b.lastKnown.t < 2.5 && G.bomb.state !== 'planted') {
      f.yaw = turnToward(f.yaw, yawToward(f.pos.x, f.pos.z, b.lastKnown.x, b.lastKnown.z), dt * 5);
    }
    return;
  }

  // Pushers and the carrier head for their site; a recent contact diverts them,
  // and a dropped charge diverts the nearest pusher to recover it.
  let tx;
  let tz;
  if (G.bomb.state === 'dropped' && f.team === 0 && G.bomb.carrier !== f) {
    tx = G.bomb.x;
    tz = G.bomb.z;
    setDest(f, map, tx, tz);
    followPath(f, dt, 4.45);
    b.state = 'recover';
    return;
  }
  if (b.lastKnown && G.time - b.lastKnown.t < 3.5 && dist2d(f.pos.x, f.pos.z, b.lastKnown.x, b.lastKnown.z) < 24) {
    tx = b.lastKnown.x;
    tz = b.lastKnown.z;
  } else {
    const site = map.sites.find((s) => s.id === b.site) || map.sites[0];
    tx = site.x;
    tz = site.z;
    // Flash the site entry once, shortly before arriving.
    if (!b.usedFlash && f.grenades.flash > 0 && dist2d(f.pos.x, f.pos.z, tx, tz) < 15) {
      b.usedFlash = true;
      f.slot = 'flash';
      const dx = tx - f.pos.x;
      const dz = tz - f.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      throwSelected(f, dx / d, 0.24, dz / d);
    }
  }
  setDest(f, map, tx, tz);
  followPath(f, dt, 4.45);
  b.state = 'move';
}

function holdAngle(f, dt, hold) {
  driveBody(f, dt, 0, 0, 0);
  const b = f.brain;
  const base = yawToward(f.pos.x, f.pos.z, hold.lookX, hold.lookZ);
  f.yaw = turnToward(f.yaw, base + Math.sin(G.time * 0.45 + b.scanPhase) * 0.42, dt * 3);
  f.crouchTarget = f.id % 2 === 0 ? 1 : 0;
}

// Sync a bot's mesh to its body: position, facing, walk swing, crouch, death fall.
export function updateBotMesh(f, dt) {
  if (!f.mesh) return;
  const p = f.parts;
  f.mesh.position.set(f.pos.x, f.pos.y, f.pos.z);
  f.mesh.rotation.y = f.yaw;
  if (!f.alive) {
    const t = Math.min(1, (G.time - f.deathAt) / 0.45);
    f.mesh.rotation.x = -t * Math.PI * 0.48;
    f.mesh.position.y = f.pos.y - t * 0.12;
    return;
  }
  f.mesh.rotation.x = 0;
  const speed = Math.hypot(f.vel.x, f.vel.z);
  f.walkPhase += dt * speed * 2.6;
  const swing = Math.sin(f.walkPhase) * Math.min(0.55, speed * 0.14);
  p.legL.rotation.x = swing;
  p.legR.rotation.x = -swing;
  const crouchDip = f.crouch * 0.34;
  p.torso.position.y = 1.13 - crouchDip;
  p.headPivot.position.y = 1.45 - crouchDip;
  p.armPivot.position.y = 1.34 - crouchDip;
  p.armPivot.rotation.x = f.pitch;
  p.headPivot.rotation.x = f.pitch * 0.7;
}
