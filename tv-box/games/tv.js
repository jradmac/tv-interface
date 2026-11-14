// The TV side of a DS game: the top screen full screen, the game's sound, and a Bluetooth
// controller if one is paired to the box. The phone holds the bottom screen.
(() => {
  const q = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const top = $('top'), bot = $('bot'), glow = $('glow');
  const tctx = top.getContext('2d', { alpha: false }), bctx = bot.getContext('2d', { alpha: false }), gctx = glow.getContext('2d');
  const timg = tctx.createImageData(256, 192), bimg = bctx.createImageData(256, 192);
  const t32 = new Uint32Array(timg.data.buffer), b32 = new Uint32Array(bimg.data.buffer);
  // RGB565 -> RGBA, one lookup per pixel.
  const LUT = new Uint32Array(65536);
  for (let c = 0; c < 65536; c++) {
    const r = ((c >> 11) << 3) | (c >> 13), g = (((c >> 5) & 63) << 2) | ((c >> 9) & 3), b = ((c & 31) << 3) | ((c >> 2) & 7);
    LUT[c] = 0xFF000000 | (b << 16) | (g << 8) | r;
  }
  function blit(buf, out, ctx, img) {
    const px = new Uint16Array(buf, 4, 256 * 192);
    for (let i = 0; i < px.length; i++) out[i] = LUT[px[i]];
    ctx.putImageData(img, 0, 0);
  }

  // The start/closed card: faded out, then taken out of the page so nothing is left over the game.
  let helloTimer = 0;
  function hello(on) {
    const h = $('hello');
    clearTimeout(helloTimer);
    if (on) { h.classList.remove('gone'); requestAnimationFrame(() => h.classList.remove('off')); }
    else { h.classList.add('off'); helloTimer = setTimeout(() => h.classList.add('gone'), 700); }
  }

  // Fit / Fill / Stretch (chosen on the phone, remembered per game by the box).
  const VIEW_NAMES = { fit: 'Fit', fill: 'Fill screen', stretch: 'Stretch' };
  let view = 'fit';
  function setView(mode) {
    if (!VIEW_NAMES[mode]) return;
    const changed = mode !== view;
    view = mode;
    document.body.classList.remove('v-fit', 'v-fill', 'v-stretch');
    document.body.classList.add('v-' + mode);
    if (changed && started) say(VIEW_NAMES[mode], 1400);
  }

  let note = 0;
  function say(text, ms = 2600) {
    $('note').textContent = text; $('note').classList.add('on');
    clearTimeout(note); note = setTimeout(() => $('note').classList.remove('on'), ms);
  }

  // ---- Sound: a small ring buffer in an AudioWorklet ------------------------------------
  let ac = null, node = null, rate = 44100;
  const WORKLET = `
    class Ring extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(1 << 15); this.r = 0; this.w = 0; this.n = 0; this.started = false;
        this.port.onmessage = (e) => { const d = e.data, b = this.buf, L = b.length;
          for (let i = 0; i < d.length; i++) { b[this.w] = d[i]; this.w = (this.w + 1) % L; }
          this.n = Math.min(L, this.n + d.length);
          const max = sampleRate * 2 * 0.16;            // more than 160 ms queued: drop the oldest (keeps sound in sync)
          if (this.n > max) { const drop = this.n - sampleRate * 2 * 0.07; this.r = (this.r + drop) % L; this.n -= drop; }
        }; }
      process(_, outs) { const o = outs[0], L = this.buf.length, frames = o[0].length;
        if (!this.started) { if (this.n < sampleRate * 2 * 0.05) return true; this.started = true; }
        for (let i = 0; i < frames; i++) {
          if (this.n >= 2) { o[0][i] = this.buf[this.r]; o[1][i] = this.buf[(this.r + 1) % L]; this.r = (this.r + 2) % L; this.n -= 2; }
          else { o[0][i] = 0; o[1][i] = 0; this.started = false; }
        }
        return true; }
    }
    registerProcessor('ring', Ring);`;
  async function audio(sr) {
    if (ac && rate === sr) return;
    rate = sr;
    try {
      if (ac) ac.close();
      ac = new AudioContext({ sampleRate: sr, latencyHint: 'interactive' });
      await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
      node = new AudioWorkletNode(ac, 'ring', { outputChannelCount: [2] });
      node.connect(ac.destination);
      ac.resume();
    } catch (e) { console.log('audio off', e); node = null; }
  }
  function playPcm(buf) {
    if (!node) return;
    const s = new Int16Array(buf, 4), f = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
    node.port.postMessage(f, [f.buffer]);
  }

  // ---- Link to the box ---------------------------------------------------------------
  let ws = null, frames = 0, pads = 0, started = false;
  function connect() {
    const p = new URLSearchParams({ role: 'tv', tv: q.get('tv') || '', k: q.get('k') || '', g: q.get('g') || '' });
    ws = new WebSocket(`ws://${location.host}/games/ws?${p}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        const type = new Uint8Array(e.data, 0, 1)[0];
        if (type === 1) {
          blit(e.data, t32, tctx, timg);
          if (!started) { started = true; hello(false); }
          if (++frames % 30 === 0 && view === 'fit') { gctx.filter = 'blur(4px) saturate(1.2)'; gctx.drawImage(top, -4, -4, 72, 56); }
        } else if (type === 2) playPcm(e.data);
        else if (type === 4) blit(e.data, b32, bctx, bimg);
        return;
      }
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'game.ready') { $('title').textContent = m.title || 'Your game'; audio(m.rate || 44100); }
      else if (m.t === 'game.pads') { pads = m.n; showBottom(); if (m.n && started) say('Phone connected'); }
      else if (m.t === 'game.toast') say(m.text);
      else if (m.t === 'game.paused') document.body.classList.toggle('paused', !!m.on);
      else if (m.t === 'game.missing') { $('title').textContent = "This game isn't on the box"; $('sub').textContent = 'Press Home on your phone'; }
      else if (m.t === 'game.view') setView(m.mode);
      else if (m.t === 'game.over') { hello(true); $('title').textContent = 'Game closed'; $('sub').textContent = 'Press Home on your phone'; started = false; }
    };
    ws.onclose = () => setTimeout(connect, 1000);
  }
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

  // ---- Bluetooth / USB controller (Gamepad API) ---------------------------------------
  // Standard mapping: 0 A(south) 1 B(east) 2 X(west) 3 Y(north) 4 LB 5 RB 8 Back 9 Start 12-15 D-pad.
  // The DS's A is on the right and B at the bottom, like a Nintendo pad: south = B, east = A.
  const BIT = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11 };
  const MAP = [[0, 'b'], [1, 'a'], [2, 'y'], [3, 'x'], [4, 'l'], [5, 'r'], [6, 'l'], [7, 'r'], [8, 'select'], [9, 'start'],
    [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];
  let lastMask = -1, padSeen = false;
  function showBottom() {
    const on = padSeen && pads === 0;
    document.body.classList.toggle('showbot', on);
    send({ t: 'bottom', on });
  }
  function pollPads() {
    let mask = 0, any = false;
    for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) {
      if (!gp) continue;
      any = true;
      for (const [i, k] of MAP) if (gp.buttons[i] && gp.buttons[i].pressed) mask |= 1 << BIT[k];
      const [x = 0, y = 0] = gp.axes;
      if (x < -0.5) mask |= 1 << BIT.left; if (x > 0.5) mask |= 1 << BIT.right;
      if (y < -0.5) mask |= 1 << BIT.up; if (y > 0.5) mask |= 1 << BIT.down;
    }
    if (any !== padSeen) { padSeen = any; showBottom(); if (any) say('Controller connected'); }
    if (mask !== lastMask) { lastMask = mask; send({ t: 'pad', mask }); }
    requestAnimationFrame(pollPads);
  }

  // The TV has no pointer while playing.
  addEventListener('contextmenu', (e) => e.preventDefault());
  connect();
  requestAnimationFrame(pollPads);
})();
