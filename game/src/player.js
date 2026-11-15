// The human player's controller and first-person viewmodel. Mouse look with pointer
// lock, acceleration-based WASD movement, crouch and jump, aim-down-sights, weapon
// switching, reloading, grenade throwing and the interact key — all feeding the same
// body and weapon code the bots use. In demo mode a bot brain drives the body instead
// and this module only works the camera.
import * as THREE from 'three';
import { G, pushEvent } from './state.js';
import { eyeHeight } from './physics.js';
import { driveBody, updateBot } from './bots.js';
import { WEAPONS, currentWeapon, tryFire, startReload, throwSelected } from './weapons.js';
import { PALETTE } from './palette.js';

const SENS = 0.0023;
const WALK = 4.6;
const gunMats = {
  body: new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: 0.45, metalness: 0.55 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.5, metalness: 0.5 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x74522f, roughness: 0.8, metalness: 0.05 }),
  accent: new THREE.MeshStandardMaterial({ color: PALETTE.breakers, roughness: 0.5, metalness: 0.3 }),
};

function gunMesh(id) {
  const g = new THREE.Group();
  const add = (sx, sy, sz, x, y, z, mat = gunMats.body) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  if (id === 'p9') {
    add(0.07, 0.11, 0.3, 0, 0, -0.1, gunMats.dark);
    add(0.06, 0.16, 0.09, 0, -0.11, 0.03);
    add(0.02, 0.05, 0.02, 0, 0.08, -0.24, gunMats.accent);
  } else if (id === 'rook') {
    add(0.08, 0.13, 0.52, 0, 0, -0.16);
    add(0.05, 0.05, 0.3, 0, 0.02, -0.55, gunMats.dark);
    add(0.06, 0.2, 0.08, 0, -0.15, -0.12);
    add(0.07, 0.1, 0.14, 0, -0.02, 0.14, gunMats.dark);
    add(0.03, 0.06, 0.03, 0, 0.1, -0.3, gunMats.accent);
  } else if (id === 'longbow') {
    add(0.08, 0.12, 0.78, 0, 0, -0.3, gunMats.wood);
    add(0.045, 0.045, 0.5, 0, 0.03, -0.85, gunMats.dark);
    add(0.07, 0.09, 0.22, 0, 0.13, -0.28, gunMats.dark); // scope
    add(0.06, 0.18, 0.08, 0, -0.14, -0.18);
    add(0.07, 0.1, 0.16, 0, -0.03, 0.18, gunMats.dark);
  } else { // vk7
    add(0.08, 0.14, 0.58, 0, 0, -0.2);
    add(0.05, 0.05, 0.34, 0, 0.03, -0.62, gunMats.dark);
    add(0.06, 0.22, 0.09, 0, -0.16, -0.14);
    add(0.07, 0.11, 0.18, 0, -0.02, 0.16, gunMats.dark);
    add(0.04, 0.09, 0.04, 0, 0.12, -0.34, gunMats.accent); // front post
    add(0.05, 0.07, 0.1, 0, 0.11, 0.02, gunMats.dark);      // rear sight
  }
  return g;
}

function grenadeMesh(type) {
  const g = new THREE.Group();
  const color = type === 'frag' ? 0x44513a : type === 'flash' ? 0xb9c0c7 : 0x707880;
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 12, 10),
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 }),
  );
  g.add(m);
  const pin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.07, 0.02), gunMats.dark);
  pin.position.y = 0.09;
  g.add(pin);
  return g;
}

export function createPlayerView(camera) {
  const holder = new THREE.Group();
  camera.add(holder);
  const guns = {};
  for (const id of Object.keys(WEAPONS)) {
    guns[id] = gunMesh(id);
    guns[id].visible = false;
    holder.add(guns[id]);
  }
  const nades = {};
  for (const type of ['frag', 'flash', 'smoke']) {
    nades[type] = grenadeMesh(type);
    nades[type].visible = false;
    holder.add(nades[type]);
  }
  let prevFiring = false;
  let stepNoiseAt = 0;

  function aimDir(f) {
    const cp = Math.cos(f.pitch);
    return {
      x: -Math.sin(f.yaw) * cp,
      y: Math.sin(f.pitch),
      z: -Math.cos(f.yaw) * cp,
    };
  }

  function switchTo(f, slot) {
    if (f.slot === slot) return;
    if (slot === 'primary' && !f.weapons.primary) return;
    if ((slot === 'frag' || slot === 'flash' || slot === 'smoke') && f.grenades[slot] <= 0) return;
    f.slot = slot;
    f.reloadUntil = 0;
    f.nextShotAt = Math.max(f.nextShotAt, G.time + 0.24);
  }

  function update(dt, input, map) {
    const f = G.player;
    if (G.demo) {
      updateBot(f, dt, map);
    } else if (f.alive && !G.paused && G.phase !== 'live' && G.phase !== 'planted') {
      // Buy, end and match-over phases: the player may look around but not act.
      const look = input.takeLook();
      f.yaw -= look.x * SENS;
      f.pitch = Math.max(-1.45, Math.min(1.45, f.pitch - look.y * SENS));
      G.interactHeld = false;
      driveBody(f, dt, 0, 0, 0);
    } else if (f.alive && !G.paused) {
      const look = input.takeLook();
      f.yaw -= look.x * SENS;
      f.pitch = Math.max(-1.45, Math.min(1.45, f.pitch - look.y * SENS));
      const keys = input.state.keys;
      f.crouchTarget = keys.has('ControlLeft') || keys.has('KeyC') ? 1 : 0;
      f.crouch += (f.crouchTarget - f.crouch) * Math.min(1, dt * 10);
      const slow = keys.has('ShiftLeft') || keys.has('ShiftRight');
      f.ads += ((input.state.aiming ? 1 : 0) - f.ads) * Math.min(1, dt * 9);
      let ix = 0;
      let iz = 0;
      if (keys.has('KeyW')) iz -= 1;
      if (keys.has('KeyS')) iz += 1;
      if (keys.has('KeyA')) ix -= 1;
      if (keys.has('KeyD')) ix += 1;
      const sin = Math.sin(f.yaw);
      const cos = Math.cos(f.yaw);
      const fwdX = -sin;
      const fwdZ = -cos;
      const rightX = cos;
      const rightZ = -sin;
      let wx = fwdX * -iz + rightX * ix;
      let wz = fwdZ * -iz + rightZ * ix;
      const wl = Math.hypot(wx, wz);
      if (wl > 1) { wx /= wl; wz /= wl; }
      const speed = f.crouchTarget ? 2.3 : slow ? 2.7 : WALK;
      if (keys.has('Space') && f.onGround && f.crouchTarget === 0) {
        f.vel.y = 4.7;
        f.onGround = false;
      }
      driveBody(f, dt, wx, wz, speed);
      if (f.speedNow > 3.2 && f.onGround && G.time > stepNoiseAt) {
        stepNoiseAt = G.time + 0.37;
        G.noises.push({ x: f.pos.x, z: f.pos.z, team: f.team, t: G.time, quiet: true });
      }
      // Weapon handling.
      if (keys.has('Digit1')) switchTo(f, 'primary');
      if (keys.has('Digit2')) switchTo(f, 'sidearm');
      if (keys.has('Digit3')) switchTo(f, 'frag');
      if (keys.has('Digit4')) switchTo(f, 'flash');
      if (keys.has('Digit5')) switchTo(f, 'smoke');
      const wheel = input.takeWheel();
      if (wheel !== 0) switchTo(f, f.slot === 'primary' ? 'sidearm' : 'primary');
      if (keys.has('KeyR')) startReload(f);
      G.interactHeld = keys.has('KeyE');
      const firing = input.state.firing;
      const dir = aimDir(f);
      if (f.slot === 'frag' || f.slot === 'flash' || f.slot === 'smoke') {
        if (firing && !prevFiring) throwSelected(f, dir.x, dir.y, dir.z);
      } else {
        const w = currentWeapon(f);
        if (firing && (w.def.auto || !prevFiring)) tryFire(f, dir.x, dir.y, dir.z);
      }
      prevFiring = firing;
    } else {
      G.interactHeld = false;
      driveBody(f, dt, 0, 0, 0);
    }

    // --- camera and viewmodel ---------------------------------------------------
    f.kick *= Math.pow(0.0001, dt); // fast decay back to rest
    if (f.kick < 0.0005) f.kick = 0;
    const eye = f.pos.y + (f.alive ? eyeHeight(f) : 0.5);
    camera.position.set(f.pos.x, eye, f.pos.z);
    if (G.shakeAmp > 0.002) {
      camera.position.x += (Math.random() * 2 - 1) * G.shakeAmp * 0.07;
      camera.position.y += (Math.random() * 2 - 1) * G.shakeAmp * 0.07;
    }
    camera.rotation.set(f.pitch + f.kick, f.yaw, 0, 'YXZ');
    const w = currentWeapon(f);
    for (const id of Object.keys(guns)) guns[id].visible = false;
    for (const t of Object.keys(nades)) nades[t].visible = false;
    const showHands = f.alive && (!G.demo || G.shotMode);
    if (showHands && w) {
      const gun = guns[w.def.id];
      gun.visible = true;
      const scoped = w.def.id === 'longbow' && f.ads > 0.65;
      gun.visible = !scoped;
      const adsX = 0;
      const hipX = 0.25;
      const x = hipX + (adsX - hipX) * f.ads;
      const y = -0.235 + 0.1 * f.ads;
      let dip = 0;
      let roll = 0;
      if (f.reloadUntil > G.time) {
        const remain = f.reloadUntil - G.time;
        dip = Math.sin(Math.min(1, remain / w.def.reload) * Math.PI) * 0.35;
        roll = dip * 0.7;
      }
      const sway = Math.sin(G.time * 1.7) * 0.0035 + f.speedNow * 0.004 * Math.sin(G.time * 8.4);
      gun.position.set(x, y - dip * 0.22 + sway, -0.5 + f.kick * 1.4);
      gun.rotation.set(f.kick * 1.8 + dip, 0, roll);
      const targetFov = 74 / (1 + (w.def.zoom - 1) * f.ads);
      if (Math.abs(camera.fov - targetFov) > 0.1) {
        camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10);
        camera.updateProjectionMatrix();
      }
    } else if (showHands && (f.slot === 'frag' || f.slot === 'flash' || f.slot === 'smoke')) {
      const nade = nades[f.slot];
      nade.visible = true;
      nade.position.set(0.24, -0.2, -0.42);
    } else if (camera.fov !== 74) {
      camera.fov = 74;
      camera.updateProjectionMatrix();
    }
    holder.visible = showHands;
  }

  return { update };
}
