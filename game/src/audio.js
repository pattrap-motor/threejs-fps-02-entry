// Procedural sound effects on WebAudio — no audio files, so the game stays fully offline.
// Every call is guarded: before the first user gesture the context is suspended and the
// game simply plays silently.
let ctx = null;
let master = null;
let noiseBuffer = null;
let unlocked = false;

// Browsers refuse an AudioContext before a user gesture; until one arrives the
// game stays silent instead of logging autoplay warnings.
window.addEventListener('pointerdown', () => { unlocked = true; ensure(); });
window.addEventListener('keydown', () => { unlocked = true; });

function ensure() {
  if (!unlocked && !ctx) return false;
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx.state === 'running';
  }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    const length = Math.floor(ctx.sampleRate * 0.5);
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return true;
  } catch {
    return false;
  }
}

function noiseBurst({ at = 0, dur = 0.12, freq = 1800, q = 0.7, gain = 0.5, type = 'lowpass' }) {
  if (!ensure()) return;
  const t0 = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

function tone({ at = 0, dur = 0.1, freq = 880, endFreq = null, gain = 0.2, type = 'square' }) {
  if (!ensure()) return;
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

// Volume falls with the distance between the sound and the player.
function vol(dist, base) {
  return Math.max(0, Math.min(1, base * (14 / (14 + dist))));
}

export const sfx = {
  shot(kind, dist) {
    const v = vol(dist, 0.9);
    if (v <= 0.01) return;
    if (kind === 'longbow') {
      noiseBurst({ dur: 0.32, freq: 900, gain: v });
      tone({ dur: 0.18, freq: 140, endFreq: 55, gain: v * 0.5, type: 'triangle' });
    } else if (kind === 'p9') {
      noiseBurst({ dur: 0.09, freq: 2600, gain: v * 0.6 });
    } else {
      noiseBurst({ dur: 0.16, freq: 1700, gain: v * 0.8 });
      tone({ dur: 0.07, freq: 220, endFreq: 90, gain: v * 0.25, type: 'triangle' });
    }
  },
  dryFire() { tone({ dur: 0.04, freq: 1400, gain: 0.12 }); },
  reload() {
    tone({ dur: 0.05, freq: 500, gain: 0.15, type: 'triangle' });
    tone({ at: 0.16, dur: 0.05, freq: 320, gain: 0.18, type: 'triangle' });
    tone({ at: 0.34, dur: 0.06, freq: 700, gain: 0.2, type: 'triangle' });
  },
  hit(kill) {
    tone({ dur: 0.06, freq: kill ? 1560 : 1180, gain: 0.22, type: 'sine' });
    if (kill) tone({ at: 0.07, dur: 0.09, freq: 1960, gain: 0.2, type: 'sine' });
  },
  hurt() { noiseBurst({ dur: 0.1, freq: 500, gain: 0.3 }); },
  throwIt() { noiseBurst({ dur: 0.14, freq: 900, type: 'bandpass', gain: 0.12 }); },
  explosion(big) {
    noiseBurst({ dur: big ? 1.4 : 0.6, freq: big ? 300 : 500, gain: 0.95 });
    tone({ dur: big ? 1.0 : 0.4, freq: 90, endFreq: 34, gain: 0.6, type: 'sine' });
  },
  flash() { tone({ dur: 0.5, freq: 3400, endFreq: 2600, gain: 0.16, type: 'sine' }); },
  beep(final) { tone({ dur: final ? 0.4 : 0.09, freq: final ? 1560 : 1040, gain: 0.2, type: 'sine' }); },
  plant() { tone({ dur: 0.08, freq: 740, gain: 0.2 }); tone({ at: 0.12, dur: 0.08, freq: 990, gain: 0.2 }); },
  buy() { tone({ dur: 0.06, freq: 1320, gain: 0.15, type: 'sine' }); },
  denied() { tone({ dur: 0.09, freq: 220, gain: 0.18, type: 'sawtooth' }); },
  roundEnd(won) {
    tone({ dur: 0.14, freq: won ? 660 : 330, gain: 0.2, type: 'triangle' });
    tone({ at: 0.15, dur: 0.22, freq: won ? 990 : 262, gain: 0.2, type: 'triangle' });
  },
};
