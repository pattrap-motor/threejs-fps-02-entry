// DOCKLINE — boot and the one game loop. A fixed 60 Hz simulation (rounds, player,
// bots, weapons, effects) feeds a render at the display's rate; events produced by the
// simulation are drained once per frame to the round director, the HUD and the audio.
//
// Modes: plain play (click for pointer lock); ?demo=1 lets a bot brain drive the
// player's body for an attract match; ?shot=cover|buy|fight|plant&seed=N stages a
// deterministic scene with the game's own systems, settles it, freezes it and sets
// window.__shotReady for the maker's screenshots.
import * as THREE from 'three';
import { G, TEAM, pushEvent } from './state.js';
import { makeRng } from './rng.js';
import { PALETTE } from './palette.js';
import { buildMap, yawToward } from './map.js';
import { createInput } from './input.js';
import { initFx, updateFx, placeBombVisual } from './fx.js';
import { initMatch, startMatch, updateRounds, handleEvent as roundsEvent } from './rounds.js';
import { updateBot, updateBotMesh, makeBrain } from './bots.js';
import { createPlayerView } from './player.js';
import { updateFighterWeapons, drainBlasts, newWeapon, tryFire } from './weapons.js';
import { createHud } from './hud.js';
import { sfx } from './audio.js';

const FIXED = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '7', 10) || 7;
G.rng = makeRng(seed * 1000 + 17);
G.demo = params.get('demo') === '1' || !!shot;
G.shotMode = !!shot;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 520);
scene.add(camera);

const map = buildMap(scene);
initFx(scene);
const player = initMatch(scene, map);
if (G.demo) {
  player.brain = makeBrain({ x: player.pos.x, z: player.pos.z });
  player.skill = 0.85;
}
const view = createPlayerView(camera);
let hud;
const input = createInput(renderer.domElement, onLockChange);
hud = createHud({
  onPlay: () => input.requestLock(),
  onRestart: () => {
    startMatch();
    input.requestLock();
  },
});
window.__game = G;

function onLockChange(locked) {
  if (G.demo) return;
  if (locked) {
    hud.showOverlay(null);
    if (G.phase === 'menu') startMatch();
    G.paused = false;
  } else if (G.phase !== 'menu' && G.phase !== 'matchover') {
    G.paused = true;
    hud.showOverlay('paused');
  }
}

// --- sound and screen-shake dispatch ------------------------------------------------
function dispatchEvent(e) {
  roundsEvent(e);
  hud.handleEvent(e);
  const p = G.player;
  const d = p && e.x !== undefined ? Math.hypot(e.x - p.pos.x, e.z - p.pos.z) : 0;
  if (e.type === 'sound') {
    switch (e.name) {
      case 'shot': sfx.shot(e.weapon, e.shooter === p ? 0 : d); break;
      case 'dryFire': if (d < 3) sfx.dryFire(); break;
      case 'reload': if (d < 13) sfx.reload(); break;
      case 'explosion': sfx.explosion(d < 30); break;
      case 'flash': if (d < 22) sfx.flash(); break;
      case 'beep': if (d < 32) sfx.beep(e.final); break;
      case 'buy': sfx.buy(); break;
      default: break;
    }
  } else if (e.type === 'hitmark') {
    sfx.hit(e.kill);
  } else if (e.type === 'hurt') {
    sfx.hurt();
  } else if (e.type === 'roundend') {
    sfx.roundEnd(e.winner === p.team);
  } else if (e.type === 'planted') {
    sfx.plant();
  } else if (e.type === 'shake') {
    const fall = Math.max(0, 1 - d / 20);
    G.shakeAmp = Math.max(G.shakeAmp, e.amount * fall);
  } else if (e.type === 'matchover') {
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

function drainEvents() {
  while (G.events.length) dispatchEvent(G.events.shift());
}

// --- the fixed-step simulation ---------------------------------------------------------
function step(dt) {
  G.time += dt;
  G.shakeAmp *= Math.exp(-5.5 * dt);
  updateRounds(dt);
  view.update(dt, input, map);
  for (const f of G.fighters) {
    if (f.isPlayer) continue;
    updateBot(f, dt, map);
  }
  for (const f of G.fighters) {
    updateFighterWeapons(f);
    updateBotMesh(f, dt);
  }
  drainBlasts();
  updateFx(dt);
}

let accumulator = 0;
let lastTime = performance.now();
let frozen = false;
let demoReadyAt = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen && !G.paused) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED && steps < 5) {
      step(FIXED);
      accumulator -= FIXED;
      steps += 1;
    }
    if (accumulator > FIXED * 5) accumulator = 0;
    drainEvents();
    if (G.demo && !shot && !demoReadyAt && G.time > 3) {
      demoReadyAt = G.time;
      window.__shotReady = true;
    }
  }
  hud.update();
  renderer.render(scene, camera);
}

function settle(steps) {
  for (let i = 0; i < steps; i += 1) step(FIXED);
  drainEvents();
}

// --- screenshot staging ------------------------------------------------------------------
function givePlayer(id) {
  player.weapons.primary = newWeapon(id);
  player.slot = 'primary';
  player.money = 4150;
  player.armor = 100;
}

function stageShot(name) {
  if (name === 'buy') G.allowBuyMenu = true;
  startMatch();
  hud.showOverlay(null);
  if (name === 'buy') {
    G.phaseT = 11.4; // a believable buy clock for the capture
    const mates = G.fighters.filter((f) => f.brain && f.team === TEAM.BREAKERS);
    mates[0].pos.x = -2.2; mates[0].pos.z = 25.5;
    mates[1].pos.x = 2.6; mates[1].pos.z = 24.8;
    mates[2].pos.x = -5.5; mates[2].pos.z = 27.5;
    player.pos.x = 0;
    player.pos.z = 30;
    player.yaw = 0;
    settle(4);
    player.money = 4300;
    player.grenades = { frag: 0, flash: 0, smoke: 0 };
    hud.setBuy(true);
    hud.hideBanner();
  } else if (name === 'cover' || name === 'fight') {
    givePlayer('vk7');
    G.phase = 'live';
    G.roundTimer = 87;
    G.wins = [3, 2];
    G.round = 6;
    const close = name === 'fight';
    player.pos.x = close ? -6 : -20;
    player.pos.z = close ? 0.5 : 23;
    const foes = G.fighters.filter((f) => f.team === TEAM.WARDENS);
    foes[0].pos.x = close ? -4.5 : -16;
    foes[0].pos.z = close ? -8.5 : -6;
    foes[1].pos.x = close ? 3 : -25;
    foes[1].pos.z = close ? -13 : -12;
    foes[0].yaw = yawToward(foes[0].pos.x, foes[0].pos.z, player.pos.x, player.pos.z);
    const mates = G.fighters.filter((f) => f.brain && f.team === TEAM.BREAKERS);
    mates[0].pos.x = close ? -10.5 : -22.5;
    mates[0].pos.z = close ? 3 : 13;
    mates[1].pos.x = close ? 5 : -16.5;
    mates[1].pos.z = close ? 7 : 15;
    player.yaw = yawToward(player.pos.x, player.pos.z, foes[0].pos.x, foes[0].pos.z);
    settle(close ? 18 : 16);
    hud.hideBanner();
    if (close) {
      // One aimed shot as the last act, so the frozen frame carries a live tracer,
      // muzzle flash and hitmarker from the game's own firing code.
      const e = foes[0].alive ? foes[0] : foes[1];
      player.yaw = yawToward(player.pos.x, player.pos.z, e.pos.x, e.pos.z);
      player.pitch = 0.02;
      const dx = e.pos.x - player.pos.x;
      const dz = e.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      tryFire(player, dx / d, 0.01, dz / d);
      drainEvents();
    }
  } else if (name === 'plant') {
    givePlayer('vk7');
    G.wins = [5, 4];
    G.round = 10;
    G.phase = 'planted';
    G.bombTimer = 31.4;
    G.bomb.state = 'planted';
    G.bomb.site = 'B';
    G.bomb.x = 29.2;
    G.bomb.z = -14.6;
    G.bomb.carrier = null;
    placeBombVisual(G.bomb.x, G.bomb.z);
    // The player body stands on its own post-plant hold point (holds.B[1]), watching
    // the pad and the planted charge, so the bot brain keeps it posed there.
    player.pos.x = 36;
    player.pos.z = -22;
    player.yaw = yawToward(36, -22, 26, -14);
    const mates = G.fighters.filter((f) => f.brain && f.team === TEAM.BREAKERS);
    mates[0].pos.x = 24.5;
    mates[0].pos.z = -19.5;
    const foes = G.fighters.filter((f) => f.team === TEAM.WARDENS);
    foes[0].pos.x = 30;
    foes[0].pos.z = -28;
    foes[1].pos.x = 24;
    foes[1].pos.z = -28;
    settle(12);
    // The bot brain engages any warden it can see and walks off the pose during the
    // settle; re-pose the body for the frozen frame (the scene state is untouched).
    player.pos.x = 36;
    player.pos.z = -22;
    player.yaw = yawToward(36, -22, 27, -14.8);
    player.pitch = -0.02;
    settle(1); // one step so the camera adopts the re-posed body
    pushEvent('planted', { site: 'B' });
    drainEvents();
  }
  finishShot();
}

function finishShot() {
  hud.update();
  renderer.render(scene, camera);
  renderer.render(scene, camera);
  frozen = true;
  window.__shotReady = true;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

if (shot) {
  G.paused = false;
  stageShot(shot);
} else if (G.demo) {
  G.paused = false;
  hud.showOverlay(null);
  startMatch();
} else {
  hud.showOverlay('start');
}
requestAnimationFrame(frame);
