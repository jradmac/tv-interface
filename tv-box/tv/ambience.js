// Ambient sound for the Rain, Snow and Jungle themes, synthesised with Web Audio (no files, works offline).
// It fades in with the theme, follows the TV sounds switch, and stops completely while a service
// is opening or the page is hidden, so it costs nothing during video.
// Each soundscape is a few looping buffers built once (so the loop has no seam) through a handful
// of native filter nodes, plus sparse one-off events (bird calls, thunder) scheduled a few seconds ahead.
window.TVAmbience = (() => {
  const LEVEL = { rain: 0.45, snow: 0.6, jungle: 0.85 };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const cache = {};

  // ---------- Buffers ----------
  // Stereo noise: 'pink' is even across octaves (rain, wind), 'brown' is deep (thunder).
  function noise(c, secs, kind) {
    const key = kind + secs + '@' + c.sampleRate;
    if (cache[key]) return cache[key];
    const n = Math.floor(secs * c.sampleRate), buf = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, br = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'brown') { br = (br + 0.02 * w) / 1.02; d[i] = br * 3.5; } else {
          b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
          d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
        }
      }
    }
    return (cache[key] = buf);
  }
  // Rain is thousands of separate drops. This buffer is the audible ones: tiny ticks on hard surfaces,
  // and fewer, rounder plops into puddles. Events wrap around the end, so it loops without a seam.
  function drips(c) {
    const key = 'drips@' + c.sampleRate;
    if (cache[key]) return cache[key];
    const sr = c.sampleRate, secs = 9, n = secs * sr, buf = c.createBuffer(2, n, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const add = (at, len, pan, fn) => {
      const gl = Math.cos(pan * Math.PI / 2), gr = Math.sin(pan * Math.PI / 2);
      for (let i = 0; i < len; i++) { const v = fn(i / sr), j = (at + i) % n; L[j] += v * gl; R[j] += v * gr; }
    };
    for (let k = 0; k < secs * 150; k++) {                    // ticks
      const f = 1800 * Math.pow(4.2, Math.random()), tau = rnd(0.0015, 0.007), amp = Math.pow(Math.random(), 2.4) * 0.24, w = 2 * Math.PI * f, ph = Math.random() * 6.283;
      add(Math.floor(Math.random() * n), Math.floor(tau * 6 * sr), Math.random(), (x) => Math.sin(w * x + ph) * Math.exp(-x / tau) * amp);
    }
    for (let k = 0; k < secs * 7; k++) {                      // plops: a quick upward chirp, like a drop into water
      const f = rnd(450, 1300), tau = rnd(0.012, 0.03), amp = Math.pow(Math.random(), 1.6) * 0.17, rise = rnd(8, 22);
      add(Math.floor(Math.random() * n), Math.floor(tau * 5 * sr), Math.random(), (x) => Math.sin(2 * Math.PI * f * x * (1 + rise * x)) * Math.exp(-x / tau) * amp * Math.min(1, x * 900));
    }
    return (cache[key] = buf);
  }
  // The insect chorus of a rainforest: several crickets, each with its own pitch and chirp rhythm,
  // under a cicada shimmer that swells and fades once per loop.
  function chorus(c) {
    const key = 'chorus@' + c.sampleRate;
    if (cache[key]) return cache[key];
    const sr = c.sampleRate, secs = 14, n = secs * sr, buf = c.createBuffer(2, n, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    for (let v = 0; v < 7; v++) {                              // crickets
      const f = rnd(3600, 5400), w = 2 * Math.PI * f / sr, pulses = 2 + Math.floor(Math.random() * 3), rate = rnd(26, 42), every = rnd(0.42, 1.1), amp = rnd(0.012, 0.035), pan = Math.random();
      const gl = Math.cos(pan * Math.PI / 2), gr = Math.sin(pan * Math.PI / 2), plen = Math.floor(sr / rate * 0.62);
      for (let at = Math.random() * every; at < secs - 0.3; at += every * rnd(0.92, 1.1)) {
        for (let p = 0; p < pulses; p++) {
          const s0 = Math.floor((at + p / rate) * sr);
          for (let i = 0; i < plen; i++) { const e = Math.sin(Math.PI * i / plen), x = Math.sin(w * (s0 + i)) * e * e * amp, j = (s0 + i) % n; L[j] += x * gl; R[j] += x * gr; }
        }
      }
    }
    const tones = Array.from({ length: 5 }, () => ({ w: 2 * Math.PI * rnd(5600, 6900) / sr, am: 2 * Math.PI * rnd(70, 110) / sr, pan: Math.random() }));
    for (let i = 0; i < n; i++) {                              // cicadas: a buzzing shimmer, mostly on one side at a time
      const u = i / n, swell = Math.pow(Math.sin(Math.PI * u), 2) * 0.6 + Math.pow(Math.sin(Math.PI * ((u + 0.45) % 1)), 6) * 0.4;
      if (swell < 0.01) continue;
      let l = 0, r = 0;
      for (const t of tones) { const x = Math.sin(t.w * i) * (0.5 + 0.5 * Math.sin(t.am * i)); l += x * (1 - t.pan); r += x * t.pan; }
      L[i] += l * swell * 0.0075; R[i] += r * swell * 0.0075;
    }
    return (cache[key] = buf);
  }

  // ---------- Small helpers ----------
  function loop(c, buf, at, rate = 1) { const s = c.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(at, Math.random() * buf.duration * 0.9); return s; }
  function filt(c, type, f, q = 0.7, gain = 0) { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gain; return b; }
  function amp(c, v) { const g = c.createGain(); g.gain.value = v; return g; }
  function lfo(c, hz, depth, param, at) { const o = c.createOscillator(), g = amp(c, depth); o.frequency.value = hz; o.connect(g).connect(param); o.start(at); return o; }
  function pan(c, p) { const n = c.createStereoPanner ? c.createStereoPanner() : amp(c, 1); if (n.pan) n.pan.value = p; return n; }

  // ---------- Rain ----------
  // Steady rain: a broad wash (the far rain), a duller body (rain on the roof), a bright hiss (rain on
  // leaves and glass), and the close drips on top. A very slow swell stands in for gusts.
  function rain(c, out, at) {
    const src = [];
    const wash = loop(c, noise(c, 7, 'pink'), at), washG = amp(c, 0.55);
    wash.connect(filt(c, 'highpass', 350)).connect(filt(c, 'lowpass', 7500)).connect(washG).connect(out);
    const body = loop(c, noise(c, 7, 'pink'), at, 0.7), bodyG = amp(c, 0.3);
    body.connect(filt(c, 'lowpass', 520)).connect(filt(c, 'highpass', 90)).connect(bodyG).connect(out);
    const hiss = loop(c, noise(c, 7, 'pink'), at, 1.6), hissG = amp(c, 0.2);
    hiss.connect(filt(c, 'bandpass', 5200, 0.6)).connect(hissG).connect(out);
    const near = loop(c, drips(c), at), nearG = amp(c, 0.9);
    near.connect(filt(c, 'highpass', 300)).connect(nearG).connect(out);
    src.push(wash, body, hiss, near,
      lfo(c, 0.045, 0.1, washG.gain, at), lfo(c, 0.071, 0.07, hissG.gain, at), lfo(c, 0.03, 0.06, bodyG.gain, at), lfo(c, 0.057, 0.2, nearG.gain, at));
    return { src, events() {} };
  }
  // Distant thunder: deep noise that swells quickly, rumbles unevenly and rolls away over several seconds.
  function thunder(c, out, at) {
    const s = c.createBufferSource(); s.buffer = noise(c, 6, 'brown'); s.loop = true;
    const lp = filt(c, 'lowpass', 220, 0.5), g = amp(c, 0), dur = rnd(6, 9), peak = rnd(0.5, 0.9);
    lp.frequency.setValueAtTime(260, at); lp.frequency.exponentialRampToValueAtTime(70, at + dur);
    const curve = new Float32Array(48);
    for (let i = 0; i < curve.length; i++) {
      const u = i / (curve.length - 1), env = Math.min(1, u * 14) * Math.pow(1 - u, 1.7);
      curve[i] = i === 0 ? 0 : peak * env * (0.55 + 0.45 * Math.random());
    }
    curve[curve.length - 1] = 0;
    g.gain.setValueCurveAtTime(curve, at, dur);
    s.connect(lp).connect(pan(c, rnd(-0.5, 0.5))).connect(g).connect(out);
    s.start(at, Math.random() * 4); s.stop(at + dur + 0.1);
  }

  // ---------- Snow ----------
  // Snowfall is nearly silent, so this is the hush around it: a low wind that rises and settles, a thin
  // whistle when it gusts, the faintest hiss of falling snow, and now and then a wind chime far away.
  function snow(c, out, at) {
    const src = [];
    const low = loop(c, noise(c, 7, 'pink'), at, 0.6), lowF = filt(c, 'bandpass', 380, 0.8), lowG = amp(c, 0.5);
    low.connect(lowF).connect(lowG).connect(out);
    const gust = loop(c, noise(c, 7, 'pink'), at, 0.9), gustF = filt(c, 'bandpass', 850, 9), gustG = amp(c, 0.05);
    gust.connect(gustF).connect(pan(c, 0.3)).connect(gustG).connect(out);
    const hiss = loop(c, noise(c, 7, 'pink'), at, 1.5), hissG = amp(c, 0.03);
    hiss.connect(filt(c, 'highpass', 5000)).connect(hissG).connect(out);
    src.push(low, gust, hiss,
      lfo(c, 0.06, 0.24, lowG.gain, at), lfo(c, 0.043, 150, lowF.frequency, at), lfo(c, 0.027, 0.12, lowG.gain, at),
      lfo(c, 0.09, 260, gustF.frequency, at), lfo(c, 0.13, 0.04, gustG.gain, at));
    const NOTES = [1046.5, 1174.7, 1318.5, 1568, 1760, 2093];
    let next = at + rnd(6, 14);
    return {
      src,
      events(until) {
        while (next < until) {
          const n = 1 + Math.floor(Math.random() * 3), p = pan(c, rnd(-0.7, 0.7));
          p.connect(out);
          for (let i = 0; i < n; i++) {
            const f = pick(NOTES), t0 = next + i * rnd(0.18, 0.6), peak = rnd(0.012, 0.03);
            for (const [mul, lv, tau] of [[1, 1, 0.9], [2.76, 0.3, 0.35]]) {   // a bell: a pure tone and one bright partial that dies quickly
              const o = c.createOscillator(), g = amp(c, 0);
              o.frequency.value = f * mul;
              g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak * lv, t0 + 0.006); g.gain.setTargetAtTime(0, t0 + 0.006, tau);
              o.connect(g).connect(p); o.start(t0); o.stop(t0 + tau * 7);
            }
          }
          next += rnd(9, 26);
        }
      },
    };
  }

  // ---------- Jungle ----------
  // One note of a call: an oscillator with a pitch glide and a soft envelope. `am` adds a fast flutter.
  function note(c, dest, { at, dur, f0, f1 = f0, peak, type = 'sine', am = 0, attack = 0.012 }) {
    const o = c.createOscillator(), g = amp(c, 0);
    o.type = type; o.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, at + dur);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(peak, at + Math.min(attack, dur * 0.4));
    g.gain.setValueAtTime(peak, at + dur * 0.55); g.gain.linearRampToValueAtTime(0, at + dur);
    o.connect(g);
    if (am) { const m = c.createOscillator(), mg = amp(c, 0.5), d = amp(c, 0.5); m.frequency.value = am; m.connect(mg).connect(d.gain); g.connect(d).connect(dest); m.start(at); m.stop(at + dur + 0.02); } else g.connect(dest);
    o.start(at); o.stop(at + dur + 0.02);
  }
  // The cast. Each returns how long its call lasts. Pitches and timing vary every time so nothing repeats exactly.
  const CALLS = [
    // A songbird: a short phrase of clear whistled notes.
    (c, d, at) => {
      const base = rnd(2100, 3400), n = 2 + Math.floor(Math.random() * 4), shape = pick([[1, 1.22], [1.2, 0.95], [1, 1], [0.9, 1.3]]);
      let x = at;
      for (let i = 0; i < n; i++) { const dur = rnd(0.09, 0.22), f = base * pick([1, 1, 1.12, 0.89, 1.26]); note(c, d, { at: x, dur, f0: f * shape[0], f1: f * shape[1], peak: 0.05 }); note(c, d, { at: x, dur, f0: f * shape[0] * 2, f1: f * shape[1] * 2, peak: 0.008 }); x += dur + rnd(0.05, 0.16); }
      return x - at;
    },
    // A fast trill that climbs or falls.
    (c, d, at) => {
      const f = rnd(3000, 4600), n = 8 + Math.floor(Math.random() * 12), step = pick([1.02, 0.98, 1]), gap = rnd(0.05, 0.075);
      for (let i = 0; i < n; i++) note(c, d, { at: at + i * gap, dur: gap * 0.75, f0: f * Math.pow(step, i) * 1.08, f1: f * Math.pow(step, i) * 0.94, peak: 0.032 * Math.min(1, (i + 1) / 3), attack: 0.005 });
      return n * gap;
    },
    // A dove deep in the trees: slow, hollow hoots.
    (c, d, at) => {
      const f = rnd(400, 560), n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) note(c, d, { at: at + i * 0.52, dur: i === n - 1 ? 0.5 : 0.3, f0: f * 1.05, f1: f * 0.94, peak: 0.07, attack: 0.06 });
      return n * 0.52;
    },
    // The liquid "bloop" of an oropendola: a fast upward swoop.
    (c, d, at) => {
      const n = 1 + Math.floor(Math.random() * 2), f = rnd(520, 760);
      for (let i = 0; i < n; i++) { note(c, d, { at: at + i * 0.42, dur: 0.16, f0: f, f1: f * rnd(3.2, 4.4), peak: 0.06, attack: 0.02 }); note(c, d, { at: at + i * 0.42 + 0.17, dur: 0.07, f0: f * 2.6, f1: f * 1.9, peak: 0.025 }); }
      return n * 0.42;
    },
    // A tree frog: short buzzy pulses.
    (c, d, at) => {
      const f = rnd(1100, 1700), n = 3 + Math.floor(Math.random() * 5), gap = rnd(0.2, 0.3);
      for (let i = 0; i < n; i++) note(c, d, { at: at + i * gap, dur: 0.09, f0: f, f1: f * 1.06, peak: 0.04, type: 'triangle', am: rnd(55, 85), attack: 0.008 });
      return n * gap;
    },
    // A parrot far off: two or three raspy squawks.
    (c, d, at) => {
      const f = rnd(1500, 2100), n = 2 + Math.floor(Math.random() * 2), bp = filt(c, 'bandpass', f * 1.6, 2.5);
      bp.connect(d);
      for (let i = 0; i < n; i++) note(c, bp, { at: at + i * 0.3, dur: 0.2, f0: f * 1.1, f1: f * 0.8, peak: 0.035, type: 'sawtooth', am: rnd(38, 60), attack: 0.02 });
      return n * 0.3;
    },
    // A two-note cuckoo-like call, repeated.
    (c, d, at) => {
      const f = rnd(900, 1300), n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) { note(c, d, { at: at + i * 0.9, dur: 0.2, f0: f * 1.25, f1: f * 1.22, peak: 0.05, attack: 0.03 }); note(c, d, { at: at + i * 0.9 + 0.26, dur: 0.3, f0: f, f1: f * 0.97, peak: 0.05, attack: 0.03 }); }
      return n * 0.9;
    },
  ];
  const ODDS = [5, 3, 2, 3, 3, 1, 2];                           // songbirds most, parrots rarely
  function jungle(c, out, at) {
    const src = [];
    const ins = loop(c, chorus(c), at);
    ins.connect(amp(c, 1.5)).connect(out);
    // Air moving through the canopy, and leaves rustling when it picks up.
    const air = loop(c, noise(c, 7, 'pink'), at, 0.8), airG = amp(c, 0.085);
    air.connect(filt(c, 'bandpass', 600, 0.4)).connect(airG).connect(out);
    const rus = loop(c, noise(c, 7, 'pink'), at, 1.3), rusG = amp(c, 0.035);
    rus.connect(filt(c, 'highpass', 2800)).connect(rusG).connect(out);
    // A stream somewhere below: a soft, bubbling band of sound.
    const stream = loop(c, drips(c), at, 0.55), stG = amp(c, 0.07);
    stream.connect(filt(c, 'bandpass', 1100, 0.7)).connect(pan(c, -0.55)).connect(stG).connect(out);
    src.push(ins, air, rus, stream, lfo(c, 0.05, 0.04, airG.gain, at), lfo(c, 0.083, 0.03, rusG.gain, at));
    // Calls go through one shared echo so they sit back among the trees.
    const bus = amp(c, 1.9), dly = c.createDelay(0.5), fb = amp(c, 0.3), wet = amp(c, 0.4);
    dly.delayTime.value = 0.19;
    bus.connect(out); bus.connect(dly); dly.connect(filt(c, 'lowpass', 2600)).connect(fb).connect(dly); dly.connect(wet).connect(out);
    const total = ODDS.reduce((a, b) => a + b, 0);
    let next = at + 1.5;
    return {
      src,
      // Schedule every call that starts before `until`.
      events(until) {
        while (next < until) {
          let r = Math.random() * total, i = 0;
          while ((r -= ODDS[i]) > 0) i++;
          const far = Math.random(), v = amp(c, 0.35 + (1 - far) * 0.65), lp = filt(c, 'lowpass', 2500 + (1 - far) * 6000);   // distance: quieter and duller
          v.connect(lp).connect(pan(c, rnd(-0.9, 0.9))).connect(bus);
          const len = CALLS[i](c, v, next);
          next += len * 0.5 + (Math.random() < 0.3 ? rnd(0.2, 0.9) : rnd(0.8, 3.2));   // sometimes two birds overlap or answer
        }
      },
    };
  }
  const BUILD = { rain, snow, jungle };

  // ---------- Running it ----------
  let live = null;   // { k, c, g, scape, timer }
  function stop() {
    if (!live) return;
    const { c, g, scape, timer } = live; live = null;
    clearInterval(timer);
    const now = c.currentTime;
    g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(0, now + 0.5);
    setTimeout(() => { scape.src.forEach((s) => { try { s.stop(); } catch (e) {} }); g.disconnect(); }, 650);
  }
  function start(k) {
    const c = window.TVSound && window.TVSound.audio();
    if (!c) return;
    const g = amp(c, 0), at = c.currentTime + 0.05;
    g.connect(c.destination);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(LEVEL[k], at + 2.5);
    const scape = BUILD[k](c, g, at);
    scape.events(at + 8);
    const timer = setInterval(() => { if (live && live.c.state === 'running') scape.events(c.currentTime + 8); }, 4000);
    live = { k, c, g, scape, timer };
  }
  // Called whenever the theme, the sounds switch, busy or visibility changes.
  function sync() {
    const T = window.TVTheme, S = window.TVSound;
    const want = T && S && S.on && !T.busy && !document.hidden && BUILD[T.current] ? T.current : null;
    if ((live && live.k) === want) return;
    stop();
    if (want) start(want);
  }
  function rumble(delay = 1.5) { if (live && live.k === 'rain') thunder(live.c, live.g, live.c.currentTime + delay); }
  // Renders a soundscape to a buffer without playing it (used by the tests and to make previews).
  async function render(k, secs = 20) {
    const c = new OfflineAudioContext(2, secs * 48000, 48000), g = amp(c, LEVEL[k]);
    g.connect(c.destination);
    const scape = BUILD[k](c, g, 0);
    scape.events(secs);
    if (k === 'rain') thunder(c, g, secs * 0.45);
    return c.startRendering();
  }

  document.addEventListener('visibilitychange', sync);
  addEventListener('load', sync);
  return { sync, thunder: rumble, render, get playing() { return live ? live.k : null; } };
})();
