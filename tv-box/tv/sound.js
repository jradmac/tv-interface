// Soft UI sounds for the TV, synthesised with Web Audio (no files).
// Quiet by design: a short glassy tick per card, a gentle rise when opening, an airy glide for the Apps grid.
// The box remembers on/off ({t:'sounds', on}); we also cache it locally so the first sound is right.
window.TVSound = (() => {
  let on = true;
  try { on = localStorage.getItem('tv-sounds') !== '0'; } catch (e) {}
  let ctx = null, out = null, lastTick = 0, streak = 0, quietUntil = 0;
  const MASTER = 0.5;   // everything below is already soft; this is the overall ceiling

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      // A gentle compressor and a high cut keep it smooth on TV speakers.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
      out = ctx.createGain(); out.gain.value = MASTER;
      out.connect(lp).connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  const ok = () => on && performance.now() >= quietUntil && ac();

  // One enveloped oscillator: freq can glide from f0 to f1.
  function tone({ type = 'sine', f0, f1 = f0, t = 0, dur, peak, attack = 0.004, q = 0, dest = out }) {
    const c = ctx, now = c.currentTime + t;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, now);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, now + dur);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    if (q) { const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f0; bp.Q.value = q; o.connect(bp).connect(g); } else o.connect(g);
    g.connect(dest);
    o.start(now); o.stop(now + dur + 0.02);
  }
  // A breath of filtered noise, for "air" on the grid and open sounds.
  let noiseBuf = null;
  function air({ t = 0, dur, peak, from, to }) {
    const c = ctx, now = c.currentTime + t;
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate * 1, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = c.createBufferSource(); src.buffer = noiseBuf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(from, now); bp.frequency.exponentialRampToValueAtTime(to, now + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(now); src.stop(now + dur + 0.02);
  }

  // Card tick. Fast swipes get quieter and slightly higher instead of louder; tiny random pitch keeps it from sounding mechanical.
  function tick(dir = 1, soft = 1) {
    if (!ok()) return;
    const now = performance.now(), gap = now - lastTick;
    if (gap < 45) return;                                   // never more than ~20 a second
    streak = gap < 160 ? Math.min(streak + 1, 6) : 0;
    lastTick = now;
    const jitter = 1 + (Math.random() - 0.5) * 0.04;
    const base = (dir > 0 ? 1760 : 1568) * jitter * (1 + streak * 0.02);
    const vol = 0.07 * soft * (1 - streak * 0.1);
    tone({ type: 'sine', f0: base, f1: base * 0.82, dur: 0.05, peak: vol });
    tone({ type: 'triangle', f0: base * 2.01, dur: 0.025, peak: vol * 0.25 });   // a glassy edge
  }
  // Opening an app: a soft two-note rise with a little air. Then silence for the takeover.
  function open() {
    if (!ok()) return;
    tone({ type: 'sine', f0: 523, f1: 784, dur: 0.22, peak: 0.07, attack: 0.01 });
    tone({ type: 'sine', f0: 1046, f1: 1568, t: 0.07, dur: 0.26, peak: 0.045, attack: 0.012 });
    air({ dur: 0.35, peak: 0.02, from: 900, to: 4200 });
    quietUntil = performance.now() + 1500;
  }
  // Apps grid: zooming out glides down and opens up; closing glides back up and settles.
  function gridIn() {
    if (!ok()) return;
    tone({ type: 'sine', f0: 880, f1: 440, dur: 0.32, peak: 0.055, attack: 0.008 });
    tone({ type: 'triangle', f0: 1320, f1: 660, t: 0.03, dur: 0.28, peak: 0.018 });
    air({ dur: 0.42, peak: 0.018, from: 3000, to: 700 });
  }
  function gridOut() {
    if (!ok()) return;
    tone({ type: 'sine', f0: 440, f1: 880, dur: 0.26, peak: 0.05, attack: 0.008 });
    air({ dur: 0.32, peak: 0.014, from: 700, to: 2600 });
  }
  // A theme change or other confirmation: one clean, low chime.
  function confirm() {
    if (!ok()) return;
    tone({ type: 'sine', f0: 659, dur: 0.18, peak: 0.05 });
    tone({ type: 'sine', f0: 988, t: 0.06, dur: 0.22, peak: 0.035 });
  }
  function setOn(v) {
    const was = on;
    on = !!v;
    try { localStorage.setItem('tv-sounds', on ? '1' : '0'); } catch (e) {}
    if (on) { ac(); if (!was) confirm(); }
    if (window.TVAmbience) window.TVAmbience.sync();
  }
  // Warm the audio graph up early so the first tick isn't late.
  addEventListener('load', () => { if (on) ac(); });
  return { tick, open, gridIn, gridOut, confirm, setOn, audio: ac, get on() { return on; } };
})();
