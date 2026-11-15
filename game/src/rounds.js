// The match director: owns the round state machine (buy → live → planted → end),
// the economy, team plans, and the breach charge's plant and defuse channels.
// Fighters, weapons and bots live elsewhere; this module only conducts.
import { G, TEAM, aliveCount, pushEvent } from './state.js';
import { createFighter, BOT_NAMES } from './bots.js';
import { WEAPONS, GRENADES, ARMOR_PRICE, newWeapon, applyDamage } from './weapons.js';
import * as fx from './fx.js';
import { dist2d } from './map.js';

let MAP = null;
let beepAt = 0;

export const BUY_CATALOG = [
  { id: 'vk7', kind: 'weapon', label: 'VK-7 Carbine', price: WEAPONS.vk7.price, key: '1' },
  { id: 'rook', kind: 'weapon', label: 'Rook-9 SMG', price: WEAPONS.rook.price, key: '2' },
  { id: 'longbow', kind: 'weapon', label: 'Longbow .338', price: WEAPONS.longbow.price, key: '3' },
  { id: 'armor', kind: 'armor', label: 'Kevlar Vest', price: ARMOR_PRICE, key: '4' },
  { id: 'frag', kind: 'grenade', label: 'Frag Grenade', price: GRENADES.frag.price, key: '5' },
  { id: 'flash', kind: 'grenade', label: 'Flash Grenade', price: GRENADES.flash.price, key: '6' },
  { id: 'smoke', kind: 'grenade', label: 'Smoke Grenade', price: GRENADES.smoke.price, key: '7' },
];

export function initMatch(scene, map) {
  MAP = map;
  const player = createFighter(scene, TEAM.BREAKERS, true, 'You', map.spawns[0][1]);
  G.player = player;
  G.fighters.push(player);
  BOT_NAMES[0].forEach((name, i) => {
    G.fighters.push(createFighter(scene, TEAM.BREAKERS, false, name, map.spawns[0][i === 0 ? 0 : i + 1]));
  });
  BOT_NAMES[1].forEach((name, i) => {
    G.fighters.push(createFighter(scene, TEAM.WARDENS, false, name, map.spawns[1][i]));
  });
  return player;
}

function resetFighter(f, spawn) {
  f.alive = true;
  f.hp = 100;
  f.armor = 0;
  f.pos.x = spawn.x;
  f.pos.y = 0;
  f.pos.z = spawn.z;
  f.vel.x = 0;
  f.vel.y = 0;
  f.vel.z = 0;
  f.yaw = f.team === TEAM.BREAKERS ? 0 : Math.PI;
  f.pitch = 0;
  f.crouch = 0;
  f.crouchTarget = 0;
  f.reloadUntil = 0;
  f.nextShotAt = 0;
  f.kick = 0;
  f.ads = 0;
  f.blindedUntil = 0;
  if (!f.weapons.primary) f.slot = 'sidearm';
  if (f.brain) {
    f.brain.path = [];
    f.brain.visible = null;
    f.brain.lastKnown = null;
    f.brain.usedFlash = false;
    f.brain.state = 'move';
  }
}

export function startMatch() {
  G.wins = [0, 0];
  G.round = 0;
  G.matchWinner = -1;
  G.over = false;
  for (const f of G.fighters) {
    f.money = 800;
    f.kills = 0;
    f.deaths = 0;
    f.weapons = { primary: null, sidearm: newWeapon('p9') };
    f.grenades = { frag: 0, flash: 0, smoke: 0 };
    f.slot = 'sidearm';
  }
  startRound();
}

function assignPlans() {
  const site = G.attackSite;
  const other = site === 'A' ? 'B' : 'A';
  const breakers = G.fighters.filter((f) => f.team === TEAM.BREAKERS && f.brain);
  breakers.forEach((f, i) => {
    f.brain.role = 'push';
    f.brain.site = i < 3 ? site : other;
    f.brain.hold = null;
  });
  const wardens = G.fighters.filter((f) => f.team === TEAM.WARDENS && f.brain);
  const holdsA = MAP.holds.A;
  const holdsB = MAP.holds.B;
  const plan = [
    { hold: holdsA[0] }, { hold: holdsA[1] }, { hold: holdsB[0] }, { hold: holdsB[1] },
    { hold: MAP.holds.MID[0] },
  ];
  wardens.forEach((f, i) => {
    f.brain.role = 'hold';
    f.brain.hold = plan[i % plan.length].hold;
    f.brain.site = i < 2 ? 'A' : 'B';
  });
}

function autoBuy(f) {
  const spend = (price) => {
    if (f.money < price) return false;
    f.money -= price;
    return true;
  };
  if (!f.weapons.primary) {
    if (f.money >= WEAPONS.vk7.price && spend(WEAPONS.vk7.price)) f.weapons.primary = newWeapon('vk7');
    else if (f.money >= WEAPONS.rook.price && spend(WEAPONS.rook.price)) f.weapons.primary = newWeapon('rook');
  }
  if (f.weapons.primary && f.slot === 'sidearm') f.slot = 'primary';
  if (f.armor === 0 && f.weapons.primary && spend(ARMOR_PRICE)) f.armor = 100;
  if (f.grenades.frag === 0 && G.rng.chance(0.7) && spend(GRENADES.frag.price)) f.grenades.frag = 1;
  if (f.grenades.flash === 0 && G.rng.chance(0.5) && spend(GRENADES.flash.price)) f.grenades.flash = 1;
  if (f.grenades.smoke === 0 && G.rng.chance(0.3) && spend(GRENADES.smoke.price)) f.grenades.smoke = 1;
}

export function startRound() {
  G.round += 1;
  G.winner = -1;
  G.winReason = '';
  G.attackSite = G.rng.chance(0.55) ? 'A' : 'B';
  const byTeam = [[], []];
  for (const f of G.fighters) byTeam[f.team].push(f);
  byTeam[0].forEach((f, i) => resetFighter(f, MAP.spawns[0][i % MAP.spawns[0].length]));
  byTeam[1].forEach((f, i) => resetFighter(f, MAP.spawns[1][i % MAP.spawns[1].length]));
  assignPlans();
  for (const f of G.fighters) if (f.brain) autoBuy(f);
  // The charge starts on the player's back, or on a pushing bot's in demo mode.
  const carrier = G.demo
    ? G.fighters.find((f) => f.team === TEAM.BREAKERS && f.brain && f.brain.site === G.attackSite) || G.player
    : G.player;
  G.bomb.state = 'carried';
  G.bomb.carrier = carrier;
  G.bomb.site = null;
  G.bomb.channel = 0;
  G.bomb.defuse = 0;
  fx.removeBombVisual();
  G.phase = 'buy';
  G.phaseT = G.demo ? 2.5 : 12;
  pushEvent('roundstart', { round: G.round });
}

export function playerBuy(id) {
  if (G.phase !== 'buy' || !G.player.alive) return false;
  const item = BUY_CATALOG.find((c) => c.id === id);
  if (!item) return false;
  const p = G.player;
  if (p.money < item.price) return false;
  if (item.kind === 'weapon') {
    p.weapons.primary = newWeapon(id);
    p.slot = 'primary';
  } else if (item.kind === 'armor') {
    if (p.armor >= 100) return false;
    p.armor = 100;
  } else {
    const cap = id === 'smoke' ? 1 : 2;
    if (p.grenades[id] >= cap) return false;
    p.grenades[id] += 1;
  }
  p.money -= item.price;
  pushEvent('sound', { name: 'buy', x: p.pos.x, z: p.pos.z });
  return true;
}

function endRound(winner, reason) {
  G.wins[winner] += 1;
  G.winner = winner;
  G.winReason = reason;
  for (const f of G.fighters) {
    f.money = Math.min(9000, f.money + (f.team === winner ? 1400 : 900));
  }
  if (G.bomb.state === 'planted') fx.removeBombVisual();
  G.bomb.state = 'gone';
  G.bomb.carrier = null;
  G.phase = 'end';
  G.phaseT = 4.5;
  pushEvent('roundend', { winner, reason });
}

function plantAt(site, planter) {
  G.bomb.state = 'planted';
  G.bomb.site = site.id;
  G.bomb.x = planter.pos.x;
  G.bomb.z = planter.pos.z;
  G.bomb.carrier = null;
  G.bomb.channel = 0;
  G.bomb.defuse = 0;
  planter.money = Math.min(9000, planter.money + 300);
  G.phase = 'planted';
  G.bombTimer = 40;
  beepAt = 0;
  fx.placeBombVisual(G.bomb.x, G.bomb.z);
  pushEvent('planted', { site: site.id });
}

export function handleEvent(e) {
  if (e.type === 'kill' && e.attacker && e.attacker.team !== e.victim.team) {
    e.attacker.money = Math.min(9000, e.attacker.money + 150);
  }
}

export function updateRounds(dt) {
  if (G.phase === 'buy') {
    G.phaseT -= dt;
    if (G.phaseT <= 0) {
      G.phase = 'live';
      G.roundTimer = 100;
      pushEvent('livestart', {});
    }
    return;
  }
  if (G.phase === 'end') {
    G.phaseT -= dt;
    if (G.phaseT <= 0) {
      if (G.wins[0] >= G.winsNeeded || G.wins[1] >= G.winsNeeded || G.round >= G.maxRounds) {
        G.phase = 'matchover';
        G.matchWinner = G.wins[0] === G.wins[1] ? -1 : (G.wins[0] > G.wins[1] ? 0 : 1);
        G.over = true;
        pushEvent('matchover', { winner: G.matchWinner });
      } else {
        startRound();
      }
    }
    return;
  }
  if (G.phase === 'live') {
    G.roundTimer -= dt;
    if (G.roundTimer <= 0) {
      endRound(TEAM.WARDENS, 'Time expired — the charge was never planted');
      return;
    }
    // Plant channel: the carrier stands in a site and works uninterrupted.
    const carrier = G.bomb.carrier;
    if (G.bomb.state === 'carried' && carrier && carrier.alive) {
      const site = MAP.sites.find((s) => dist2d(carrier.pos.x, carrier.pos.z, s.x, s.z) < s.r);
      const working = site && (carrier.isPlayer && !G.demo ? G.interactHeld : carrier.brain?.state === 'plant');
      if (working) {
        G.bomb.channel += dt;
        G.bomb.channelBy = carrier;
        if (G.bomb.channel >= 3) {
          plantAt(site, carrier);
          return;
        }
      } else {
        G.bomb.channel = Math.max(0, G.bomb.channel - dt * 2);
      }
    }
    // A dropped charge is picked up by any Breaker who reaches it.
    if (G.bomb.state === 'dropped') {
      for (const f of G.fighters) {
        if (f.team === TEAM.BREAKERS && f.alive && dist2d(f.pos.x, f.pos.z, G.bomb.x, G.bomb.z) < 1.3) {
          G.bomb.state = 'carried';
          G.bomb.carrier = f;
          pushEvent('pickedup', { by: f });
          break;
        }
      }
    }
    if (aliveCount(TEAM.BREAKERS) === 0) endRound(TEAM.WARDENS, 'Breakers eliminated');
    else if (aliveCount(TEAM.WARDENS) === 0) endRound(TEAM.BREAKERS, 'Wardens eliminated');
    return;
  }
  if (G.phase === 'planted') {
    G.bombTimer -= dt;
    const interval = G.bombTimer < 10 ? 0.5 : 1;
    if (G.time >= beepAt) {
      beepAt = G.time + interval;
      pushEvent('sound', { name: 'beep', x: G.bomb.x, z: G.bomb.z, final: G.bombTimer < 1.2 });
    }
    if (G.bombTimer <= 0) {
      fx.detonate(G.bomb.x, G.bomb.z);
      for (const f of G.fighters) {
        if (!f.alive) continue;
        const d = dist2d(f.pos.x, f.pos.z, G.bomb.x, G.bomb.z);
        if (d < 11) applyDamage(f, 340 * (1 - d / 12), null, 'body', 'charge');
      }
      endRound(TEAM.BREAKERS, 'The charge detonated');
      return;
    }
    // Defuse channel: a Warden at the charge, uninterrupted.
    let defuser = null;
    for (const f of G.fighters) {
      if (f.team === TEAM.WARDENS && f.alive && dist2d(f.pos.x, f.pos.z, G.bomb.x, G.bomb.z) < 1.7) {
        if (f.brain?.state === 'defuse') defuser = f;
      }
    }
    if (defuser) {
      G.bomb.defuse += dt;
      G.bomb.defuseBy = defuser;
      if (G.bomb.defuse >= 5) {
        endRound(TEAM.WARDENS, 'The charge was defused');
        return;
      }
    } else {
      G.bomb.defuse = Math.max(0, G.bomb.defuse - dt * 2);
    }
    if (aliveCount(TEAM.WARDENS) === 0) endRound(TEAM.BREAKERS, 'Wardens eliminated');
  }
}
