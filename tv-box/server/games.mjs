// DS games on the TV. The box runs a small native player (games-bin/dshost) with the DeSmuME core.
// The top screen goes full screen on the TV page (/games/tv.html), the bottom screen streams
// to the phone (/games/pad.html or the iPhone app), which also sends the buttons and touches.
// Games, in-game saves and save states live in the box's state folder, outside /opt/tv, so
// updates never touch them:  /var/lib/tv-agent/games/{roms,saves,states}
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';

const W = 256, H = 192, FRAME = W * H * 2;
const SLOTS = 6;                 // manual save slots, plus "auto" (kept when you leave the game)
const KEYFRAME_EVERY = 120;      // phone frames are deltas; send a whole one now and then

// libretro joypad bits, the same numbers the phone and the iPhone app send.
export const BUTTONS = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11 };

export function createGames({ ROOT, DIR, state, room, Sock, acceptWs, isLocal, sha256, log }) {
  const G = path.join(DIR, 'games');
  const ROMS = path.join(G, 'roms'), SAVES = path.join(G, 'saves'), STATES = path.join(G, 'states');
  const BIN = path.join(ROOT, 'games-bin');
  for (const d of [G, ROMS, SAVES, STATES]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

  // ---- How the top screen fills the TV, remembered per game: fit (4:3), fill (crop), stretch ----
  const VIEWS = ['fit', 'fill', 'stretch'], VIEW_FILE = path.join(G, 'view.json');
  let views = {}; try { views = JSON.parse(fs.readFileSync(VIEW_FILE, 'utf8')) || {}; } catch {}
  const viewOf = (g) => (VIEWS.includes(views[g]) ? views[g] : 'fit');
  function setView(g, mode) {
    if (!VIEWS.includes(mode)) return false;
    views[g] = mode;
    try { fs.writeFileSync(VIEW_FILE + '.tmp', JSON.stringify(views)); fs.renameSync(VIEW_FILE + '.tmp', VIEW_FILE); } catch (e) { log('view', e.message); }
    return true;
  }

  // ---- Library ------------------------------------------------------------------------
  const slug = (s) => s.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'game';
  function prettyTitle(file) {
    let t = file.replace(/\.nds$/i, '').replace(/\s*[([].*?[)\]]/g, '').trim();
    t = t.replace(/^Pokemon\b/i, 'Pokémon').replace(/\s+-\s+/, ' ').replace(/\s+Version$/i, '');
    return t;
  }
  function library() {
    let files = [];
    try { files = fs.readdirSync(ROMS).filter((f) => /\.nds$/i.test(f)); } catch {}
    return files.map((f) => ({ g: slug(f.replace(/\.nds$/i, '')), file: f, title: prettyTitle(f) }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }
  const find = (g) => library().find((x) => x.g === g);

  // ---- Save slots -----------------------------------------------------------------------
  const slotName = (s) => (s === 'auto' ? 'auto' : String(Math.max(1, Math.min(SLOTS, Number(s) || 1))));
  const slotFile = (g, s, ext) => path.join(STATES, g, `${slotName(s)}.${ext}`);
  function slots(g) {
    const list = [];
    for (const s of ['auto', ...Array.from({ length: SLOTS }, (_, i) => i + 1)]) {
      const f = slotFile(g, s, 'state');
      let time = 0, img = '';
      try { time = fs.statSync(f).mtimeMs; } catch {}
      if (time) { try { img = 'data:image/png;base64,' + fs.readFileSync(slotFile(g, s, 'png')).toString('base64'); } catch {} }
      list.push({ slot: s, time, img });
    }
    return list;
  }

  // ---- The running game -------------------------------------------------------------------
  let game = null;   // { g, title, proc, buf, tvs:Set, pads:Set, masks:Map, lastTop, lastBot, ready, pending:[] }

  function status() {
    return { t: 'game', running: !!game, g: game ? game.g : '', title: game ? game.title : '' };
  }
  function announce() {
    const s = status();
    room.sendTo('remote', s);
    if (game) for (const p of game.pads) p.send(s);
  }

  function start(g) {
    const rom = find(g);
    if (!rom) return null;
    if (game && game.g === g) return game;
    if (game) stop('switch');
    fs.mkdirSync(path.join(STATES, g), { recursive: true });
    const auto = slotFile(g, 'auto', 'state');
    const args = [path.join(BIN, 'desmume_libretro.so'), path.join(ROMS, rom.file), SAVES, fs.existsSync(auto) ? auto : '', auto];
    // Copies of the app don't always keep the "executable" mark on dshost, so if it's missing
    // the system's loader starts it instead (same program, no mark needed).
    const host = path.join(BIN, 'dshost');
    let exe = host, exeArgs = args;
    try { fs.accessSync(host, fs.constants.X_OK); } catch {
      const ld = ['/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'].find((f) => fs.existsSync(f));
      if (ld) { exe = ld; exeArgs = [host, ...args]; }
    }
    const proc = spawn(exe, exeArgs, { env: { ...process.env, LD_LIBRARY_PATH: BIN }, stdio: ['pipe', 'pipe', 'pipe'] });
    const gm = { g, title: rom.title, proc, buf: Buffer.alloc(0), tvs: new Set(), pads: new Set(), masks: new Map(),
      touch: null, lastTop: null, lastBot: null, ready: false, pending: [], stopTimer: 0, bottomTaps: 0 };
    game = gm;
    log('game start', g);
    proc.stdout.on('data', (d) => onData(gm, d));
    proc.stderr.on('data', (d) => { const s = String(d); if (/error|fail|missing/i.test(s)) log('dshost:', s.trim().slice(0, 300)); });
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => {   // couldn't start at all: tell the TV, never take the server down
      log('game player failed to start:', e.message);
      if (game === gm) { game = null; announce(); for (const t of gm.tvs) t.send({ t: 'game.missing', g, why: 'player' }); }
    });
    proc.on('exit', (code, sig) => {
      log('game exit', g, code ?? sig);
      for (const w of gm.waiters || []) w();
      if (game === gm) { game = null; announce(); for (const t of gm.tvs) t.send({ t: 'game.over' }); }
    });
    announce();
    return gm;
  }
  // Leaving a game: the player writes the auto save state and the in-game save, then exits.
  function stop(why) {
    const gm = game;
    if (!gm) return Promise.resolve();
    log('game stop', gm.g, why || '');
    return new Promise((resolve) => {
      gm.waiters = [...(gm.waiters || []), resolve];
      cmd(gm, 'quit');
      // Thumbnail for the auto slot (the player writes the state itself).
      if (gm.lastTop) writeThumb(gm.g, 'auto', gm.lastTop);
      setTimeout(() => { try { gm.proc.kill('SIGTERM'); } catch {} }, 6000);
      setTimeout(() => { try { gm.proc.kill('SIGKILL'); } catch {} resolve(); }, 12000);
    });
  }
  function cmd(gm, line) {
    if (!gm || !gm.proc.stdin.writable) return;
    if (!gm.ready && !/^(quit|b |t )/.test(line)) { gm.pending.push(line); return; }
    try { gm.proc.stdin.write(line + '\n'); } catch {}
  }
  function pushButtons(gm) {
    let m = 0;
    for (const v of gm.masks.values()) m |= v;
    cmd(gm, 'b ' + (m & 0xFFFF));
  }

  // Player output: [u8 type][u8 0][u16 arg][u32 len][payload]
  function onData(gm, d) {
    gm.buf = gm.buf.length ? Buffer.concat([gm.buf, d]) : d;
    let off = 0;
    while (gm.buf.length - off >= 8) {
      const len = gm.buf.readUInt32LE(off + 4);
      if (gm.buf.length - off < 8 + len) break;
      const type = gm.buf[off], arg = gm.buf.readUInt16LE(off + 2);
      const body = gm.buf.subarray(off + 8, off + 8 + len);
      off += 8 + len;
      if (type === 1 && len === FRAME) {
        gm.lastTop = Buffer.from(body);
        const msg = Buffer.allocUnsafe(4 + FRAME); msg[0] = 1; msg[1] = 0; msg[2] = 0; msg[3] = 0; body.copy(msg, 4);
        for (const t of gm.tvs) if (t.socket.writableLength < 2 * FRAME) t.frame(2, msg);
      } else if (type === 4 && len === FRAME) {
        gm.lastBot = Buffer.from(body);
        for (const p of gm.pads) sendBottom(p);
        // With nobody on the phone (a Bluetooth controller), the TV shows the bottom screen too.
        const msg = Buffer.allocUnsafe(4 + FRAME); msg[0] = 4; msg[1] = 0; msg[2] = 0; msg[3] = 0; body.copy(msg, 4);
        for (const t of gm.tvs) if (t.wantBottom && t.socket.writableLength < 2 * FRAME) t.frame(2, msg);
      } else if (type === 2) {
        const msg = Buffer.allocUnsafe(4 + len); msg[0] = 2; msg[1] = 0; msg.writeUInt16LE(arg, 2); body.copy(msg, 4);
        for (const t of gm.tvs) t.frame(2, msg);
      } else if (type === 3) {
        let ev = null; try { ev = JSON.parse(body.toString('utf8')); } catch {}
        if (ev) onEvent(gm, ev);
      }
    }
    gm.buf = off >= gm.buf.length ? Buffer.alloc(0) : gm.buf.subarray(off);
  }
  function onEvent(gm, ev) {
    if (ev.ev === 'ready') {
      gm.ready = true;
      const q = gm.pending; gm.pending = [];
      for (const l of q) cmd(gm, l);
      for (const t of gm.tvs) t.send({ t: 'game.ready', title: gm.title, rate: ev.rate });
    } else if (ev.ev === 'perf') {
      if (!gm.perfLogged || Date.now() - gm.perfLogged > 60_000) { gm.perfLogged = Date.now(); log('game perf', JSON.stringify(ev)); }
      for (const t of gm.tvs) t.send({ t: 'game.perf', ms: ev.frame_ms, skip: ev.skip });
    } else if (ev.ev === 'saved' || ev.ev === 'loaded' || ev.ev === 'error') {
      const job = gm.job; gm.job = null;
      if (job) job(ev);
    } else if (ev.ev === 'error' && ev.what === 'rom') log('game: the core could not open', gm.g);
  }

  // The phone gets the bottom screen as a change from the last one it got (XOR), packed with
  // deflate. Menus and the Pokégear barely change, so most frames are a few hundred bytes.
  function sendBottom(p) {
    const gm = game;
    if (!gm || !gm.lastBot || !p.open) return;
    if (p.socket.writableLength > 48 * 1024) { p.dirty = true; return; }   // slow Wi-Fi: skip, send the newest later
    p.dirty = false;
    const key = !p.base || (p.n = (p.n || 0) + 1) % KEYFRAME_EVERY === 0;
    let src = gm.lastBot;
    if (!key) {
      const x = Buffer.allocUnsafe(FRAME);
      for (let i = 0; i < FRAME; i += 4) x.writeUInt32LE((src.readUInt32LE(i) ^ p.base.readUInt32LE(i)) >>> 0, i);
      src = x;
    }
    const z = zlib.deflateRawSync(src, { level: 1 });
    const head = Buffer.from([4, key ? 1 : 0, 0, 0]);
    p.frame(2, Buffer.concat([head, z]));
    p.base = gm.lastBot;
  }
  setInterval(() => { if (game) for (const p of game.pads) if (p.dirty) sendBottom(p); }, 50).unref();

  // A small PNG of the top screen for the save slot list.
  function png(rgb565, w = 128, h = 96) {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = rgb565.readUInt16LE(((y * 2) * W + x * 2) * 2), o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = ((c >> 11) << 3) | (c >> 13); raw[o + 1] = (((c >> 5) & 63) << 2) | ((c >> 9) & 3); raw[o + 2] = ((c & 31) << 3) | ((c >> 2) & 7);
    }
    const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([l, td, c]); };
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
  // DS banner: header 0x68 -> banner; +0x20 4x4 tiles of 8x8 at 4 bits, +0x220 16 colours (BGR555, 0 = clear).
  function bannerIcon(file) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const h = Buffer.alloc(4); fs.readSync(fd, h, 0, 4, 0x68);
      const off = h.readUInt32LE(0); if (!off) return null;
      const b = Buffer.alloc(0x240); fs.readSync(fd, b, 0, 0x240, off);
      const pal = []; for (let i = 0; i < 16; i++) { const c = b.readUInt16LE(0x220 + i * 2); pal.push([(c & 31) << 3, ((c >> 5) & 31) << 3, ((c >> 10) & 31) << 3, i ? 255 : 0]); }
      const w = 32, raw = Buffer.alloc((w * 4 + 1) * w);
      for (let t = 0; t < 16; t++) for (let i = 0; i < 64; i++) {
        const byte = b[0x20 + t * 32 + (i >> 1)], idx = i & 1 ? byte >> 4 : byte & 15;
        const x = (t % 4) * 8 + (i % 8), y = Math.floor(t / 4) * 8 + Math.floor(i / 8);
        pal[idx].forEach((v, k) => { raw[y * (w * 4 + 1) + 1 + x * 4 + k] = v; });
      }
      const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([l, td, c]); };
      const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(w, 4); ih[8] = 8; ih[9] = 6;
      return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function writeThumb(g, s, top) { try { fs.writeFileSync(slotFile(g, s, 'png'), png(top)); } catch (e) { log('thumb', e.message); } }

  function job(gm, line) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { gm.job = null; resolve({ ev: 'error' }); }, 8000);
      gm.job = (ev) => { clearTimeout(t); resolve(ev); };
      cmd(gm, line);
    });
  }
  async function saveSlot(s) {
    const gm = game; if (!gm || gm.busy) return false;
    gm.busy = true;
    const top = gm.lastTop;
    const ev = await job(gm, 'save ' + slotFile(gm.g, s, 'state'));
    gm.busy = false;
    if (ev.ev === 'saved' && top) writeThumb(gm.g, s, top);
    return ev.ev === 'saved';
  }
  async function loadSlot(s) {
    const gm = game; if (!gm || gm.busy) return false;
    const f = slotFile(gm.g, s, 'state');
    if (!fs.existsSync(f)) return false;
    gm.busy = true;
    const ev = await job(gm, 'load ' + f);
    gm.busy = false;
    if (ev.ev === 'loaded') for (const p of gm.pads) p.base = null;   // next phone frame is a whole one
    return ev.ev === 'loaded';
  }

  // ---- Sockets ------------------------------------------------------------------------
  // role=tv : the TV page, on the box only, with the TV secret. Sends ?g= to start a game.
  // role=pad: a paired phone (web pad page or the iPhone app), with its remote key.
  function upgrade(req, socket, url) {
    const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (url.searchParams.get('tv') !== state.tv) return reject(404, 'Unknown TV');
    const role = url.searchParams.get('role'), k = url.searchParams.get('k') || '';
    if (role === 'tv') { if (!isLocal(req) || k !== state.secret) return reject(403, 'Not allowed'); }
    else if (role === 'pad') { if (!state.remotes[sha256(k)]) return reject(403, 'Not paired'); }
    else return reject(400, 'Bad role');
    acceptWs(req, socket);
    const s = new Sock(socket, { role: 'game-' + role });
    s.id = Math.random().toString(36).slice(2);
    if (role === 'tv') onTv(s, url.searchParams.get('g') || '');
    else onPad(s);
  }

  function onTv(s, g) {
    let gm = game && game.g === g ? game : start(g);
    if (!gm) { s.send({ t: 'game.missing', g }); return s.close(1000); }
    clearTimeout(gm.stopTimer);
    gm.tvs.add(s);
    if (gm.ready) s.send({ t: 'game.ready', title: gm.title });
    s.send({ t: 'game.view', mode: viewOf(gm.g) });
    s.send({ t: 'game.pads', n: gm.pads.size });
    s.onmessage = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (game !== gm) return;
      if (m.t === 'pad') { gm.masks.set('tv', Number(m.mask) | 0); pushButtons(gm); }       // a Bluetooth controller
      else if (m.t === 'bottom') { s.wantBottom = !!m.on; if (s.wantBottom) cmd(gm, 'bottom'); }
      else if (m.t === 'menu') handleMenu(gm, m, s);
    };
    s.onclose = () => {
      gm.tvs.delete(s);
      gm.masks.delete('tv'); if (game === gm) pushButtons(gm);
      // The TV page closed (Home, or another app opened): leave the game, unless it comes right back.
      if (!gm.tvs.size) gm.stopTimer = setTimeout(() => { if (game === gm && !gm.tvs.size) stop('tv closed'); }, 2500);
    };
  }

  function onPad(s) {
    s.send(status());
    if (game) { game.pads.add(s); s.send({ t: 'slots', g: game.g, slots: slots(game.g) }); s.send({ t: 'view', mode: viewOf(game.g) }); sendBottom(s); tvPads(); }
    const myGame = () => (game && game.pads.has(s) ? game : null);
    s.onmessage = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'ping') return s.send({ t: 'pong' });
      if (game && !game.pads.has(s)) { game.pads.add(s); s.base = null; sendBottom(s); tvPads(); }
      const gm = myGame(); if (!gm) return;
      if (m.t === 'btn') { gm.masks.set(s.id, Number(m.mask) | 0); return pushButtons(gm); }
      if (m.t === 'touch') {
        if (m.up) { if (gm.touch === s.id) { gm.touch = null; cmd(gm, 't -1'); } return; }
        gm.touch = s.id;
        return cmd(gm, `t ${Math.max(0, Math.min(W - 1, Math.round(m.x)))} ${Math.max(0, Math.min(H - 1, Math.round(m.y)))}`);
      }
      if (m.t === 'key') { s.base = null; return sendBottom(s); }
      return handleMenu(gm, m, s);
    };
    s.onclose = () => {
      const gm = game;
      if (!gm) return;
      gm.pads.delete(s); gm.masks.delete(s.id);
      if (gm.touch === s.id) { gm.touch = null; cmd(gm, 't -1'); }
      pushButtons(gm); tvPads();
    };
  }
  function tvPads() { if (game) for (const t of game.tvs) t.send({ t: 'game.pads', n: game.pads.size }); }

  async function handleMenu(gm, m, s) {
    const toast = (text) => { s.send({ t: 'toast', text }); for (const t of gm.tvs) t.send({ t: 'game.toast', text }); };
    if (m.t === 'slots') return s.send({ t: 'slots', g: gm.g, slots: slots(gm.g) });
    if (m.t === 'save') {
      const ok = await saveSlot(m.slot ?? 1);
      toast(ok ? (m.slot === 'auto' ? 'Saved' : `Saved to slot ${slotName(m.slot ?? 1)}`) : "Couldn't save. Try again.");
      for (const p of gm.pads) p.send({ t: 'slots', g: gm.g, slots: slots(gm.g) });
      return;
    }
    if (m.t === 'load') {
      const ok = await loadSlot(m.slot ?? 1);
      return toast(ok ? (m.slot === 'auto' ? 'Back where you left off' : `Loaded slot ${slotName(m.slot ?? 1)}`) : 'Nothing saved there yet.');
    }
    if (m.t === 'pause') { cmd(gm, 'pause ' + (m.on ? 1 : 0)); for (const t of gm.tvs) t.send({ t: 'game.paused', on: !!m.on }); return; }
    if (m.t === 'ff') return cmd(gm, 'ff ' + (m.on ? 1 : 0));
    if (m.t === 'view') {
      if (!setView(gm.g, m.mode)) return;
      for (const t of gm.tvs) t.send({ t: 'game.view', mode: m.mode });
      for (const p of gm.pads) p.send({ t: 'view', mode: m.mode });
      return;
    }
    if (m.t === 'reset') { cmd(gm, 'reset'); return toast('Restarted. Your in-game save is safe.'); }
    if (m.t === 'leave') {
      // Home from the game: quick save happens on exit; the box goes back to the TV home.
      room.sendTo('box', { t: 'home' });
      return;
    }
  }

  // ---- HTTP ---------------------------------------------------------------------------
  const authed = (req, url) => isLocal(req) || (url.searchParams.get('tv') === state.tv && !!state.remotes[sha256(url.searchParams.get('k') || '')]);
  function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }

  // Returns true when it answered the request.
  function http(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/api/games')) return false;
    if (p === '/api/games' && req.method === 'GET') {
      if (!authed(req, url)) return json(res, 403, { error: 'Pair this phone with the TV first.' }), true;
      json(res, 200, { games: library().map(({ g, title }) => ({ g, title })), ...status() });
      return true;
    }
    if (p === '/api/games/status') { json(res, 200, status()); return true; }
    // The game's own little icon from the cartridge (32x32), for games without box art.
    if (p === '/api/games/icon') {
      const rom = find(url.searchParams.get('g') || '');
      const icon = rom && bannerIcon(path.join(ROMS, rom.file));
      if (!icon) return json(res, 404, { error: 'No icon' }), true;
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }); res.end(icon);
      return true;
    }
    // Add a game: PUT /api/games/upload?name=Some%20Game.nds  (from the box itself, or a paired phone)
    if (p === '/api/games/upload' && (req.method === 'PUT' || req.method === 'POST')) {
      if (!authed(req, url)) return json(res, 403, { error: 'Pair this phone with the TV first.' }), true;
      const name = path.basename(String(url.searchParams.get('name') || '')).replace(/[\/\\\0]/g, '');
      if (!/\.nds$/i.test(name)) return json(res, 400, { error: 'Only DS games (.nds files) for now.' }), true;
      const size = Number(req.headers['content-length'] || 0);
      if (size > 600 * 1024 * 1024) return json(res, 413, { error: 'That file is too big for a DS game.' }), true;
      try {
        const free = Number(execFileSync('df', ['--output=avail', '-B1', G]).toString().split('\n')[1]);
        if (size && free && free - size < 300 * 1024 * 1024) return json(res, 507, { error: 'The box is almost out of space.' }), true;
      } catch {}
      const dest = path.join(ROMS, name), tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      let n = 0, failed = false;
      req.on('data', (d) => { n += d.length; if (n > 600 * 1024 * 1024 && !failed) { failed = true; req.destroy(); } });
      req.pipe(out);
      out.on('finish', () => {
        if (failed || (size && n !== size)) { fs.rmSync(tmp, { force: true }); return json(res, 400, { error: 'The upload was cut off. Try again.' }); }
        fs.renameSync(tmp, dest);
        log('game added', name, n);
        json(res, 200, { ok: true, g: slug(name.replace(/\.nds$/i, '')), title: prettyTitle(name) });
      });
      req.on('aborted', () => { failed = true; out.destroy(); fs.rmSync(tmp, { force: true }); });
      return true;
    }
    json(res, 404, { error: 'Not found' });
    return true;
  }

  // A box restart or an update stops the server: leave the game properly first (auto save).
  let leaving = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      if (leaving) return; leaving = true;
      if (game) await Promise.race([stop('server stop'), new Promise((r) => setTimeout(r, 8000))]);
      process.exit(0);
    });
  }

  return { http, upgrade, status, library };
}
