// The single game state. Every module reads and writes through G; nothing keeps a private
// copy of match facts, so the HUD, the bots and the round director never disagree.
export const TEAM = { BREAKERS: 0, WARDENS: 1 };

export const G = {
  time: 0,               // simulation seconds since boot (fixed-step clock)
  phase: 'menu',         // menu | buy | live | planted | end | matchover
  phaseT: 0,             // seconds left in the buy and end phases
  round: 0,
  maxRounds: 13,
  winsNeeded: 7,
  wins: [0, 0],
  roundTimer: 0,
  bombTimer: 0,
  winner: -1,            // team that won the current round
  winReason: '',
  matchWinner: -1,
  fighters: [],          // all ten fighters, player first
  player: null,
  // The breach charge: carried by a Breaker, dropped where its carrier fell, or planted.
  bomb: { state: 'carried', carrier: null, x: 0, z: 0, site: null, channel: 0, channelBy: null, defuse: 0, defuseBy: null },
  smokes: [],            // { x, z, r, until } — active smoke clouds block sight lines
  noises: [],            // { x, z, team, t } — gunfire and footsteps the bots can hear
  events: [],            // one-frame events for the HUD and audio: kill, shot, hit, plant, ...
  attackSite: 'A',       // the Breakers' plan for this round
  interactHeld: false,   // the player is holding the interact key (plant channel)
  shakeAmp: 0,           // camera shake amplitude from nearby explosions, decays in main
  allowBuyMenu: false,   // set only by the staged buy screenshot
  shotMode: false,       // a staged screenshot scene is being captured
  paused: true,
  demo: false,           // demo mode: a bot brain drives the player's body (screenshots, attract)
  over: false,
};

export function pushEvent(type, data) {
  G.events.push({ type, ...data });
}

export function aliveCount(team) {
  let n = 0;
  for (const f of G.fighters) if (f.team === team && f.alive) n += 1;
  return n;
}
