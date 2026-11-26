// One racer's Nintendo DS, running on the host phone in its own thread (up to 4 at once).
// The consoles of a race are linked to each other with MessagePorts (no Wi-Fi in between), so the
// wireless timing the game expects holds. The host page feeds this console its player's buttons and
// passes its pictures and sound on: to the screen of this phone, or (as JPEGs) through the box to the
// player's own phone.
//
// From the page:  {t:'init', seat, name, rom, sav, cheats, rate, remote}   {t:'port', seat, port}
//                 {t:'input', keys, steer, touch:[x,y]|null}   {t:'map', on}   {t:'stop'}
// To the page:    {t:'ready'} {t:'frame', top, bot} (this phone's own player) {t:'jpeg', which, buf}
//                 {t:'audio', pcm} {t:'save', buf} {t:'stats', fps, ms, waits} {t:'error', msg}
/* global importScripts, DSWeb, createMP */
importScripts('mp.js', 'dsweb.js');

const KEY = { a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9, x: 10, y: 11 };
let m = null, mp = null, seat = 0, remote = false, running = false;
let script = null;   // tests only: [[startFrame, keys, holdFrames], ...] pressed by this console by itself
let keys = 0, steer = 0, steerAcc = 0, touch = null, mapOn = false, mapMode = 'top';   // 'top': a big screen shows this player's race
let lite = false;   // data saver for a player on mobile data: 30 pictures a second, smaller ones
const peers = new Map();        // seat -> MessagePort
let mpMask = 0;                 // which consoles have their wireless on
const W = 256, H = 192, PX = W * H * 4;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

function setPeer(s, port) {
  peers.set(s, port);
  port.onmessage = (e) => {
    const d = e.data;
    if (d.pkt) mp && mp.onPacket(d.pkt);
    else if (d.on != null) { mpMask = d.on ? mpMask | (1 << d.from) : mpMask & ~(1 << d.from); mp && mp.setRoster({ connected: mpMask }); }
  };
  // Tell the new console whether this one is already linked.
  if (mpMask & (1 << seat)) port.postMessage({ from: seat, on: true });
}

async function init(o) {
  seat = o.seat; remote = !!o.remote; lite = !!o.lite; script = o.script || null;
  const opts = { print: () => {}, printErr: () => {} };
  // The page compiles the emulator once and hands every console the compiled copy.
  if (o.wasm) opts.instantiateWasm = (imports, done) => { WebAssembly.instantiate(o.wasm, imports).then((inst) => done(inst)); return {}; };
  m = await DSWeb(opts);
  mp = createMP({
    send: (buf) => {
      const to = new DataView(buf).getUint32(0, true);
      for (const [s, port] of peers) if (to === 0xFFFFFFFF || to === s) port.postMessage({ pkt: buf.slice(0) });
    },
    control: (msg) => {
      mpMask = msg.on ? mpMask | (1 << seat) : mpMask & ~(1 << seat);
      mp.setRoster({ connected: mpMask });
      for (const port of peers.values()) port.postMessage({ from: seat, on: msg.on });
    },
  });
  mp.setRoster({ me: seat, connected: mpMask });
  mp.setHeap(m); m.mp = mp;
  let saveTimer = 0;
  m.onSaveDirty = () => { clearTimeout(saveTimer); saveTimer = setTimeout(sendSave, 1500); };
  const rom = new Uint8Array(o.rom); const rp = m._malloc(rom.length); m.HEAPU8.set(rom, rp);
  let sp = 0, sl = 0;
  if (o.sav && o.sav.byteLength) { const s = new Uint8Array(o.sav); sp = m._malloc(s.length); m.HEAPU8.set(s, sp); sl = s.length; }
  m.ccall('dsw_init', 'number', ['number', 'number', 'number', 'number', 'number', 'string', 'number'], [rp, rom.length, sp, sl, seat + 1, o.name || 'Player', o.rate || 48000]);
  for (const c of o.cheats || []) m.ccall('dsw_cheat', null, ['string'], [c]);
  if (remote) setupJpeg();
  post({ t: 'ready' });
  loop();
}

function sendSave() {
  const p = m._dsw_save(), n = m._dsw_save_len();
  if (n > 0) { const buf = m.HEAPU8.slice(p, p + n).buffer; post({ t: 'save', buf }, [buf]); }
}

// ---- Pictures for a player on another phone: JPEGs, made in this thread ----
let cv = null, cx = null, img = null, busy = 0, botHash = 0, frameNo = 0, jpegBytes = 0;
function setupJpeg() {
  if (typeof OffscreenCanvas === 'undefined') return;
  cv = new OffscreenCanvas(W, H); cx = cv.getContext('2d'); img = new ImageData(W, H);
}
function hash(px) { let h = 0; for (let i = 0; i < px.length; i += 52) h = (h * 31 + px[i] + px[i + 1] * 7 + px[i + 2] * 13) | 0; return h; }
async function jpeg(which, px) {
  busy++;
  try {
    img.data.set(px); cx.putImageData(img, 0, 0);
    const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: which === 'map' ? (mapMode === 'top' ? 0.88 : 0.85) : lite ? 0.5 : 0.72 });
    const buf = await blob.arrayBuffer();
    jpegBytes += buf.byteLength;
    post({ t: 'jpeg', which, buf }, [buf]);
  } catch (e) { /* skip this picture */ }
  busy--;
}

// A zero-delay yield (setTimeout(0) in a loop is held to 4 ms by browsers).
const yc = new MessageChannel(); let yq = [];
yc.port1.onmessage = () => { const q = yq; yq = []; q.forEach((r) => r()); };
const yieldNow = () => new Promise((r) => { yq.push(r); yc.port2.postMessage(0); });

// ---- The frame loop: 60 a second, each console on its own clock; the wireless keeps them together ----
let frames = 0, busyMs = 0, statAt = 0;
async function loop() {
  running = true;
  const frame = m.cwrap('dsw_frame', 'number', ['number', 'number', 'number'], { async: true });
  let t0 = performance.now(), k = 0;
  statAt = t0;
  while (running) {
    const t = performance.now();
    // Tilt steering: a share of left or right presses, spread over the frames.
    if (script) { let sk = 0; for (const [f0, kk, hold] of script) if (frameNo >= f0 && frameNo < f0 + hold) sk |= kk; keys = sk; }
    let k2 = keys & ~((1 << KEY.left) | (1 << KEY.right));
    if (steer) { steerAcc += Math.abs(steer) / 100; if (steerAcc >= 1) { steerAcc -= 1; k2 |= 1 << (steer < 0 ? KEY.left : KEY.right); } }
    else k2 = keys;
    await frame(k2, touch ? touch[0] : -1, touch ? touch[1] : 0);
    const n = m._dsw_audio(4096);
    if (n > 0) { const a = m.HEAP16.slice(m._dsw_audio_buf() >> 1, (m._dsw_audio_buf() >> 1) + n * 2); post({ t: 'audio', pcm: a.buffer }, [a.buffer]); }
    const top = m.HEAPU8.subarray(m._dsw_top(), m._dsw_top() + PX), bot = m.HEAPU8.subarray(m._dsw_bot(), m._dsw_bot() + PX);
    frameNo++;
    if (!remote) {
      const tb = top.slice().buffer, bb = bot.slice().buffer;
      post({ t: 'frame', top: tb, bot: bb }, [tb, bb]);
      // A big screen shows the host's race (the top screen).
      if (mapOn && cx && mapMode === 'top') { if (busy < 2) jpeg('map', top); }
      else if (mapOn && cx && !busy && frameNo % 3 === 0) jpeg('map', bot);
    } else if (cx && busy < 2) {
      if (!lite || frameNo % 2 === 0) jpeg('top', top);
      // The bottom screen only when it changed, and at most 20 times a second (10 with data saver).
      if (frameNo % (lite ? 6 : 3) === 0) { const h = hash(bot); if (h !== botHash || frameNo % 60 === 0) { botHash = h; jpeg('bot', bot); } }
    }
    frames++; busyMs += performance.now() - t;
    const now = performance.now();
    if (now - statAt >= 2000) {
      post({ t: 'stats', frame: frameNo, fps: Math.round(frames * 10000 / (now - statAt)) / 10, ms: Math.round(busyMs / frames * 10) / 10, waits: mp.stats.timeouts, rx: mp.stats.rx, tx: mp.stats.tx, peers: peers.size, mask: mpMask, lite, jpegKB: Math.round(jpegBytes / 1024) });
      frames = 0; busyMs = 0; statAt = now;
    }
    k++;
    let d = t0 + k * 1000 / 60 - performance.now();
    if (d < -100) { t0 = performance.now(); k = 0; d = 0; }   // fell far behind (phone was busy): start the clock again
    if (d > 1) await new Promise((r) => setTimeout(r, d));
    else await yieldNow();   // behind: run the next frame right away, but let messages in first
  }
}

self.onmessage = (e) => {
  const d = e.data;
  if (d.t === 'init') init(d).catch((err) => post({ t: 'error', msg: String(err && err.message || err) }));
  else if (d.t === 'port') setPeer(d.seat, d.port);
  else if (d.t === 'unport') { const p = peers.get(d.seat); if (p) { p.close(); peers.delete(d.seat); } mpMask &= ~(1 << d.seat); mp && mp.setRoster({ connected: mpMask }); }
  else if (d.t === 'input') { if (d.keys != null) keys = d.keys; if (d.steer != null) steer = d.steer; if ('touch' in d) touch = d.touch; }
  else if (d.t === 'lite') lite = !!d.on;
  else if (d.t === 'map') { mapOn = !!d.on; if (d.mode) mapMode = d.mode; if (mapOn && !cx) setupJpeg(); }
  else if (d.t === 'save') sendSave();
  else if (d.t === 'stop') { running = false; if (m) sendSave(); }
};
