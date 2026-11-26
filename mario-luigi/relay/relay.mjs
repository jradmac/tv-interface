// Mario & Luigi relay: connects two phones by a room code. It only passes messages between them:
// Luigi's buttons to Mario's phone, and Luigi's pictures and sound back. The game itself never goes
// through here. No packages needed:  node relay.mjs   (PORT, default 8096; HOST, default 0.0.0.0)
//   WS /ws?role=host&room=ABCD&name=Jared     Mario's phone (makes the room)
//   WS /ws?role=guest&room=ABCD&name=Sam      Luigi's phone
//   GET /health                               "ok"
//   GET /w/ABCD?k=KEY                         the watch page: Mario's screen and sound on any big screen
//   WS /ws?role=watch&room=ABCD&k=KEY         a watch page (Mario's phone sets KEY with &wk= when it makes the room)
//   Binary kinds 9 (Mario's screen JPEG) and 10 (Mario's sound: u32 rate, then 16-bit stereo) go from Mario to watch pages.
// Kart Party (Mario Kart DS, up to 4 players) shares this server, in rooms of its own:
//   WS /ws?game=kart&role=host&room=ABCD&name=&id=    the host's phone (runs every racer's DS)
//   WS /ws?game=kart&role=guest&room=ABCD&name=&id=   a friend (seat 1-3, kept if they reconnect)
//   GET /kart/ABCD                                    the browser join page (page and script only, never the game file)
//   Binary byte 1 is the seat: a friend's buttons arrive at the host stamped with their seat, and the
//   host's pictures/sound for seat N go only to that friend.
// Also answers under /ml/ (when a proxy keeps that prefix).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const WATCH_PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watch.html');
// The browser Luigi page (/play/ABCD): the app's own page and script. Luigi's side never runs the game,
// so only these two files are served (never the game file).
const APP_WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'MarioLuigi', 'Web');
const PLAY_FILES = { 'index.html': 'text/html; charset=utf-8', 'game.js': 'text/javascript; charset=utf-8', 'kart.js': 'text/javascript; charset=utf-8' };
const KART_WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'mario-kart', 'MarioKart', 'Web');

const PORT = Number(process.env.PORT || 8096), HOST = process.env.HOST || '0.0.0.0';
const MAX_ROOMS = 50, MAX_MSG = 1 << 20, ROOM_IDLE = 6 * 3600e3, GRACE = 20000;
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

class Sock {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.frag = []; this.op = 1; this.open = true;
    this.onmessage = () => {}; this.onbinary = () => {}; this.onclose = () => {};
    socket.setNoDelay(true);
    socket.on('data', (d) => this.read(d));
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }
  read(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MSG) return this.close(1009);
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let data = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = b.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3]; }
      this.buf = b.subarray(need);
      if (op === 8) return this.close(1000);
      if (op === 9) { this.frame(10, data); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) {
        if (op) this.op = op;
        this.frag.push(data);
        if (fin) {
          const all = this.frag.length === 1 ? Buffer.from(this.frag[0]) : Buffer.concat(this.frag);
          this.frag = [];
          try { if (this.op === 2) this.onbinary(all); else this.onmessage(all.toString('utf8')); } catch (e) { log('message error', e.message); }
        }
      }
    }
  }
  frame(op, payload) {
    if (!this.open) return;
    const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let head;
    if (p.length < 126) head = Buffer.from([0x80 | op, p.length]);
    else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(p.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
    try { this.socket.write(Buffer.concat([head, p])); } catch {}
  }
  send(msg) { this.frame(1, typeof msg === 'string' ? msg : JSON.stringify(msg)); }
  sendBinary(buf) { this.frame(2, buf); }
  get backlog() { return this.socket.writableLength; }
  close(code = 1000) { if (!this.open) return; const p = Buffer.alloc(2); p.writeUInt16BE(code); this.frame(8, p); this.socket.end(); this.closed(); }
  closed() { if (!this.open) return; this.open = false; try { this.socket.destroy(); } catch {} this.onclose(); }
}

// room code -> { host: {sock,name,id}|null, guest: {...}|null, at, gone: {host,guest} timers }
const rooms = new Map();
const clean = (s, n) => String(s || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, n);
function info(r) { return { t: 'room', host: r.host ? { name: r.host.name, away: !r.host.sock } : null, guest: r.guest ? { name: r.guest.name, away: !r.guest.sock } : null }; }
function tell(r) { const m = info(r); for (const side of ['host', 'guest']) { const p = r[side]; p && p.sock && p.sock.send(m); } for (const w of r.watchers) w.send(m); }
// Mario's phone only makes the big-screen picture while a watch page is open (and its sound only if one asked for it).
function tellWatchers(r) { const h = r.host; if (h && h.sock) h.sock.send({ t: 'watchers', n: r.watchers.size, sound: [...r.watchers].some((w) => w.sound) }); }
function onWatch(s, code, key) {
  const r = rooms.get(code);
  if (!r || !r.host || !r.watchKey || key !== r.watchKey) { s.send({ t: 'error', msg: 'This screen link has ended. Make a new one in the game menu.' }); return s.close(1000); }
  if (r.watchers.size >= 4) { s.send({ t: 'error', msg: 'Too many screens are watching this game.' }); return s.close(1000); }
  r.watchers.add(s); log('watch', code, r.watchers.size);
  s.onmessage = (txt) => { let m; try { m = JSON.parse(txt); } catch { return; } if (m.t === 'sound') { s.sound = !!m.on; tellWatchers(r); } };
  s.onclose = () => { r.watchers.delete(s); tellWatchers(r); };
  s.send(info(r)); tellWatchers(r);
}
function sweep() { const now = Date.now(); for (const [c, r] of rooms) if (!r.host && !r.guest || now - r.at > ROOM_IDLE) { for (const s of ['host', 'guest']) r[s] && r[s].sock && r[s].sock.close(1000); rooms.delete(c); } }
setInterval(sweep, 60e3).unref();

function onSocket(s, role, code, name, id, wk) {
  let r = rooms.get(code);
  if (role === 'host') {
    if (!r) { if (rooms.size >= MAX_ROOMS) sweep(); if (rooms.size >= MAX_ROOMS) { s.send({ t: 'error', msg: 'The server is busy. Try again in a minute.' }); return s.close(1000); } r = { host: null, guest: null, at: Date.now(), gone: {}, watchers: new Set(), watchKey: '' }; rooms.set(code, r); }
    else if (r.host && r.host.id !== id) { s.send({ t: 'error', msg: 'That room is already taken. Make a new one.' }); return s.close(1000); }
  } else {
    if (!r || !r.host) { s.send({ t: 'error', msg: 'No game with that code. Check the letters with Mario.' }); return s.close(1000); }
    if (r.guest && r.guest.id !== id && r.guest.sock) { s.send({ t: 'error', msg: 'Luigi is already playing in that game.' }); return s.close(1000); }
  }
  const me = r[role] && r[role].id === id ? r[role] : { id, name };
  clearTimeout(r.gone[role]);
  if (me.sock && me.sock !== s) { const old = me.sock; old.onclose = () => {}; old.close(4000); }
  me.sock = s; me.name = name; r[role] = me; r.at = Date.now();
  if (role === 'host' && wk) r.watchKey = wk;
  const other = () => r[role === 'host' ? 'guest' : 'host'];
  log('join', code, role, name);
  s.onmessage = (txt) => {
    let m; try { m = JSON.parse(txt); } catch { return; }
    if (m.t === 'ping') return s.send({ t: 'pong', at: m.at });
    if (m.t === 'leave') { s.onclose = () => {}; drop(); return s.close(1000); }
    const o = other(); if (o && o.sock) o.sock.send(txt);   // everything else goes to the other phone
  };
  s.onbinary = (buf) => {
    r.at = Date.now();
    if (role === 'host' && (buf[0] === 9 || buf[0] === 10)) {   // for the big screens only
      for (const w of r.watchers) if (w.backlog < (buf[0] === 9 ? 250e3 : 500e3)) w.sendBinary(buf);
      return;
    }
    const o = other(); if (!o || !o.sock) return;
    // A slow connection: skip pictures it can't take yet (kind 5), so it never falls behind. Buttons always go.
    if (buf[0] === 5 && o.sock.backlog > 200e3) return;
    if (buf[0] !== 3 && o.sock.backlog > 600e3) return;
    o.sock.sendBinary(buf);
  };
  function drop() {
    if (r[role] !== me) return;
    r[role] = null; log('leave', code, role, name);
    if (role === 'host') { const g = r.guest; if (g && g.sock) { g.sock.send({ t: 'ended' }); } for (const w of r.watchers) { w.send({ t: 'ended' }); w.close(1000); } rooms.delete(code); }
    else tell(r);
  }
  s.onclose = () => { if (me.sock !== s) return; me.sock = null; r.gone[role] = setTimeout(drop, GRACE); tell(r); };
  tell(r);
  if (role === 'host') tellWatchers(r);
}

// ---- Kart Party rooms: one host, up to 3 friends ----------------------------------------------
// code -> { host: {sock,name,id}|null, seats: [null, p1, p2, p3], at, gone: {} }
const karts = new Map();
function kartInfo(r, you) {
  return { t: 'room', you, host: r.host ? { name: r.host.name, away: !r.host.sock } : null,
    players: r.seats.map((p, seat) => p && { seat, name: p.name, away: !p.sock }).filter(Boolean) };
}
function kartTell(r) {
  r.host && r.host.sock && r.host.sock.send(kartInfo(r, 0));
  r.seats.forEach((p, seat) => p && p.sock && p.sock.send(kartInfo(r, seat)));
}
function kartSweep() { const now = Date.now(); for (const [c, r] of karts) if ((!r.host && !r.seats.some(Boolean)) || now - r.at > ROOM_IDLE) { r.host && r.host.sock && r.host.sock.close(1000); r.seats.forEach((p) => p && p.sock && p.sock.close(1000)); karts.delete(c); } }
setInterval(kartSweep, 60e3).unref();
function onKart(s, role, code, name, id) {
  let r = karts.get(code), seat = 0;
  if (role === 'host') {
    if (!r) { if (karts.size >= MAX_ROOMS) kartSweep(); if (karts.size >= MAX_ROOMS) { s.send({ t: 'error', msg: 'The server is busy. Try again in a minute.' }); return s.close(1000); } r = { host: null, seats: [null, null, null, null], at: Date.now(), gone: {} }; karts.set(code, r); }
    else if (r.host && r.host.id !== id) { s.send({ t: 'error', msg: 'That race code is taken. Start a new race.' }); return s.close(1000); }
  } else {
    if (!r || !r.host) { s.send({ t: 'error', msg: 'No race with that code. Check the letters with the host.' }); return s.close(1000); }
    seat = r.seats.findIndex((p, i) => i > 0 && p && p.id === id);
    if (seat < 1) seat = r.seats.findIndex((p, i) => i > 0 && !p);
    if (seat < 1) { s.send({ t: 'error', msg: 'The race is full: 4 players are already in.' }); return s.close(1000); }
  }
  const slot = role === 'host' ? 'host' : seat;
  const get = () => (role === 'host' ? r.host : r.seats[seat]);
  const prev = get();
  const me = prev && prev.id === id ? prev : { id, name };
  clearTimeout(r.gone[slot]);
  if (me.sock && me.sock !== s) { const old = me.sock; old.onclose = () => {}; old.close(4000); }
  me.sock = s; me.name = name; r.at = Date.now();
  if (role === 'host') r.host = me; else r.seats[seat] = me;
  log('kart join', code, role, seat, name);
  s.onmessage = (txt) => {
    let m; try { m = JSON.parse(txt); } catch { return; }
    if (m.t === 'ping') return s.send({ t: 'pong', at: m.at });
    if (m.t === 'leave') { s.onclose = () => {}; drop(); return s.close(1000); }
    if (role === 'host') {   // to one friend ({to: seat}) or to all of them
      const out = JSON.stringify(m);
      r.seats.forEach((p, i) => { if (p && p.sock && (m.to == null || m.to === i)) p.sock.send(out); });
    } else if (r.host && r.host.sock) { m.seat = seat; r.host.sock.send(m); }
  };
  s.onbinary = (buf) => {
    r.at = Date.now();
    if (buf.length < 2) return;
    if (role === 'host') {
      const p = r.seats[buf[1]]; if (!p || !p.sock || buf[1] === 0) return;
      // A slow connection: skip pictures it can't take yet (kind 5), so it never falls behind.
      if (buf[0] === 5 && p.sock.backlog > 200e3) return;
      if (p.sock.backlog > 600e3) return;
      p.sock.sendBinary(buf);
    } else if (r.host && r.host.sock && buf[0] === 3) { buf[1] = seat; r.host.sock.sendBinary(buf); }
  };
  function drop() {
    if (get() !== me) return;
    log('kart leave', code, role, seat, name);
    if (role === 'host') {
      r.host = null;
      r.seats.forEach((p) => { if (p && p.sock) { p.sock.send({ t: 'ended' }); p.sock.close(1000); } });
      karts.delete(code);
    } else { r.seats[seat] = null; kartTell(r); }
  }
  s.onclose = () => { if (me.sock !== s) return; me.sock = null; r.gone[slot] = setTimeout(drop, GRACE); kartTell(r); };
  kartTell(r);
}

function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return false; }
  const ok = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${ok}`, '', ''].join('\r\n'));
  return true;
}
const strip = (p) => (p.startsWith('/ml/') ? p.slice(3) : p);
const server = http.createServer((req, res) => {
  const p = strip(new URL(req.url, 'http://x').pathname);
  if (/^\/w\/[A-Za-z]{4}$/.test(p)) {
    return fs.readFile(WATCH_PAGE, (e, d) => { if (e) { res.writeHead(500); return res.end('Watch page missing'); } res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(d); });
  }
  const play = p.match(/^\/play(?:\/([A-Za-z]{4}))?\/?$/) ? 'index.html' : (p.match(/^\/play\/(?:[A-Za-z]{4}\/)?game\.js$/) ? 'game.js' : null);
  if (play) {
    return fs.readFile(path.join(APP_WEB, play), (e, d) => { if (e) { res.writeHead(500); return res.end('Page missing'); } res.writeHead(200, { 'content-type': PLAY_FILES[play], 'cache-control': 'no-cache' }); res.end(d); });
  }
  const kart = p.match(/^\/kart(?:\/([A-Za-z]{4}))?\/?$/) ? 'index.html' : (p.match(/^\/kart(?:\/[A-Za-z]{4})?\/kart\.js$/) || p === '/kart.js' ? 'kart.js' : null);
  if (kart) {
    return fs.readFile(path.join(KART_WEB, kart), (e, d) => { if (e) { res.writeHead(500); return res.end('Page missing'); } res.writeHead(200, { 'content-type': PLAY_FILES[kart], 'cache-control': 'no-cache' }); res.end(d); });
  }
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); return res.end('ok'); }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
});
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (strip(url.pathname) !== '/ws') return socket.destroy();
  const q = url.searchParams, role = q.get('role'), code = String(q.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  if (!['host', 'guest', 'watch'].includes(role) || code.length !== 4) return socket.destroy();
  if (!accept(req, socket)) return;
  const key = (v) => String(v || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  if (q.get('game') === 'kart') { if (role === 'watch') return socket.destroy(); return onKart(new Sock(socket), role, code, clean(q.get('name'), 10) || (role === 'host' ? 'Host' : 'Racer'), clean(q.get('id'), 40) || crypto.randomUUID()); }
  if (role === 'watch') return onWatch(new Sock(socket), code, key(q.get('k')));
  onSocket(new Sock(socket), role, code, clean(q.get('name'), 10) || (role === 'host' ? 'Mario' : 'Luigi'), clean(q.get('id'), 40) || crypto.randomUUID(), key(q.get('wk')));
});
server.listen(PORT, HOST, () => log(`Mario & Luigi + Kart Party relay on http://${HOST}:${PORT}`));
