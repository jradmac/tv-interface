#!/usr/bin/env node
// TV box server. Runs on the Chromebox and serves everything on the home network:
//   - the TV home page (shown full screen by Chrome on the box)
//   - the phone remote (opened on the phone over Wi-Fi)
//   - the "room": a WebSocket hub between the phone(s), the TV page and the box agent
//   - pairing, and the voice step (Claude if a key is set, simple word rules otherwise)
// HTTP on port 80. HTTPS on 443 with a certificate from the box's own small certificate
// authority, so the phone can use its microphone once it trusts the box.
// No npm packages.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseIntent } from './intent.mjs';
import { createGames } from './games.mjs';
import { Roku } from './roku.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.TV_STATE_DIR || '/var/lib/tv-agent';
const STATE = path.join(DIR, 'server.json');
const TLS = path.join(DIR, 'tls');
const HTTP_PORT = Number(process.env.HTTP_PORT || 80);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 443);
// Always tv.local (the installer names the box "tv"); the router's own name for it (e.g. tv.home) can change.
const HOST = process.env.TV_HOST || 'tv.local';
const PAIR_MINUTES = 10;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------------------------------
// Saved state: the TV's secret and the paired phones.

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
const state = loadState();
if (!state.tv) state.tv = crypto.randomBytes(6).toString('hex');
if (!state.secret) state.secret = crypto.randomBytes(16).toString('hex');
state.remotes = state.remotes || {};
function save() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(STATE + '.tmp', STATE);
}
save();

// Settings Jared can change in /var/lib/tv-agent/settings.json (e.g. the Anthropic key).
function settings() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'settings.json'), 'utf8')); } catch { return {}; }
}
function writeSettings(obj) {
  const f = path.join(DIR, 'settings.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
}
const keyInfo = (k) => ({ set: !!k, hint: k ? '…' + String(k).slice(-4) : '' });
// true = Anthropic accepts the key, false = it refused it, null = couldn't tell (offline).
async function checkKey(k) {
  try {
    const r = await fetch((process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages').replace(/\/messages$/, '/models?limit=1'), { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) return false;
    return r.ok ? true : null;
  } catch { return null; }
}
function intentEnv() {
  const s = settings();
  return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || s.anthropicKey || '', INTENT_MODEL: process.env.INTENT_MODEL || s.intentModel || '' };
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
function pairCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return [...crypto.randomBytes(6)].map((b) => abc[b % abc.length]).join('');
}
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// ---------------------------------------------------------------------------------------
// TLS: a small certificate authority made on the box, and a certificate for HOST.

function ensureTls() {
  try {
    fs.mkdirSync(TLS, { recursive: true, mode: 0o700 });
    const ca = path.join(TLS, 'ca.pem'), caKey = path.join(TLS, 'ca.key');
    const cert = path.join(TLS, 'cert.pem'), key = path.join(TLS, 'key.pem'), hostFile = path.join(TLS, 'host');
    if (!fs.existsSync(ca) || !fs.existsSync(caKey)) {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca, '-days', '3650',
        '-subj', `/CN=TV box ${state.tv}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { stdio: 'ignore' });
      fs.rmSync(cert, { force: true });
      log('made a new certificate authority');
    }
    let renew = !fs.existsSync(cert) || !fs.existsSync(key) || (fs.existsSync(hostFile) ? fs.readFileSync(hostFile, 'utf8') : '') !== HOST;
    if (!renew) {
      const x = new crypto.X509Certificate(fs.readFileSync(cert));
      renew = new Date(x.validTo).getTime() - Date.now() < 60 * 86400e3;
    }
    if (renew) {
      const csr = path.join(TLS, 'req.csr'), ext = path.join(TLS, 'ext.cnf');
      fs.writeFileSync(ext, `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${HOST},DNS:localhost,IP:127.0.0.1\n`);
      execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${HOST}`], { stdio: 'ignore' });
      // iPhones accept at most 825 days for certificates from a trusted-by-you authority.
      execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '800', '-extfile', ext], { stdio: 'ignore' });
      fs.writeFileSync(hostFile, HOST);
      fs.rmSync(csr, { force: true });
      log('made a certificate for', HOST);
    }
    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key), ca: fs.readFileSync(ca, 'utf8') };
  } catch (e) {
    log('HTTPS is off (could not make a certificate):', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Minimal WebSocket server (text frames, ping/pong, close).

class Sock {
  constructor(socket, info) {
    this.socket = socket;
    this.info = info; // { role, name, keyHash }
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.open = true;
    this.onmessage = () => {};
    this.onclose = () => {};
    socket.setNoDelay(true);
    socket.on('data', (d) => this.read(d));
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }
  read(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) return this.close(1009);
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let data = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const m = b.subarray(off, off + 4);
        data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3];
      }
      this.buf = b.subarray(need);
      if (op === 8) return this.close(1000);
      if (op === 9) { this.frame(10, data); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) {
        this.frag.push(data);
        if (fin) {
          const msg = Buffer.concat(this.frag).toString('utf8');
          this.frag = [];
          try { this.onmessage(msg); } catch (e) { log('message error', e.message); }
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
  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this.frame(8, p);
    this.socket.end();
    this.closed();
  }
  closed() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch {}
    this.onclose();
  }
}

function acceptWs(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
}

// ---------------------------------------------------------------------------------------
// The room: same messages as before, now in one process on the box.

const THEMES = ['light', 'dark', 'nature', 'tech', 'rain', 'jungle', 'aurora'];
// "turn off the tv", "tv on", "switch the tv off" -> true/false; anything else null.
function powerFromSpeech(text) {
  const low = String(text).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(hey |ok |okay )?(can you |could you |please )?/, '').replace(/ please$/, '');
  const m = low.match(/^(?:turn|switch|power) (on|off) (?:the )?(?:tv|television)$/) || low.match(/^(?:turn |switch |power )?(?:the )?(?:tv|television) (on|off)$/);
  return m ? m[1] === 'on' : null;
}
// Spaces: sets of app cards (a filter on Home). Remembered on the box.
const SPACES = ['living', 'school', 'games'];
// "go to school", "switch to the games space", "living room"
function spaceFromSpeech(text) {
  const low = String(text).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = low.match(/^(?:(?:hey |ok |okay )?(?:can you |could you |please )?(?:go|switch|change|take me|move)(?: back)?(?: over)? to )?(?:the |my )?(living room|school|games?)(?: space| tab| apps)?(?: please)?$/);
  if (!m) return null;
  return m[1] === 'living room' ? 'living' : m[1].startsWith('game') ? 'games' : 'school';
}
const UI_FROM_REMOTE = new Set(['swipe', 'tap', 'back', 'pad', 'click', 'scroll', 'media', 'key', 'text', 'select', 'apps', 'apps.pick']);
if (!state.roku) state.roku = {};
const roku = new Roku(state.roku, {
  save, log,
  base: process.env.ROKU_URL,                     // tests: a mock Roku
  onChange: (st) => room.sendTo('remote', st),
});

const room = {
  socks: new Set(),
  lastState: null,
  pendingIntent: null,
  kbd: null, // a text box on the TV has focus: the phone shows its keyboard
  pairing: null, // { code, token, exp }
  extraTokens: new Map(), // handoff tokens (http page -> https page), token -> exp

  of(role) { return [...this.socks].filter((s) => s.info.role === role); },
  sendTo(role, msg) { for (const s of this.of(role)) s.send(msg); },
  broadcast(msg, except) { for (const s of this.socks) if (s !== except) s.send(msg); },
  presence() {
    const remotes = this.of('remote').map((s) => s.info.name || 'Phone');
    this.broadcast({ t: 'presence', remotes, tv: this.of('tv').length > 0, box: this.of('box').length > 0 });
    this.hintSoon();
  },

  // With no phone connected for 10 seconds, the TV shows a small pairing code in the corner,
  // so a phone that lost its pairing can always get back in.
  hintTimer: 0,
  hintShown: false,
  hintSoon() {
    clearTimeout(this.hintTimer);
    if (this.of('remote').length > 0) {
      if (this.hintShown) { this.hintShown = false; this.sendTo('tv', { t: 'pair.hint', code: null }); }
      return;
    }
    if (!this.of('tv').length) return;
    this.hintTimer = setTimeout(() => this.sendHint(), 10_000);
  },
  sendHint(force) {
    if ((!force && this.of('remote').length > 0) || !this.of('tv').length) return false;
    let p = this.pairing;
    if (!p || p.exp < Date.now() + 60_000) p = this.newPairing();
    this.hintShown = true;
    this.sendTo('tv', { t: 'pair.hint', code: p.code, url: `http://${HOST}/remote/#pair=${state.tv}.${p.token}`, expires: p.exp });
    // Codes last 10 minutes: refresh before it runs out.
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.sendHint(), Math.max(30_000, p.exp - Date.now() - 60_000));
    return true;
  },

  newPairing() {
    this.pairing = { code: pairCode(), token: rid(16), exp: Date.now() + PAIR_MINUTES * 60_000 };
    return this.pairing;
  },
  sendPairing(s) {
    let p = this.pairing;
    if (!p || p.exp < Date.now() + 60_000) p = this.newPairing();
    s.send({ t: 'pair', code: p.code, url: `http://${HOST}/remote/#pair=${state.tv}.${p.token}`, expires: p.exp });
  },
  claim(token, name) {
    const p = this.pairing;
    const handoff = this.extraTokens.get(token);
    if (handoff) {
      this.extraTokens.delete(token);
      if (handoff.exp < Date.now()) return null;
    } else if (!p || p.token !== token || p.exp < Date.now()) return null;
    const key = rid(16);
    const label = String(name || 'Phone').slice(0, 40);
    state.remotes[sha256(key)] = { name: label, added: Date.now() };
    save();
    if (!handoff) {
      this.newPairing(); // one code, one phone
      this.broadcast({ t: 'paired', name: label });
      if (this.hintShown) this.sendHint();
    }
    return { tv: state.tv, key, name: label };
  },

  join(s) {
    this.socks.add(s);
    s.send({ t: 'welcome', role: s.info.role, tv: state.tv });
    if (s.info.role === 'remote' && this.lastState) s.send(this.lastState);
    if (s.info.role === 'remote' && this.kbd) s.send(this.kbd);
    if (s.info.role === 'tv') {
      if (Object.keys(state.remotes).length === 0) this.sendPairing(s);
      if (state.theme) s.send({ t: 'theme', name: state.theme });
      s.send({ t: 'sounds', on: state.sounds !== false });
      s.send({ t: 'space', name: state.space || 'living' });
    }
    if (s.info.role === 'remote') {
      s.send({ t: 'sounds', on: state.sounds !== false });
      s.send({ t: 'space', name: state.space || 'living' });
      s.send(roku.status());
      s.send(games.status());   // a game is running: the phone becomes the controller
    }
    // The box agent drives the TV for voice requests with Claude: it gets the key over this local link.
    if (s.info.role === 'box') s.send({ t: 'agent.key', key: intentEnv().ANTHROPIC_API_KEY });
    s.onmessage = (raw) => this.message(s, raw).catch((e) => log('room error', e.message));
    s.onclose = () => { this.socks.delete(s); this.presence(); };
    this.presence();
  },

  async message(s, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const role = s.info.role;
    const tvUp = this.of('tv').length > 0;
    if (msg.t === 'ping') return s.send({ t: 'pong' });

    if (role === 'remote') {
      if (msg.t === 'hello') {
        if (msg.name) s.info.name = String(msg.name).slice(0, 40);
        return this.presence();
      }
      if (msg.t === 'home') return this.sendTo(tvUp ? 'tv' : 'box', msg);
      if (msg.t === 'voice') {
        this.sendTo('tv', msg);
        this.sendTo('box', msg);
        if (msg.phase === 'final' && msg.text) await this.speech(String(msg.text), tvUp);
        return;
      }
      if (msg.t === 'cancel') return this.broadcast(msg, s);
      if (msg.t === 'unpair') {
        delete state.remotes[s.info.keyHash];
        save();
        s.send({ t: 'unpaired' });
        return s.close(4001);
      }
      if (msg.t === 'pair.request') { this.newPairing(); for (const t of this.of('tv')) this.sendPairing(t); return; }
      if (msg.t === 'media' && msg.a === 'vol') return this.sendTo('box', msg);
      if (msg.t === 'nav') return this.sendTo('box', msg); // browser controls: always the box
      // Theme: remembered on the box too, so the TV page gets it even if it wasn't showing.
      if (msg.t === 'theme') {
        if (!THEMES.includes(msg.name)) return;
        if (state.theme !== msg.name) { state.theme = msg.name; save(); }
        return this.sendTo('tv', { t: 'theme', name: msg.name });
      }
      // UI sounds on the TV, on or off: remembered on the box like the theme.
      if (msg.t === 'sounds') {
        const on = !!msg.on;
        if (state.sounds !== on) { state.sounds = on; save(); }
        this.sendTo('tv', { t: 'sounds', on });
        return this.sendTo('remote', { t: 'sounds', on });
      }
      if (msg.t === 'space') return this.setSpace(msg.name);
      // The TV set itself (Roku): power, and which HDMI input the box is on.
      if (msg.t === 'tv.power') return roku.power(typeof msg.on === 'boolean' ? msg.on : undefined);
      if (msg.t === 'tv.setup') return roku.setup({ ip: msg.ip, hdmi: msg.hdmi });
      if (UI_FROM_REMOTE.has(msg.t)) return this.sendTo(tvUp ? 'tv' : 'box', msg);
      return;
    }
    if (role === 'tv') {
      if (msg.t === 'pair.request') return this.sendPairing(s);
      if (msg.t === 'space') return this.setSpace(msg.name);
      if (msg.t === 'open' || msg.t === 'control') return this.sendTo('box', msg);
      if (msg.t === 'state') {
        this.lastState = msg;
        if (THEMES.includes(msg.theme) && msg.theme !== state.theme) { state.theme = msg.theme; save(); } // picked on the TV
        // A search asked for while a service was showing: show it once Home has settled.
        if (msg.mode === 'home' && this.pendingIntent) {
          const pi = this.pendingIntent;
          this.pendingIntent = null;
          setTimeout(() => s.send(pi), 700);
        }
      }
      return this.sendTo('remote', msg);
    }
    if (role === 'box') {
      if (msg.t === 'state') { this.lastState = msg; return this.sendTo('remote', msg); }
      if (msg.t === 'toast') return this.sendTo('remote', msg);
      if (msg.t === 'agent') { this.sendTo('remote', msg); return this.sendTo('tv', msg); }
      if (msg.t === 'kbd.show') { this.kbd = msg; return this.sendTo('remote', msg); }
      if (msg.t === 'kbd.hide') { this.kbd = null; return this.sendTo('remote', msg); }
    }
  },

  // Switch the set of app cards on Home, on the TV and every phone.
  setSpace(name) {
    if (!SPACES.includes(name)) return;
    if ((state.space || 'living') !== name) { state.space = name; save(); }
    this.sendTo('tv', { t: 'space', name });
    this.sendTo('remote', { t: 'space', name });
  },

  async speech(text, tvUp) {
    const pw = powerFromSpeech(text);
    if (pw !== null) {
      roku.power(pw);
      return this.broadcast({ t: 'intent', kind: 'none', heard: text, say: pw ? 'Turning the TV on' : 'Turning the TV off' });
    }
    const sp = spaceFromSpeech(text);
    if (sp) {
      this.setSpace(sp);
      return this.broadcast({ t: 'intent', kind: 'none', heard: text, say: { living: 'Living room', school: 'School', games: 'Games' }[sp] });
    }
    const env = intentEnv();
    const intent = await parseIntent(text, env).catch(() => null);
    if (!intent) return this.broadcast({ t: 'intent', kind: 'none', say: "Sorry, I didn't catch that.", heard: text });
    log('heard:', JSON.stringify(text), '->', intent.kind, intent.service || '', intent.query || '');
    // With a Claude key, playing something, finding something, or any multi-step ask is done by the
    // voice driver on the box: it works the screen itself until it's playing. The TV and phone just show progress.
    if (env.ANTHROPIC_API_KEY && (intent.kind === 'play' || intent.kind === 'do' || intent.kind === 'search')) {
      this.sendTo('tv', { t: 'intent', kind: 'do', heard: text, say: intent.say || 'On it…', service: intent.service || '' });
      this.sendTo('remote', { t: 'intent', kind: 'do', heard: text, say: intent.say || 'On it…', service: intent.service || '' });
      this.sendTo('box', { t: 'agent.run', task: text, service: intent.service || '' });
      return;
    }
    if (intent.kind === 'do') return this.broadcast({ t: 'intent', kind: 'none', heard: text, say: 'Add a Claude key in ••• → Hands-free voice to do that.' });
    // Without a key, voice runs on simple word rules. Say once (per start of the box) how to get more.
    if (!env.ANTHROPIC_API_KEY && !this.keyTipShown && intent.kind !== 'control') {
      this.keyTipShown = true;
      setTimeout(() => {
        const tip = { t: 'agent', phase: 'fail', text: 'Add a Claude key in ••• → Hands-free voice for full voice control', tip: true };
        this.sendTo('remote', tip);
        this.sendTo('tv', tip);
      }, 2500);
    }
    const msg = { t: 'intent', heard: text, ...intent };
    if (tvUp) {
      this.broadcast(msg);
      if (intent.kind === 'control') this.sendTo('box', msg);
      return;
    }
    this.sendTo('remote', msg);
    if (intent.kind === 'search') { this.pendingIntent = msg; this.sendTo('box', { t: 'home' }); }
    else this.sendTo('box', msg);
  },
};

// ---------------------------------------------------------------------------------------
// HTTP

// DS games: the player, its sockets and /api/games (server/games.mjs).
const games = createGames({ ROOT, DIR, state, room, Sock, acceptWs, isLocal, sha256, log });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const PUBLIC = ['tv', 'remote', 'shared', 'term', 'themes', 'games'];

function send(res, status, body, type = 'application/json', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(data);
}
async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 10_000) break; }
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

function makeHandler(tls) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const cors = { 'access-control-allow-origin': '*' };
    try {
      // Phones should always use one address (tv.local): a phone's pairing is saved per address.
      // A visit by another name for the box (like tv.home) goes to tv.local instead. Numbers (IP) are left alone.
      const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      const want = HOST.replace(/:\d+$/, '').toLowerCase();
      if (host && host !== want && host !== 'localhost' && !/^[\d.]+$/.test(host) && !host.includes(':') && (req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api/')) {
        return send(res, 302, '', 'text/plain', { location: `${req.socket.encrypted ? 'https' : 'http'}://${HOST}${req.url}` });
      }
      if (p.startsWith('/api/games') && games.http(req, res, url)) return;
      if (p === '/api/health') return send(res, 200, { ok: true, secure: !!req.socket.encrypted }, 'application/json', cors);

      // The box agent (same machine only) gets the TV id + secret.
      if (p === '/api/tv/register' && req.method === 'POST') {
        if (!isLocal(req)) return send(res, 403, { error: 'only the box itself can do this' });
        return send(res, 200, { tv: state.tv, secret: state.secret });
      }
      if (p === '/api/pair/lookup' && req.method === 'POST') {
        const { code } = await body(req);
        const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (clean.length !== 6) return send(res, 400, { error: 'That code should be 6 letters and numbers.' });
        const pr = room.pairing;
        if (!pr || pr.code !== clean || pr.exp < Date.now()) return send(res, 404, { error: "That code didn't match. Check the code on the TV." });
        return send(res, 200, { tv: state.tv, token: pr.token });
      }
      if (p === '/api/pair/claim' && req.method === 'POST') {
        const b = await body(req);
        const r = b.tv === state.tv ? room.claim(String(b.token || ''), b.name) : null;
        if (!r) return send(res, 403, { error: 'This pairing code has expired. Show a new one on the TV and try again.' });
        return send(res, 200, r);
      }
      // A paired phone on plain http asks for a one-time link to the secure (https) address.
      if (p === '/api/pair/handoff' && req.method === 'POST') {
        const b = await body(req);
        if (!state.remotes[sha256(String(b.key || ''))]) return send(res, 403, { error: 'Not paired' });
        const token = rid(16);
        room.extraTokens.set(token, { exp: Date.now() + 5 * 60_000 });
        return send(res, 200, { url: `https://${HOST}/remote/#pair=${state.tv}.${token}` });
      }
      // The phone remote as a home-screen app. On iPhone the app gets its own storage, apart from
      // Safari, so it has to pair by itself. A paired Safari page asks for a one-time token, and the
      // app's manifest carries it, so the app's first launch pairs itself...
      if (p === '/api/pair/app' && req.method === 'POST') {
        const b = await body(req);
        if (b.tv !== state.tv || !state.remotes[sha256(String(b.key || ''))]) return send(res, 403, { error: 'Not paired' });
        const token = rid(16);
        room.extraTokens.set(token, { exp: Date.now() + 30 * 60_000 });
        return send(res, 200, { manifest: '/api/app/manifest?t=' + token });
      }
      if (p === '/api/app/manifest') {
        const t = String(url.searchParams.get('t') || '');
        const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'remote/manifest.webmanifest'), 'utf8'));
        const tok = room.extraTokens.get(t);
        if (/^[0-9a-f]+$/.test(t) && tok && tok.exp > Date.now()) m.start_url = `/remote/?app#pair=${state.tv}.${t}`;
        m.scope = '/remote/';
        m.icons = (m.icons || []).map((i) => ({ ...i, src: new URL(i.src, 'http://x/remote/').pathname }));
        return send(res, 200, m, 'application/manifest+json');
      }
      // ...and if that didn't happen, the app opens unpaired and asks the TV to show a code to type.
      if (p === '/api/pair/show' && req.method === 'POST') {
        const now = Date.now();
        if (now - (room.lastShow || 0) < 1000) return send(res, 200, { shown: true });
        room.lastShow = now;
        if (!Object.keys(state.remotes).length) return send(res, 200, { shown: true }); // the TV is on its pairing screen already
        return send(res, 200, { shown: room.sendHint(true) });
      }
      if (p === '/api/remote/check' && req.method === 'POST') {
        const b = await body(req);
        return send(res, 200, { paired: b.tv === state.tv && !!state.remotes[sha256(String(b.key || ''))] });
      }
      // The Claude API key, set from a paired phone. It stays on the box (settings.json); the phone
      // only ever sees whether one is set and its last 4 characters.
      if (p === '/api/settings/claude' && req.method === 'POST') {
        const b = await body(req);
        if (b.tv !== state.tv || !state.remotes[sha256(String(b.key || ''))]) return send(res, 403, { error: 'Pair this phone with the TV first.' });
        const cur = settings();
        if (b.read) return send(res, 200, keyInfo(cur.anthropicKey));
        const k = String(b.anthropicKey || '').trim();
        if (k && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return send(res, 400, { error: "That doesn't look like a Claude API key. It starts with sk-ant-." });
        if (k) {
          const works = await checkKey(k);
          if (works === false) return send(res, 400, { error: 'Anthropic turned that key down. Check it and try again.' });
        }
        cur.anthropicKey = k;
        writeSettings(cur);
        room.sendTo('box', { t: 'agent.key', key: k });
        log(k ? 'Claude key set from a phone' : 'Claude key removed from a phone');
        return send(res, 200, keyInfo(k));
      }
      if (p === '/api/secure') return send(res, 200, { https: !!tls, url: tls ? `https://${HOST}/remote/` : null, host: HOST }, 'application/json', cors);
      // The box's certificate authority, for the phone to trust once (iPhone: Settings asks to install it).
      if (p === '/tv-box.crt' || p === '/trust') {
        if (!tls) return send(res, 404, { error: 'HTTPS is off on this box' });
        const der = new crypto.X509Certificate(tls.ca).raw;
        return send(res, 200, der, 'application/x-x509-ca-cert', { 'content-disposition': 'attachment; filename="TV-box.crt"' });
      }

      if (p === '/' || p === '/remote') return send(res, 302, '', 'text/plain', { location: '/remote/' });
      if (p === '/tv') return send(res, 302, '', 'text/plain', { location: '/tv/' + url.search });

      // Static files.
      let rel = decodeURIComponent(p).replace(/^\/+/, '');
      if (rel.endsWith('/') || rel === '') rel += 'index.html';
      const top = rel.split('/')[0];
      const file = path.join(ROOT, rel);
      if (!PUBLIC.includes(top) || !file.startsWith(ROOT + path.sep) || rel.split('/').some((x) => x.startsWith('.'))) return send(res, 404, 'Not found', 'text/plain');
      fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, 'Not found', 'text/plain');
        send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
      });
    } catch (e) {
      log('request error', p, e.message);
      send(res, 500, { error: 'Something went wrong on the box.' });
    }
  };
}

// The Claude Code terminal page (/term/, shown full screen on the TV) talks to termd.mjs,
// which runs the terminal as the box's owner on 127.0.0.1:8090. Only the TV's own screen may
// open it: same machine, with the TV secret, from a page on the box. Phones and the network can't.
const TERM_PORT = Number(process.env.TERM_PORT || 8090);
function onTermUpgrade(req, socket, url) {
  const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  let originHost = '';
  try { originHost = new URL(req.headers.origin || '').hostname; } catch {}
  if (!isLocal(req) || !['127.0.0.1', 'localhost', '[::1]'].includes(originHost)) return reject(403, 'Not allowed');
  if (url.searchParams.get('tv') !== state.tv || (url.searchParams.get('k') || '') !== state.secret) return reject(403, 'Not allowed');
  acceptWs(req, socket);
  const ws = new Sock(socket, { role: 'term' });
  const up = net.connect(TERM_PORT, '127.0.0.1');
  const dec = new StringDecoder('utf8');
  let ok = false;
  up.setNoDelay(true);
  up.write(state.secret + '\n'); // queued first, ahead of anything the page sends
  up.on('connect', () => { ok = true; });
  up.on('data', (d) => { const s = dec.write(d); if (s) ws.send(s); });
  up.on('error', () => {
    if (!ok) ws.send("\r\n  Claude Code isn't running on the box yet.\r\n  Press Home and try again in a minute.\r\n");
  });
  up.on('close', () => ws.close());
  ws.onmessage = (msg) => {
    let m; try { m = JSON.parse(msg); } catch { return; }
    if (m && (m.t === 'in' || m.t === 'resize')) up.write(JSON.stringify(m) + '\n');
  };
  ws.onclose = () => up.destroy();
}

function onUpgrade(req, socket) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/games/ws' && String(req.headers.upgrade).toLowerCase() === 'websocket') return games.upgrade(req, socket, url);
  if (url.pathname === '/term/ws' && String(req.headers.upgrade).toLowerCase() === 'websocket') return onTermUpgrade(req, socket, url);
  if (url.pathname !== '/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket') return socket.destroy();
  const role = url.searchParams.get('role');
  const k = url.searchParams.get('k') || '';
  const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (url.searchParams.get('tv') !== state.tv) return reject(404, 'Unknown TV');
  let info;
  if (role === 'box' || role === 'tv') {
    if (k !== state.secret) return reject(403, 'Not allowed');
    info = { role };
  } else if (role === 'remote') {
    const h = sha256(k);
    if (!state.remotes[h]) return reject(403, 'Not paired');
    info = { role, name: state.remotes[h].name, keyHash: h };
  } else return reject(400, 'Bad role');
  acceptWs(req, socket);
  room.join(new Sock(socket, info));
}

// ---------------------------------------------------------------------------------------

const tls = process.env.NO_HTTPS ? null : ensureTls();
const handler = makeHandler(tls);
const h1 = http.createServer(handler);
h1.on('upgrade', onUpgrade);
roku.start();
h1.listen(HTTP_PORT, () => log(`TV box server on http://${HOST}${HTTP_PORT === 80 ? '' : ':' + HTTP_PORT}`));
if (tls) {
  const h2 = https.createServer({ cert: tls.cert, key: tls.key }, handler);
  h2.on('upgrade', onUpgrade);
  h2.listen(HTTPS_PORT, () => log(`and https://${HOST}${HTTPS_PORT === 443 ? '' : ':' + HTTPS_PORT}`));
}
process.on('unhandledRejection', (e) => log('unhandled:', e && e.message));
