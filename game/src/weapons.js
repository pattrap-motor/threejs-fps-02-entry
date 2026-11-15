// Weapon data and the shared firing model. The player and every bot shoot through the
// same code: a hitscan ray tested against bodies (head hits multiply damage), spread
// that grows with movement and shrinks when crouched or aiming, damage falloff with
// distance, and armour that soaks a share of every hit.
import { G, pushEvent } from './state.js';
import { rayHit, eyeHeight } from './physics.js';
import * as fx from './fx.js';

export const WEAPONS = {
  p9: {
    id: 'p9', name: 'P9 Sidearm', price: 0, damage: 26, headMult: 4, rpm: 340, auto: false,
    mag: 12, reserve: 96, reload: 1.5, spread: 0.011, kick: 0.011, zoom: 1.25,
  },
  rook: {
    id: 'rook', name: 'Rook-9 SMG', price: 1050, damage: 22, headMult: 4, rpm: 820, auto: true,
    mag: 32, reserve: 128, reload: 2.1, spread: 0.02, kick: 0.008, zoom: 1.3,
  },
  vk7: {
    id: 'vk7', name: 'VK-7 Carbine', price: 2700, damage: 34, headMult: 4, rpm: 600, auto: true,
    mag: 30, reserve: 120, reload: 2.3, spread: 0.013, kick: 0.013, zoom: 1.4,
  },
  longbow: {
    id: 'longbow', name: 'Longbow .338', price: 4300, damage: 96, headMult: 2.5, rpm: 44, auto: false,
    mag: 5, reserve: 30, reload: 3.1, spread: 0.002, kick: 0.05, zoom: 3.2,
  },
};

export const GRENADES = {
  frag: { id: 'frag', name: 'Frag Grenade', price: 300 },
  flash: { id: 'flash', name: 'Flash Grenade', price: 200 },
  smoke: { id: 'smoke', name: 'Smoke Grenade', price: 300 },
};

export const ARMOR_PRICE = 650;

export function newWeapon(id) {
  const def = WEAPONS[id];
  return { def, mag: def.mag, reserve: def.reserve };
}

// A fighter's current weapon instance, or null when a grenade slot is selected.
export function currentWeapon(f) {
  if (f.slot === 'primary') return f.weapons.primary;
  if (f.slot === 'sidearm') return f.weapons.sidearm;
  return null;
}

export function falloff(dist) {
  if (dist < 20) return 1;
  if (dist > 55) return 0.65;
  return 1 - ((dist - 20) / 35) * 0.35;
}

// Spread in radians for this fighter right now: the heart of "accuracy counts more
// than speed" — moving, standing and airborne all bloom the cone; crouching and
// aiming down sights tighten it.
export function spreadFor(f, def) {
  let s = def.spread;
  const speed = Math.hypot(f.vel.x, f.vel.z);
  s += speed * 0.0062;
  if (!f.onGround) s += 0.045;
  if (f.crouch > 0.5) s *= 0.62;
  if (f.ads > 0.5) s *= 0.45;
  return s;
}

export function applyDamage(victim, amount, attacker, part, weaponId) {
  if (!victim.alive || amount <= 0) return false;
  let dmg = amount;
  if (victim.armor > 0) {
    const soaked = Math.min(victim.armor, dmg * 0.45);
    victim.armor -= soaked;
    dmg -= soaked;
  }
  victim.hp -= dmg;
  victim.lastAttacker = attacker;
  victim.lastHurtAt = G.time;
  if (victim.isPlayer) pushEvent('hurt', { attacker });
  if (victim.hp > 0) return false;
  victim.hp = 0;
  victim.alive = false;
  victim.deathAt = G.time;
  if (attacker) attacker.kills += 1;
  victim.deaths += 1;
  pushEvent('kill', {
    attacker, victim, part, weapon: weaponId ?? attacker?.lastWeaponId ?? 'frag',
  });
  if (G.bomb.carrier === victim) {
    G.bomb.carrier = null;
    G.bomb.state = 'dropped';
    G.bomb.x = victim.pos.x;
    G.bomb.z = victim.pos.z;
    pushEvent('bombdropped', { x: victim.pos.x, z: victim.pos.z });
  }
  return true;
}

// Fire the fighter's current weapon along (dx, dy, dz) from the eye. Bots pass an aim
// direction with their own error already folded in; the spread model applies to both.
export function tryFire(f, dx, dy, dz) {
  const w = currentWeapon(f);
  if (!w || !f.alive) return false;
  if (G.phase !== 'live' && G.phase !== 'planted') return false;
  if (G.time < f.nextShotAt || G.time < f.reloadUntil) return false;
  const def = w.def;
  if (w.mag <= 0) {
    f.nextShotAt = G.time + 0.32;
    if (f.isPlayer) pushEvent('sound', { name: 'dryFire', x: f.pos.x, z: f.pos.z });
    startReload(f);
    return false;
  }
  w.mag -= 1;
  f.nextShotAt = G.time + 60 / def.rpm;
  f.lastWeaponId = def.id;
  f.kick += def.kick;
  f.shotsFired += 1;

  const spread = spreadFor(f, def);
  const rx = dx + (G.rng.next() * 2 - 1) * spread;
  const ry = dy + (G.rng.next() * 2 - 1) * spread;
  const rz = dz + (G.rng.next() * 2 - 1) * spread;
  const len = Math.hypot(rx, ry, rz) || 1;
  const ox = f.pos.x;
  const oy = f.pos.y + eyeHeight(f) - 0.08;
  const oz = f.pos.z;
  const hit = rayHit(ox, oy, oz, rx / len, ry / len, rz / len, 140, f);
  // Muzzle sits a little ahead of the eye, toward the shot.
  fx.muzzle(ox + (rx / len) * 0.5, oy - 0.06, oz + (rz / len) * 0.5);
  fx.spawnTracer(ox + (rx / len) * 0.6, oy - 0.08, oz + (rz / len) * 0.6, hit.x, hit.y, hit.z);
  fx.spawnImpact(hit.x, hit.y, hit.z, hit.fighter ? 'flesh' : 'world', hit.fighter ? 9 : 6);
  pushEvent('sound', { name: 'shot', weapon: def.id, x: f.pos.x, z: f.pos.z, shooter: f });
  G.noises.push({ x: f.pos.x, z: f.pos.z, team: f.team, t: G.time });
  if (G.noises.length > 40) G.noises.shift();

  if (hit.fighter && hit.fighter.team !== f.team) {
    const dmg = def.damage * (hit.part === 'head' ? def.headMult : 1) * falloff(hit.dist);
    const killed = applyDamage(hit.fighter, dmg, f, hit.part, def.id);
    if (f.isPlayer) pushEvent('hitmark', { kill: killed, head: hit.part === 'head' });
  }
  return true;
}

export function startReload(f) {
  const w = currentWeapon(f);
  if (!w) return;
  if (w.mag >= w.def.mag || w.reserve <= 0 || G.time < f.reloadUntil) return;
  f.reloadUntil = G.time + w.def.reload;
  if (f.isPlayer) pushEvent('sound', { name: 'reload', x: f.pos.x, z: f.pos.z });
}

// Per-step upkeep for one fighter: finish reloads, take queued grenade damage.
export function updateFighterWeapons(f) {
  const w = currentWeapon(f);
  if (w && f.reloadUntil > 0 && G.time >= f.reloadUntil) {
    const take = Math.min(w.def.mag - w.mag, w.reserve);
    w.mag += take;
    w.reserve -= take;
    f.reloadUntil = 0;
  }
}

export function drainBlasts() {
  while (fx.pendingBlasts.length) {
    const b = fx.pendingBlasts.pop();
    if (b.victim.alive && b.attacker !== b.victim) {
      const killed = applyDamage(b.victim, b.dmg, b.attacker, 'body', 'frag');
      if (b.attacker?.isPlayer) pushEvent('hitmark', { kill: killed, head: false });
    }
  }
}

// Throw the grenade in the selected slot, if any remain. Returns to the primary after.
export function throwSelected(f, dx, dy, dz) {
  const type = f.slot;
  if (!(type in GRENADES)) return false;
  if (f.grenades[type] <= 0 || G.time < f.nextThrowAt) return false;
  if (G.phase !== 'live' && G.phase !== 'planted') return false;
  f.grenades[type] -= 1;
  f.nextThrowAt = G.time + 0.7;
  const oy = f.pos.y + eyeHeight(f) - 0.05;
  fx.throwGrenade(f, type, f.pos.x, oy, f.pos.z, dx, dy, dz);
  f.slot = f.weapons.primary ? 'primary' : 'sidearm';
  return true;
}
