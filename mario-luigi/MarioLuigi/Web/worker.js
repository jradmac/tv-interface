// One player's Nintendo DS, running on the host phone in its own thread.
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
let keys = 0, steer = 0, steerAcc = 0, touch = null, mapOn = false, mapMode = 'map';   // 'top': the TV shows this player's game (Mario & Luigi)
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
  const rom = new Uint8Array(o.rom); romRef = rom.slice(0, 0x200000); const rp = m._malloc(rom.length); m.HEAPU8.set(rom, rp);
  let sp = 0, sl = 0;
  if (o.sav && o.sav.byteLength) { const s = new Uint8Array(o.sav); sp = m._malloc(s.length); m.HEAPU8.set(s, sp); sl = s.length; }
  m.ccall('dsw_init', 'number', ['number', 'number', 'number', 'number', 'number', 'string', 'number'], [rp, rom.length, sp, sl, seat + 1, o.name || 'Player', o.rate || 48000]);
  for (const c of o.cheats || []) m.ccall('dsw_cheat', null, ['string'], [c]);
  if (remote) setupJpeg();
  post({ t: 'ready' });
  loop();
}

// ---- The DS's own memory (4 MB main RAM), found inside the emulator once the game is loaded ----
let romRef = null, ramAt = -1, ramHits = null;
// The game's code shows up more than once in the emulator (copies of the game file too); the console's own
// memory is the copy where the game's player count and local player number make sense.
function findRam() {
  const r = romRef, H = m.HEAPU8;
  const off = r[0x20] | r[0x21] << 8 | r[0x22] << 16 | r[0x23] << 24, at = (r[0x28] | r[0x29] << 8 | r[0x2A] << 16 | r[0x2B] << 24) >>> 0;
  if (!ramHits) {
    ramHits = [];
    const pr = r.subarray(off + 0x800, off + 0x840), p0 = pr[0];
    outer: for (let i = H.indexOf(p0); i >= 0 && i < H.length - 64; i = H.indexOf(p0, i + 1)) {
      for (let j = 1; j < 64; j++) if (H[i + j] !== pr[j]) continue outer;
      ramHits.push(i - 0x800 - (at & 0x3FFFFF));
    }
  }
  for (const b of ramHits) {
    ramAt = b;
    const n = rd32(0x0208B348);
    if (n === 2) return true;
  }
  ramAt = -1; return false;
}
const ram = (a) => ramAt + (a & 0x3FFFFF);
function rd32(a) { const H = m.HEAPU8, i = ram(a); return (H[i] | H[i + 1] << 8 | H[i + 2] << 16 | H[i + 3] << 24); }
function rd8(a) { return m.HEAPU8[ram(a)]; }
function wr32(a, v) { const H = m.HEAPU8, i = ram(a); H[i] = v; H[i + 1] = v >> 8; H[i + 2] = v >> 16; H[i + 3] = v >> 24; }

// ---- Bubbles (like the Wii game) ----------------------------------------------------------------
// The co-op mod already turns a player who dies into an invisible ghost that follows the partner, and
// brings the ghost back next to the partner when the ghost presses jump. On top of that, every console
// (each runs the same game, frame for frame) does the same here:
//   - draws a bubble that floats just behind and above the partner,
//   - the ghost can't pop itself: its jump buttons are held back,
//   - when the partner touches the bubble, the ghost's console presses jump for it (so it comes back),
//   - the life the fall took is given back (only while the partner is still alive).
// Addresses: NSMB (USA) code reference (MammaMiaTeam/NSMB-Code-Reference).
const A_DEAD = 0x0208B328, A_COUNT = 0x0208B348, A_PLAYERS = 0x0208B35C, A_LIVES = 0x0208B364, A_CAMX = 0x020CAE1C, A_CAMY = 0x020CAD94;
const P_X = 0x60, P_Y = 0x64;   // a player's position (fixed point, 1/4096 pixel; y goes up)
const JUMPS = (1 << KEY.a) | (1 << KEY.b);
const bub = [null, null];       // per player: { x, y, t } in game pixels while a ghost
let livesWas = [-1, -1], popHold = 0, findTry = 0, partnerDir = [1, 1], partnerX = [0, 0];
const fx = (v) => v / 4096;
function bubbles(top) {
  if (ramAt < 0) { if (frameNo < findTry) return; findTry = frameNo + 120; if (!findRam()) return; }
  if (rd32(A_COUNT) !== 2) { bub[0] = bub[1] = null; livesWas = [-1, -1]; return; }
  const p0 = rd32(A_PLAYERS) >>> 0, p1 = rd32(A_PLAYERS + 4) >>> 0;
  if ((p0 >>> 24) !== 2 || (p1 >>> 24) !== 2) { bub[0] = bub[1] = null; return; }
  const P = [p0, p1], dead = [rd8(A_DEAD), rd8(A_DEAD + 1)];
  for (let p = 0; p < 2; p++) {
    const o = p ^ 1;
    // Give back a life lost while the partner is still playing.
    const lv = rd32(A_LIVES + 4 * p);
    if (livesWas[p] >= 0 && lv === livesWas[p] - 1 && !dead[o]) { wr32(A_LIVES + 4 * p, lv + 1); livesWas[p] = lv + 1; post({ t: 'ghost', p, refund: lv + 1 }); }
    else livesWas[p] = lv;
    const ox = fx(rd32(P[o] + P_X)), oy = fx(rd32(P[o] + P_Y));
    if (Math.abs(ox - partnerX[o]) > 0.3) partnerDir[o] = ox > partnerX[o] ? 1 : -1;
    partnerX[o] = ox;
    if (!dead[p] || dead[o]) { bub[p] = null; continue; }
    // Float behind and a little above the partner, bobbing.
    const b = bub[p] || (bub[p] = { x: ox - 20 * partnerDir[o], y: oy + 60, t: 0 });
    b.t++;
    const tx = ox - 14 * partnerDir[o], ty = oy + 34 + 5 * Math.sin(b.t / 14);
    b.x += (tx - b.x) * 0.06; b.y += (ty - b.y) * 0.06;
    // The partner touches it (their body is about 16 px wide and 16-28 px tall above the feet).
    const touch = b.t > 45 && Math.abs(ox - b.x) < 17 && oy + 14 > b.y - 15 && oy < b.y + 15;
    if (touch && p === seat) popHold = 4;
  }
  if (top) for (let p = 0; p < 2; p++) if (bub[p]) drawBubble(top, p, bub[p]);
}
function jumpFilter(k) {
  if (popHold > 0) { popHold--; return (k | (1 << KEY.b)) & ~(1 << KEY.a); }
  return bub[seat] ? k & ~JUMPS : k;
}
// A see-through bubble with a shine and the ghost's color (red Mario, green Luigi) inside.
function drawBubble(px, p, b) {
  const camX = fx(rd32(A_CAMX + 4 * seat)), camY = fx(rd32(A_CAMY + 4 * seat));
  const cx = b.x - camX, cy = -b.y - camY, R = 15;
  if (cx < -R || cx > W + R || cy < -R || cy > H + R) return;
  const col = p === 0 ? [229, 57, 53] : [67, 176, 71];
  for (let y = Math.max(0, Math.floor(cy - R - 1)); y <= Math.min(H - 1, Math.ceil(cy + R + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - R - 1)); x <= Math.min(W - 1, Math.ceil(cx + R + 1)); x++) {
      const dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy);
      if (d > R + 0.5) continue;
      const i = (y * W + x) * 4;
      let r = 255, g = 255, bl = 255, a;
      if (d > R - 1.6) a = 0.85;                                   // the rim
      else if (d < 6.5) { r = col[0]; g = col[1]; bl = col[2]; a = 0.75; }   // the ghost's color in the middle
      else a = 0.12 + 0.25 * Math.pow(d / R, 3);                   // glassy inside
      const hx = dx + 6, hy = dy + 6;                               // shine, top left
      if (hx * hx + hy * hy < 9) { r = g = bl = 255; a = 0.95; }
      px[i] = px[i] * (1 - a) + r * a; px[i + 1] = px[i + 1] * (1 - a) + g * a; px[i + 2] = px[i + 2] * (1 - a) + bl * a;
    }
  }
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
    k2 = jumpFilter(k2);
    await frame(k2, touch ? touch[0] : -1, touch ? touch[1] : 0);
    const n = m._dsw_audio(4096);
    if (n > 0) { const a = m.HEAP16.slice(m._dsw_audio_buf() >> 1, (m._dsw_audio_buf() >> 1) + n * 2); post({ t: 'audio', pcm: a.buffer }, [a.buffer]); }
    const top = m.HEAPU8.subarray(m._dsw_top(), m._dsw_top() + PX), bot = m.HEAPU8.subarray(m._dsw_bot(), m._dsw_bot() + PX);
    frameNo++;
    try { bubbles(top); } catch (e) { /* never let the bubbles stop the game */ }
    if (!remote) {
      const tb = top.slice().buffer, bb = bot.slice().buffer;
      post({ t: 'frame', top: tb, bot: bb }, [tb, bb]);
      // The TV shows this player's map (the bottom screen), about 20 times a second,
      // or, in Mario & Luigi, this player's game (the top screen), every frame.
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
  else if (d.t === 'dump') { if (d.base != null) ramAt = d.base; if (ramAt < 0) findRam(); const H = m.HEAPU8; post({ t: 'peek', id: d.id, ramAt, hits: ramHits, bytes: ramAt < 0 ? null : Array.from(H.subarray(ram(d.a), ram(d.a) + d.n)) }); }
  else if (d.t === 'peek') { if (d.base != null) ramAt = d.base; if (ramAt < 0) findRam(); post({ t: 'peek', id: d.id, ramAt, v: d.a.map(([a, sz]) => sz === 1 ? rd8(a) : rd32(a)) }); }
  else if (d.t === 'poke') { if (ramAt < 0) findRam(); wr32(d.a, d.v); }
  else if (d.t === 'stop') { running = false; if (m) sendSave(); }
};
