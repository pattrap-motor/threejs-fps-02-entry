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
import { eyeHeight, bodyHeight } from './physics.js';
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
renderer.toneMappingExposure = 1.3;
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
  sites: map.sites,
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
      case 'throwIt': if (d < 18) sfx.throwIt(); break;
      case 'buy': sfx.buy(); break;
      case 'denied': sfx.denied(); break;
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
// Put a primary in a fighter's hands (the staged scenes arm their actors alike).
function armFighter(f, id) {
  f.weapons.primary = newWeapon(id);
  f.slot = 'primary';
}

function givePlayer(id) {
  armFighter(player, id);
  player.money = 4150;
  player.armor = 100;
}

// Pose a fighter on a mark, standing still and facing a point.
function pinFighter(f, x, z, faceX, faceZ) {
  f.pos.x = x;
  f.pos.z = z;
  f.vel.x = 0;
  f.vel.z = 0;
  f.yaw = yawToward(x, z, faceX, faceZ);
  f.pitch = 0;
}

// Direction from a shooter's eye to a point at frac of the victim's body height —
// the geometry tryFire fires along, so a staged shot lands where it is aimed.
function aimAt(shooter, victim, frac) {
  const sy = shooter.pos.y + eyeHeight(shooter) - 0.08;
  const ty = victim.pos.y + bodyHeight(victim) * frac;
  return { x: victim.pos.x - shooter.pos.x, y: ty - sy, z: victim.pos.z - shooter.pos.z };
}

// Fire a short burst from one fighter into another through the game's own firing
// code, re-aiming at the victim's chest before every shot, until the victim is
// down, is at or under stopHp, or the burst runs out. Steps pass between shots,
// so the burst honours the weapon's rate of fire and the victims' brains keep
// moving and fighting back while it lands.
function burst(shooter, victim, stopHp, maxShots = 6) {
  for (let i = 0; i < maxShots; i += 1) {
    if (!shooter.alive || !victim.alive || victim.hp <= stopHp) return;
    const d = aimAt(shooter, victim, 0.62);
    tryFire(shooter, d.x, d.y, d.z);
    settle(7);
  }
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
  } else if (name === 'cover') {
    givePlayer('vk7');
    G.phase = 'live';
    G.roundTimer = 87;
    G.wins = [3, 2];
    G.round = 6;
    player.pos.x = -20;
    player.pos.z = 23;
    const foes = G.fighters.filter((f) => f.team === TEAM.WARDENS);
    foes[0].pos.x = -16;
    foes[0].pos.z = -6;
    foes[1].pos.x = -25;
    foes[1].pos.z = -12;
    foes[0].yaw = yawToward(foes[0].pos.x, foes[0].pos.z, player.pos.x, player.pos.z);
    const mates = G.fighters.filter((f) => f.brain && f.team === TEAM.BREAKERS);
    mates[0].pos.x = -22.5;
    mates[0].pos.z = 13;
    mates[1].pos.x = -16.5;
    mates[1].pos.z = 15;
    player.yaw = yawToward(player.pos.x, player.pos.z, foes[0].pos.x, foes[0].pos.z);
    settle(16);
    hud.hideBanner();
  } else if (name === 'fight') {
    givePlayer('vk7');
    G.phase = 'live';
    G.roundTimer = 87;
    G.wins = [3, 2];
    G.round = 6;
    const foes = G.fighters.filter((f) => f.team === TEAM.WARDENS);
    const mates = G.fighters.filter((f) => f.brain && f.team === TEAM.BREAKERS && !f.isPlayer);
    // A close-range exchange in the mid corridor. The actors are posed on marks
    // around the player, but everything that happens next is fought by the game's
    // own firing and damage code: two bursts trade kills into the killfeed, a
    // third leaves the Warden in the player's sights one shot from down, and the
    // player's answering burst is the last act, so the frozen frame carries the
    // populated killfeed, the kill hitmarker, the impact burst and the falling
    // body — the muzzle flash itself is allowed to burn off first (see below),
    // because at this range its light blows out the middle of the frame.
    for (const f of [mates[0], mates[1], foes[0], foes[1], foes[2]]) armFighter(f, 'vk7');
    pinFighter(foes[1], -9.3, -7.6, -8.6, -3.4);
    pinFighter(mates[0], -8.6, -3.4, -9.3, -7.6);
    pinFighter(mates[1], -2.6, -6.8, -1.8, -11.2);
    pinFighter(foes[2], -1.8, -11.2, -2.6, -6.8);
    pinFighter(foes[0], -4.9, -8.2, -4.6, -3);
    pinFighter(player, -4.6, -3, -4.9, -8.2);
    settle(10);
    burst(mates[0], foes[1], 0);
    burst(foes[2], mates[1], 0);
    burst(mates[0], foes[0], 34);
    hud.hideBanner();
    // The exchange is spent: for the last beat every other fighter is caught
    // mid-reload (empty magazines — their brains take the hint and hold fire),
    // so the only muzzle flash in the frozen frame is the player's own.
    for (const f of G.fighters) {
      if (f !== player && f.alive && f.weapons.primary) f.weapons.primary.mag = 0;
    }
    let target = [foes[0], foes[2], foes[1], foes[3], foes[4]].find((f) => f.alive);
    if (target) {
      pinFighter(target, -4.9, -8.2, player.pos.x, player.pos.z);
      pinFighter(player, -4.6, -3, target.pos.x, target.pos.z);
      player.pitch = 0.01;
      settle(2);
      if (!target.alive) {
        // The player's own brain finished the target during the settle; put the
        // next standing Warden on the mark instead and fire without stepping,
        // so the camera — already facing the mark — keeps the frame.
        target = foes.find((f) => f.alive);
        if (target) pinFighter(target, -4.9, -8.2, player.pos.x, player.pos.z);
      }
      for (let i = 0; i < 4 && target && target.alive; i += 1) {
        player.yaw = yawToward(player.pos.x, player.pos.z, target.pos.x, target.pos.z);
        const d = aimAt(player, target, 0.62);
        tryFire(player, d.x, d.y, d.z);
        drainEvents();
        if (target.alive && i < 3) settle(7);
      }
      // Let the muzzle flash (0.045 s) burn off before the freeze, so the frame
      // stays readable: the player holds fire (nextShotAt pushed out — its brain
      // cannot spoil the pause with a fresh flash) and the body is then re-posed
      // on its mark for the one step that lets the camera adopt the pose again.
      // The kill hitmarker (0.22 s) and the impact burst outlast the pause.
      player.nextShotAt = G.time + 0.5;
      settle(3);
      pinFighter(player, -4.6, -3, target.pos.x, target.pos.z);
      player.pitch = 0.01;
      settle(1);
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
