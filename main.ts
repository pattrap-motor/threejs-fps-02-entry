// DOCKLINE — entry program for the make.fun threejs-fps-02 bounty (Node 22, standard library only).
//
// The game itself is the game/ folder beside this file: plain static ES modules, no build step,
// three.js 0.187.0 vendored under game/vendor/three/ and reached through one import map. This
// program hands the entry in: it copies game/ and screenshots/ into the output directory and
// writes dossier.json there with buildDossier from the kit's vendor/makefun-threejs.ts, exactly
// the bytes the gate rebuilds and compares. In the grader the output directory is /output;
// anywhere else MAKEFUN_OUTPUT_DIR names it:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Play the game locally with `node serve.ts`, then open http://localhost:8080.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
}

// The caps below are the gate's own (reference/gate.json): text_max_bytes shapes the dossier's
// source text; the rest refuse up front an entry the gate would refuse anyway — at most 4
// screenshots of at most 256 KiB, at most 993 files and 48 MiB under game/.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
  }),
);
