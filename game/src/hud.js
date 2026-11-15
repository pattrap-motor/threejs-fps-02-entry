// The whole 2D interface: top bar (scores, timer, round), vitals, weapon readout,
// dynamic crosshair, hitmarker, killfeed, banners, the buy menu, a live minimap and
// the start/pause/match overlays. It reads the shared state G once per frame and only
// touches the DOM when a value actually changed.
import { G, TEAM } from './state.js';
import { TEAM_NAMES } from './palette.js';
import { BUY_CATALOG, playerBuy } from './rounds.js';
import { currentWeapon, spreadFor } from './weapons.js';
import { colliders } from './physics.js';

const $ = (id) => document.getElementById(id);

const WEAPON_NAMES = { p9: 'P9 Sidearm', rook: 'Rook-9', vk7: 'VK-7', longbow: 'Longbow' };

function fmtTime(s) {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export function createHud({ onPlay, onRestart }) {
  const el = {
    crosshair: $('crosshair'), hitmarker: $('hitmarker'),
    scoreB: $('score-b'), scoreW: $('score-w'), timer: $('timer'),
    roundLabel: $('round-label'), phaseLabel: $('phase-label'),
    killfeed: $('killfeed'), banner: $('banner'), bannerTitle: $('banner-title'), bannerSub: $('banner-sub'),
    objective: $('objective'), prompt: $('prompt'),
    channel: $('channel'), channelLabel: $('channel-label'), channelFill: $('channel-fill'),
    hpFill: $('hp-fill'), hpNum: $('hp-num'), armorNum: $('armor-num'), money: $('money'),
    wpnName: $('wpn-name'), wpnMag: $('wpn-mag'), wpnReserve: $('wpn-reserve'), nadeLine: $('nade-line'),
    damagevin: $('damagevin'), dmgdir: $('dmgdir'), flashwhite: $('flashwhite'), scope: $('scope'),
    buymenu: $('buymenu'), buyMoney: $('buy-money'), buyGrid: $('buy-grid'),
    overlay: $('overlay'), overlayTitle: $('overlay-title'), overlayCopy: $('overlay-copy'), overlayBtn: $('overlay-btn'),
    minimap: $('minimap'),
  };
  const mm = el.minimap.getContext('2d');
  const cache = new Map();
  const setText = (node, key, text) => {
    if (cache.get(key) !== text) {
      cache.set(key, text);
      node.textContent = text;
    }
  };

  let bannerUntil = 0;
  let hitmarkUntil = 0;
  let hurtAt = -9;
  let hurtAngle = 0;
  let flashUntil = 0;
  let flashDur = 1;
  let buyOpen = false;
  let buyRefreshAt = 0;
  let minimapAt = 0;
  const feedRows = [];

  function showBanner(title, sub, ms = 2600) {
    el.bannerTitle.textContent = title;
    el.bannerSub.textContent = sub || '';
    el.banner.classList.add('on');
    bannerUntil = G.time + ms / 1000;
  }

  // --- buy menu ---------------------------------------------------------------
  const buyCells = new Map();
  for (const item of BUY_CATALOG) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'buy-cell';
    cell.innerHTML = `<span class="buy-key">${item.key}</span><span class="buy-label">${item.label}</span><span class="buy-price">$${item.price}</span>`;
    cell.addEventListener('click', () => {
      if (playerBuy(item.id)) refreshBuy();
    });
    el.buyGrid.appendChild(cell);
    buyCells.set(item.id, cell);
  }
  function refreshBuy() {
    const p = G.player;
    el.buyMoney.textContent = `$${p.money}`;
    for (const item of BUY_CATALOG) {
      const cell = buyCells.get(item.id);
      let owned = false;
      if (item.kind === 'weapon') owned = p.weapons.primary?.def.id === item.id;
      if (item.kind === 'armor') owned = p.armor >= 100;
      if (item.kind === 'grenade') owned = p.grenades[item.id] >= (item.id === 'smoke' ? 1 : 2);
      cell.classList.toggle('cant', p.money < item.price || owned);
      cell.classList.toggle('owned', owned);
    }
  }
  function setBuy(open) {
    buyOpen = open && G.phase === 'buy' && (!G.demo || G.allowBuyMenu);
    el.buymenu.hidden = !buyOpen;
    if (buyOpen) refreshBuy();
  }
  window.addEventListener('keydown', (e) => {
    if (G.phase !== 'buy' || G.demo) return;
    if (e.code === 'KeyB') setBuy(!buyOpen);
    if (buyOpen) {
      const item = BUY_CATALOG.find((c) => c.key === e.key);
      if (item && playerBuy(item.id)) refreshBuy();
    }
  });

  // --- overlays -----------------------------------------------------------------
  function showOverlay(mode) {
    if (!mode) {
      el.overlay.hidden = true;
      return;
    }
    el.overlay.hidden = false;
    if (mode === 'start') {
      el.overlayTitle.textContent = 'DOCKLINE';
      el.overlayCopy.textContent = 'Kestrel Yard at dusk. Your Breakers carry a breach charge: plant it at the Depot or the Crane Pad and hold the site, or wipe the Wardens out. First to 7 rounds.';
      el.overlayBtn.textContent = 'Click to play';
    } else if (mode === 'paused') {
      el.overlayTitle.textContent = 'Paused';
      el.overlayCopy.textContent = 'The yard waits. Click to jump back in.';
      el.overlayBtn.textContent = 'Resume';
    } else if (mode === 'matchover') {
      const w = G.matchWinner;
      el.overlayTitle.textContent = w === TEAM.BREAKERS ? 'BREAKERS TAKE THE YARD' : w === TEAM.WARDENS ? 'WARDENS HOLD THE YARD' : 'DEAD EVEN';
      el.overlayCopy.textContent = `Final score — Breakers ${G.wins[0]} : ${G.wins[1]} Wardens. Your line: ${G.player.kills} eliminations, ${G.player.deaths} deaths.`;
      el.overlayBtn.textContent = 'Play again';
    }
  }
  el.overlayBtn.addEventListener('click', () => {
    if (G.phase === 'matchover') onRestart();
    else onPlay();
  });

  // --- events ---------------------------------------------------------------------
  function handleEvent(e) {
    const p = G.player;
    switch (e.type) {
      case 'kill': {
        const row = document.createElement('div');
        row.className = 'feed-row';
        const a = e.attacker ? e.attacker.name : 'The charge';
        const weaponName = e.part === 'head' ? '⌖ headshot'
          : e.weapon === 'frag' ? 'frag grenade'
            : e.weapon === 'charge' ? 'detonation'
              : (WEAPON_NAMES[e.weapon] || e.weapon);
        row.innerHTML = `<b class="t${e.attacker ? e.attacker.team : 0}">${a}</b> <span>${weaponName}</span> <b class="t${e.victim.team}">${e.victim.name}</b>`;
        el.killfeed.appendChild(row);
        feedRows.push({ node: row, until: G.time + 4.5 });
        while (feedRows.length > 5) {
          const old = feedRows.shift();
          old.node.remove();
        }
        if (e.victim === p) showBanner('ELIMINATED', `${a} got you — next round, back in the fight.`, 2400);
        break;
      }
      case 'hitmark':
        el.hitmarker.classList.toggle('kill', !!e.kill);
        el.hitmarker.classList.add('on');
        hitmarkUntil = G.time + (e.kill ? 0.22 : 0.1);
        break;
      case 'hurt':
        hurtAt = G.time;
        if (e.attacker) {
          hurtAngle = Math.atan2(e.attacker.pos.x - p.pos.x, -(e.attacker.pos.z - p.pos.z)) - p.yaw;
        }
        break;
      case 'flashblind':
        flashDur = Math.max(0.4, e.dur);
        flashUntil = G.time + flashDur;
        break;
      case 'roundstart':
        showBanner(`ROUND ${e.round}`, G.demo ? '' : 'Buy phase — press B', 2000);
        setBuy(true);
        break;
      case 'livestart':
        setBuy(false);
        showBanner('FIGHT', `Plant at site ${G.attackSite} — or eliminate the Wardens`, 1500);
        break;
      case 'planted':
        showBanner('CHARGE PLANTED', `Site ${e.site} — hold it for 40 seconds`, 2600);
        break;
      case 'roundend': {
        const mine = e.winner === p.team;
        showBanner(mine ? 'ROUND WON' : 'ROUND LOST', e.reason, 3400);
        break;
      }
      case 'matchover':
        showOverlay('matchover');
        break;
      default:
        break;
    }
  }

  // --- minimap ----------------------------------------------------------------------
  function drawMinimap() {
    const W = 168;
    const H = 126;
    const sx = (x) => ((x + 46) / 92) * W;
    const sz = (z) => ((z + 34) / 68) * H;
    mm.fillStyle = 'rgba(10,14,20,0.72)';
    mm.fillRect(0, 0, W, H);
    mm.fillStyle = 'rgba(160,170,185,0.5)';
    for (const c of colliders) {
      if (c.minY > 0.5 || c.maxY < 1.2) continue;
      mm.fillRect(sx(c.minX), sz(c.minZ), Math.max(1.5, sx(c.maxX) - sx(c.minX)), Math.max(1.5, sz(c.maxZ) - sz(c.minZ)));
    }
    for (const site of [{ id: 'A', x: -30, z: -16 }, { id: 'B', x: 30, z: -16 }]) {
      mm.strokeStyle = '#f5a83d';
      mm.beginPath();
      mm.arc(sx(site.x), sz(site.z), 7 * (W / 92), 0, Math.PI * 2);
      mm.stroke();
      mm.fillStyle = '#f5a83d';
      mm.font = '700 9px system-ui';
      mm.fillText(site.id, sx(site.x) - 3, sz(site.z) + 3);
    }
    if (G.bomb.state === 'planted' || G.bomb.state === 'dropped') {
      mm.fillStyle = '#ff5040';
      mm.fillRect(sx(G.bomb.x) - 2.5, sz(G.bomb.z) - 2.5, 5, 5);
    }
    for (const n of G.noises) {
      if (n.team === G.player.team || G.time - n.t > 1.6) continue;
      mm.fillStyle = 'rgba(255,90,70,0.7)';
      mm.beginPath();
      mm.arc(sx(n.x), sz(n.z), 3, 0, Math.PI * 2);
      mm.fill();
    }
    for (const f of G.fighters) {
      if (!f.alive || f === G.player) continue;
      if (f.team !== G.player.team) continue;
      mm.fillStyle = '#f5a83d';
      mm.beginPath();
      mm.arc(sx(f.pos.x), sz(f.pos.z), 2.4, 0, Math.PI * 2);
      mm.fill();
    }
    const p = G.player;
    mm.save();
    mm.translate(sx(p.pos.x), sz(p.pos.z));
    // Canvas y is world +z; the up-pointing arrow must rotate to the facing vector.
    mm.rotate(Math.atan2(-Math.sin(p.yaw), Math.cos(p.yaw)));
    mm.fillStyle = '#ffffff';
    mm.beginPath();
    mm.moveTo(0, -5);
    mm.lineTo(3.4, 4);
    mm.lineTo(-3.4, 4);
    mm.closePath();
    mm.fill();
    mm.restore();
  }

  // --- per-frame update ---------------------------------------------------------------
  function update() {
    const p = G.player;
    if (!p) return;
    setText(el.scoreB, 'sb', `${G.wins[0]}`);
    setText(el.scoreW, 'sw', `${G.wins[1]}`);
    setText(el.roundLabel, 'rl', `ROUND ${Math.max(1, G.round)} / ${G.maxRounds}`);
    let timerText = '—';
    let phaseText = '';
    el.timer.classList.remove('danger');
    if (G.phase === 'buy') { timerText = fmtTime(G.phaseT); phaseText = 'BUY'; }
    if (G.phase === 'live') { timerText = fmtTime(G.roundTimer); phaseText = 'LIVE'; }
    if (G.phase === 'planted') {
      timerText = fmtTime(G.bombTimer);
      phaseText = 'CHARGE PLANTED';
      if (G.bombTimer < 10) el.timer.classList.add('danger');
    }
    if (G.phase === 'end') { timerText = '—'; phaseText = G.winner === 0 ? 'BREAKERS' : 'WARDENS'; }
    setText(el.timer, 'tm', timerText);
    setText(el.phaseLabel, 'pl', phaseText);

    el.hpFill.style.width = `${Math.max(0, p.hp)}%`;
    el.hpFill.classList.toggle('low', p.hp <= 30);
    setText(el.hpNum, 'hp', `${Math.ceil(Math.max(0, p.hp))}`);
    setText(el.armorNum, 'ar', p.armor > 0 ? `ARMOR ${Math.ceil(p.armor)}` : '');
    setText(el.money, 'mo', `$${p.money}`);

    const w = currentWeapon(p);
    if (w) {
      setText(el.wpnName, 'wn', w.def.name + (G.time < p.reloadUntil ? ' — RELOADING' : ''));
      setText(el.wpnMag, 'wm', `${w.mag}`);
      setText(el.wpnReserve, 'wr', `/ ${w.reserve}`);
    } else {
      setText(el.wpnName, 'wn', p.slot === 'frag' ? 'Frag Grenade' : p.slot === 'flash' ? 'Flash Grenade' : 'Smoke Grenade');
      setText(el.wpnMag, 'wm', `${p.grenades[p.slot]}`);
      setText(el.wpnReserve, 'wr', '— click to throw');
    }
    setText(el.nadeLine, 'nl', `FRAG ${p.grenades.frag} · FLASH ${p.grenades.flash} · SMOKE ${p.grenades.smoke}${G.bomb.carrier === p ? ' · ◆ CHARGE' : ''}`);

    // Crosshair: the gap is the live spread, in pixels; hidden while scoped or down.
    const scoped = w && w.def.id === 'longbow' && p.ads > 0.65;
    el.scope.style.opacity = scoped ? '1' : '0';
    if (w && p.alive && !scoped) {
      el.crosshair.style.opacity = '1';
      const gap = Math.max(5, Math.min(30, spreadFor(p, w.def) * 1250));
      el.crosshair.style.setProperty('--gap', `${gap.toFixed(1)}px`);
    } else {
      el.crosshair.style.opacity = '0';
    }
    if (G.time > hitmarkUntil) el.hitmarker.classList.remove('on');
    if (G.time > bannerUntil) el.banner.classList.remove('on');

    // Damage feedback: a fading red vignette plus a direction tick.
    const hurtAge = G.time - hurtAt;
    el.damagevin.style.opacity = hurtAge < 0.7 ? `${0.55 * (1 - hurtAge / 0.7)}` : '0';
    el.dmgdir.style.opacity = hurtAge < 1.1 ? `${0.9 * (1 - hurtAge / 1.1)}` : '0';
    el.dmgdir.style.transform = `translate(-50%,-50%) rotate(${(-hurtAngle * 180) / Math.PI}deg)`;
    const flashLeft = flashUntil - G.time;
    el.flashwhite.style.opacity = flashLeft > 0 ? `${Math.min(0.96, (flashLeft / flashDur) * 1.4)}` : '0';

    // Plant / defuse channel bar.
    let channelText = null;
    let channelFrac = 0;
    if (G.bomb.channel > 0.05 && G.bomb.channelBy?.team === p.team) {
      channelText = G.bomb.channelBy === p ? 'PLANTING THE CHARGE…' : `${G.bomb.channelBy.name} is planting…`;
      channelFrac = G.bomb.channel / 3;
    } else if (G.bomb.defuse > 0.05) {
      channelText = 'THE CHARGE IS BEING DEFUSED!';
      channelFrac = G.bomb.defuse / 5;
    }
    el.channel.style.opacity = channelText ? '1' : '0';
    if (channelText) {
      setText(el.channelLabel, 'cl', channelText);
      el.channelFill.style.width = `${Math.min(100, channelFrac * 100)}%`;
    }

    // Objective and contextual prompt lines.
    let objective = '';
    let prompt = '';
    if (!p.alive && (G.phase === 'live' || G.phase === 'planted')) {
      objective = 'You are down — your team fights on. Next round you are back.';
    } else if (G.phase === 'buy') {
      objective = `Round ${G.round}: the charge goes to site ${G.attackSite}.`;
      prompt = 'B — buy menu';
    } else if (G.phase === 'live') {
      if (G.bomb.carrier === p) {
        objective = 'You carry the charge — plant it at the Depot (A) or the Crane Pad (B).';
        const inSite = [-30, 30].some((x) => Math.hypot(p.pos.x - x, p.pos.z + 16) < 7);
        prompt = inSite ? 'Hold E — plant the charge' : '';
      } else if (G.bomb.state === 'dropped') {
        objective = 'The charge is down — recover it!';
      } else if (G.bomb.carrier) {
        objective = `${G.bomb.carrier.name} carries the charge to site ${G.attackSite} — cover them.`;
      }
    } else if (G.phase === 'planted') {
      objective = `Defend the charge at site ${G.bomb.site} — ${Math.ceil(G.bombTimer)}s to detonation.`;
    }
    setText(el.objective, 'ob', objective);
    setText(el.prompt, 'pr', prompt);

    if (buyOpen && G.time > buyRefreshAt) {
      buyRefreshAt = G.time + 0.25;
      refreshBuy();
    }
    if (G.time > minimapAt) {
      minimapAt = G.time + 0.12;
      drawMinimap();
    }
    for (let i = feedRows.length - 1; i >= 0; i -= 1) {
      if (G.time > feedRows[i].until) {
        feedRows[i].node.remove();
        feedRows.splice(i, 1);
      }
    }
  }

  function hideBanner() {
    bannerUntil = 0;
    el.banner.classList.remove('on');
  }

  return { update, handleEvent, showOverlay, showBanner, setBuy, hideBanner };
}
