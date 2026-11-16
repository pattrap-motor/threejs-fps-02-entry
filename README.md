# DOCKLINE — a three.js tactical FPS

A round-based tactical shooter in the style Counter-Strike made famous, built with
three.js and plain ES modules — no build step, no network, single-player against bots.

**Kestrel Yard**, a container port at dusk. The **Breakers** carry a breach charge to
one of two sites — the **Depot** warehouse (A) or the **Crane Pad** (B) — plant it and
hold the site for 40 seconds. The **Wardens** defend, retake and defuse. Money earned
each round buys rifles, armour and grenades in the buy phase. First to 7 rounds.

## Play

```
node serve.ts          # serves game/ on http://localhost:8080
```

Open the page, click to play. WASD moves, mouse looks, click fires, right-click aims,
`R` reloads, `1`–`5` select weapons and grenades, `E` (hold) plants the charge at a
site, `B` opens the buy menu.

## How it is put together

- `game/index.html` — the page, the HUD skeleton and its styling; one import map
  (`"three"` → the vendored three.js 0.187.0 under `game/vendor/three/`).
- `game/src/` — one module per job: `state` (the single game state), `map` (Kestrel
  Yard's geometry, colliders, navigation graph and hold points), `physics` (movement
  collision and raycasts), `weapons` (the shared firing and damage model), `bots`
  (fighter meshes and the bot brains), `player` (the human controller and viewmodel),
  `rounds` (the match director: phases, economy, plant/defuse), `fx` (tracers,
  particles, projectiles, smoke), `hud` (the 2D interface and minimap), `audio`
  (procedural WebAudio sound), `input`, `palette`, `rng`.
- The simulation runs at a fixed 60 Hz step, separate from rendering; bots perceive
  through line of sight and hearing, follow the nav graph, and play the objective.
- `main.ts` (repo root) is the hand-in program: it copies `game/` and `screenshots/`
  to the output directory and writes `dossier.json` with the kit's
  `vendor/makefun-threejs.ts`.

`?demo=1` runs an attract match with a bot driving the player's body;
`?shot=cover|buy|fight|plant|defuse&seed=N` stages the screenshot scenes listed
in `shots.json` — each one a real scene played by the game's own systems
(staged gunfights, a live plant, a Warden mid-defuse), never a painted frame.

MIT licensed (see `LICENSE`). three.js is vendored under its own license in
`game/vendor/three/`.
