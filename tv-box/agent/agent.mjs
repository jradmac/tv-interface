#!/usr/bin/env node
// TV box agent. Runs on the Chromebox next to the kiosk Chrome.
//  - Gets the TV id + secret from the box server, keeps them in config.json.
//  - Keeps one WebSocket to the box server's room (role "box").
//  - Drives Chrome through its DevTools port on 127.0.0.1:9222: opens services, presses real keys,
//    moves a pointer, clicks, and runs small per-service helpers to start playback.
//  - Sets the box volume with pactl.
// The box server (server/server.mjs) runs on the same machine at http://127.0.0.1.
// No npm packages: Node 22+, or Node 20 with --experimental-websocket.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Driver } from './driver.mjs';

const DIR = process.env.TV_AGENT_DIR || '/var/lib/tv-agent';
const CONFIG = path.join(DIR, 'config.json');
const HOME_FILE = path.join(DIR, 'home-url');
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (typeof WebSocket === 'undefined') {
  console.error('This Node has no built-in WebSocket. Run with: node --experimental-websocket agent.js');
  process.exit(1);
}

// ---------------------------------------------------------------------------------------
// Services

const UA_TV = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36';

const SERVICES = {
  netflix: { name: 'Netflix', home: 'https://www.netflix.com/browse', hosts: ['netflix.com'] },
  youtube: { name: 'YouTube', home: 'https://www.youtube.com/tv', hosts: ['youtube.com', 'youtu.be'], dpad: true, ua: UA_TV },
  prime: { name: 'Prime Video', home: 'https://www.amazon.com/gp/video/storefront', hosts: ['primevideo.com', 'amazon.com'] },
  disney: { name: 'Disney+', home: 'https://www.disneyplus.com/home', hosts: ['disneyplus.com'] },
  max: { name: 'Max', home: 'https://play.max.com', hosts: ['max.com', 'hbomax.com'] },
  applemusic: { name: 'Apple Music', home: 'https://music.apple.com/us/home', hosts: ['music.apple.com'], music: true },
  spotify: { name: 'Spotify', home: 'https://open.spotify.com', hosts: ['spotify.com'], music: true },
  claude: { name: 'Claude', home: 'https://claude.ai', hosts: ['claude.ai'] },
  // School space.
  gdocs: { name: 'Google Docs', home: 'https://docs.google.com/document/u/0/', hosts: [], paths: ['docs.google.com/document'] },
  gsheets: { name: 'Google Sheets', home: 'https://docs.google.com/spreadsheets/u/0/', hosts: [], paths: ['docs.google.com/spreadsheets'] },
  learningsuite: { name: 'Learning Suite', home: 'https://learningsuite.byu.edu', hosts: ['learningsuite.byu.edu'] },
  // Claude Code in a terminal page served by the box (home is set once the box is registered).
  claudecode: { name: 'Claude Code', home: 'http://127.0.0.1/term/', hosts: [], term: true },
  // DS games: the box's own game page (/games/tv.html; ?tv=&k= are added once registered).
  soulsilver: { name: 'Pokémon SoulSilver', home: 'http://127.0.0.1/games/tv.html', game: 'pokemon-soulsilver-version', hosts: [], paths: ['127.0.0.1/games/', 'localhost/games/'] },
  // A general web browser. Any site that isn't one of the services above counts as Chrome.
  chrome: { name: 'Chrome', home: 'https://www.google.com', hosts: [], browser: true },
};

// youtube.com/watch?v=…, youtu.be/…, /shorts/…, or a playlist -> the same thing in YouTube's TV app.
// A playlist link alone starts at its first video. null for other YouTube pages (channels and such).
async function youtubeTvUrl(url) {
  const u = new URL(url);
  if (u.pathname.startsWith('/tv')) return url;
  let v = u.hostname === 'youtu.be' ? u.pathname.slice(1, 12) : u.pathname === '/watch' ? u.searchParams.get('v') || '' : '';
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
  if (m) v = m[1];
  const list = u.searchParams.get('list') || '';
  if (!v && list) {
    const html = await (await fetch('https://www.youtube.com/playlist?list=' + encodeURIComponent(list), { headers: { 'accept-language': 'en-US' }, signal: AbortSignal.timeout(6000) })).text();
    v = (html.match(/"videoId":"([\w-]{11})"/) || [])[1] || '';
  }
  if (!/^[\w-]{11}$/.test(v)) return null;
  return 'https://www.youtube.com/tv#/watch?v=' + v + (list ? '&list=' + encodeURIComponent(list) : '');
}

function serviceFor(url) {
  let host;
  let hp;
  try { const u = new URL(url); host = u.hostname; hp = host + u.pathname; } catch { return null; }
  // Docs and Sheets share a host, so they're told apart by path.
  for (const [k, s] of Object.entries(SERVICES)) if (s.paths && s.paths.some((p) => hp.startsWith(p))) return k;
  for (const [k, s] of Object.entries(SERVICES)) if (s.hosts.some((h) => host === h || host.endsWith('.' + h))) return k;
  return null;
}

// ---------------------------------------------------------------------------------------
// Config + registration

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

async function ensureRegistered() {
  const cfg = readConfig();
  const server = (process.env.TV_SERVER || cfg.server || 'http://127.0.0.1').replace(/\/+$/, '');
  if (!server) throw new Error(`No server set. Put {"server":"https://…"} in ${CONFIG} or set TV_SERVER.`);
  cfg.server = server;
  while (!cfg.tv || !cfg.secret) {
    try {
      const r = await fetch(server + '/api/tv/register', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      cfg.tv = j.tv;
      cfg.secret = j.secret;
      log('registered as TV', cfg.tv);
    } catch (e) {
      log('register failed, retrying in 5s:', e.message);
      await sleep(5000);
    }
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  const home = `${server}/tv/?tv=${cfg.tv}&k=${cfg.secret}`;
  // The Chrome start script waits for this file.
  if (!fs.existsSync(HOME_FILE) || fs.readFileSync(HOME_FILE, 'utf8').trim() !== home) fs.writeFileSync(HOME_FILE, home + '\n', { mode: 0o600 });
  SERVICES.claudecode.home = `${server}/term/?tv=${cfg.tv}&k=${cfg.secret}`;
  for (const s of Object.values(SERVICES)) if (s.game) s.home = `${server}/games/tv.html?g=${s.game}&tv=${cfg.tv}&k=${cfg.secret}`;
  return { ...cfg, home };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// Chrome DevTools

class CDP {
  constructor() {
    this.ws = null;
    this.id = 0;
    this.waiting = new Map();
    this.handlers = new Map();
    this.ready = null;
    // Pages Chrome shows, oldest first: the TV tab, then pop-up windows a site opened (e.g.
    // "Sign in with Google"). In the kiosk the newest one fills the screen, so we drive the last.
    this.stack = [];
    this.targetId = null;
  }

  get popup() { return this.stack.length > 1 && this.targetId !== this.stack[0]; }

  async pages() {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  }

  // Drive another page (a new pop-up, or back to the one under it).
  switchTo(id) {
    if (id === this.targetId) return this.ready;
    if (!this.stack.includes(id)) this.stack.push(id);
    const old = this.ws;
    this.ws = null; // so its close isn't taken as Chrome going away
    for (const [, w] of this.waiting) w.reject(new Error('switched page'));
    this.waiting.clear();
    try { old && old.close(); } catch {}
    this.ready = this.connect();
    return this.ready;
  }

  // Close the pop-up on screen; the page under it comes back.
  async closePopup() {
    if (!this.popup) return false;
    const id = this.targetId;
    this.stack = this.stack.filter((x) => x !== id);
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${id}`).catch(() => {});
    await this.switchTo(this.stack[this.stack.length - 1]);
    return true;
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  // Connect (or reconnect) to the kiosk's page.
  async connect() {
    for (;;) {
      try {
        const list = await this.pages();
        if (!list.length) throw new Error('no page yet');
        // The newest page we know that still exists; with none (Chrome restarted), start over.
        const alive = new Set(list.map((t) => t.id));
        this.stack = this.stack.filter((id) => alive.has(id));
        if (!this.stack.length) this.stack = [list[0].id];
        const page = list.find((t) => t.id === this.stack[this.stack.length - 1]);
        this.targetId = page.id;
        await new Promise((resolve, reject) => {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          ws.onopen = () => { this.ws = ws; resolve(); };
          ws.onerror = () => reject(new Error('DevTools socket error'));
          ws.onclose = () => {
            if (this.ws === ws) {
              this.ws = null;
              for (const [, w] of this.waiting) w.reject(new Error('closed'));
              this.waiting.clear();
              log('Chrome connection closed, reconnecting');
              this.ready = this.connect();
            }
          };
          ws.onmessage = (e) => this.onMessage(e.data);
        });
        log(this.popup ? 'switched to pop-up window' : 'connected to Chrome page', page.url.slice(0, 80));
        for (const fn of this.handlers.get('_connected') || []) await fn();
        return;
      } catch (e) {
        await sleep(1000);
      }
    }
  }

  onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id && this.waiting.has(m.id)) {
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
      return;
    }
    for (const fn of this.handlers.get(m.method) || []) {
      try { fn(m.params); } catch (e) { log('handler error', e.message); }
    }
  }

  async send(method, params = {}) {
    if (!this.ws) await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error(method + ' timed out')); }, 15000);
      this.waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

// ---------------------------------------------------------------------------------------
// Page overlay: a soft pointer and a toast bar, drawn inside whatever page is showing.
// Built with createElement/textContent only, so it works on pages with strict security rules.

const OVERLAY = `(() => {
  if (window.__tv) return;
  let root, dot, bar, hideDot = 0, hideBar = 0;
  function mount() {
    if (root && root.isConnected) return;
    root = document.createElement('div');
    Object.assign(root.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
    dot = document.createElement('div');
    Object.assign(dot.style, { position: 'absolute', width: '28px', height: '28px', margin: '-14px 0 0 -14px', borderRadius: '50%',
      background: 'rgba(255,255,255,.92)', boxShadow: '0 2px 12px rgba(0,0,0,.45)', opacity: '0', transition: 'opacity .25s' });
    bar = document.createElement('div');
    Object.assign(bar.style, { position: 'absolute', left: '50%', bottom: '56px', transform: 'translateX(-50%) translateY(12px)',
      maxWidth: '70%', padding: '16px 28px', borderRadius: '999px', background: 'rgba(255,255,255,.96)', color: '#1C1B19',
      font: '500 26px Inter, system-ui, sans-serif', boxShadow: '0 10px 40px rgba(0,0,0,.35)', opacity: '0',
      transition: 'opacity .3s, transform .3s', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    root.append(dot, bar);
    (document.body || document.documentElement).appendChild(root);
  }
  window.__tv = {
    cursor(x, y) {
      mount();
      dot.style.left = x + 'px'; dot.style.top = y + 'px'; dot.style.opacity = '1';
      clearTimeout(hideDot); hideDot = setTimeout(() => { dot.style.opacity = '0'; }, 2500);
    },
    toast(text, ms) {
      mount();
      bar.textContent = text; bar.style.opacity = '1'; bar.style.transform = 'translateX(-50%)';
      clearTimeout(hideBar);
      hideBar = setTimeout(() => { bar.style.opacity = '0'; bar.style.transform = 'translateX(-50%) translateY(12px)'; }, ms || 3000);
    },
  };
})()`;

// Tells the agent when a text box gets or loses focus, so the phone can pop up its keyboard.
const FOCUS_WATCH = `(() => {
  if (window.__tvFocus) return;
  window.__tvFocus = true;
  const deep = () => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };
  const isText = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !/^(button|submit|checkbox|radio|range|color|file|image|reset|hidden)$/i.test(el.type || '')));
  const report = (m) => { try { if (window.__tvKbd) window.__tvKbd(JSON.stringify(m)); } catch (e) {} };
  let shown = false;
  const check = () => {
    const el = deep();
    if (isText(el)) {
      const type = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : 'text';
      const lab = el.getAttribute('aria-label') || el.placeholder || (el.labels && el.labels[0] && el.labels[0].textContent) || el.name || el.id || '';
      report({ show: true, type, label: String(lab).trim().slice(0, 60), value: type === 'password' ? '' : String(el.value || el.textContent || '').slice(0, 200) });
      shown = true;
    } else if (shown) { report({ show: false }); shown = false; }
  };
  document.addEventListener('focusin', () => setTimeout(check, 0), true);
  document.addEventListener('focusout', () => setTimeout(check, 60), true);
  if (document.readyState !== 'loading') setTimeout(check, 0); else addEventListener('DOMContentLoaded', check);
})()`;

// Small helpers available to the per-service scripts below.
const PAGE_HELPERS = `(() => {
  if (window.__tvh) return;
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
  const center = (el) => { el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  window.__tvh = {
    vis, center,
    // First visible element for any of the selectors.
    find(sels) { for (const s of [].concat(sels)) { for (const el of document.querySelectorAll(s)) if (vis(el)) return el; } return null; },
    // A visible button or link whose words match.
    byText(re, scope) {
      const rx = new RegExp(re, 'i');
      for (const el of (scope || document).querySelectorAll('button, a, [role=button]')) {
        const t = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (rx.test(t) && vis(el)) return el;
      }
      return null;
    },
    video() { let best = null, area = 0; for (const v of document.querySelectorAll('video')) { const r = v.getBoundingClientRect(); if (r.width * r.height > area) { best = v; area = r.width * r.height; } } return best; },
  };
})()`;

// ---------------------------------------------------------------------------------------
// The agent

class Agent {
  constructor(cfg) {
    this.cfg = cfg;
    this.cdp = new CDP();
    this.relay = null;
    this.k = null; // service on screen, or null for our home
    this.url = '';
    this.view = { w: 1920, h: 1080 };
    this.ptr = { x: 960, y: 540 };
    this.job = 0; // bumps when a new open() starts, so an old helper stops
    this.uaSet = false;
    this.apiKey = ''; // Claude API key (from the TV server), for the voice driver
    // The voice driver may use the streaming services and Chrome, never Claude Code or claude.ai.
    this.driver = new Driver(this, Object.fromEntries(Object.entries(SERVICES).filter(([k]) => k !== 'claudecode' && k !== 'claude').map(([k, s]) => [k, s.name])));
  }

  async start() {
    this.cdp.on('_connected', () => this.onChrome());
    this.cdp.on('Page.frameNavigated', (p) => { if (!p.frame.parentId) this.onNavigated(p.frame.url); });
    this.cdp.on('Page.navigatedWithinDocument', (p) => this.onNavigated(p.url, true));
    this.cdp.on('Page.loadEventFired', () => this.measure());
    this.cdp.on('Runtime.bindingCalled', (p) => { if (p.name === '__tvKbd') this.onKbd(p.payload); });
    this.cdp.on('Page.javascriptDialogOpening', (p) => this.onDialog(p));
    this.cdp.on('Page.javascriptDialogClosed', () => { this.dialog = null; });
    this.cdp.ready = this.cdp.connect();
    await this.cdp.ready;
    this.connectRelay();
    // Watch for pop-up windows (sign-in windows and the like): they cover the TV page, so the
    // remote has to drive them, and go back to the page under them once they close.
    setInterval(() => this.watchPages().catch(() => {}), 1000);
  }

  async watchPages() {
    if (!this.cdp.ws || this.watching) return;
    this.watching = true;
    try {
      let list = await this.cdp.pages();
      // Extensions that Chrome Sync installs open welcome tabs ("Thanks for installing…") that take
      // over the screen. Close them, wherever they are, and go back to what was showing.
      const junk = list.filter((t) => t.id !== this.cdp.stack[0] && isOnboarding(t.url));
      if (junk.length && list.length > junk.length) {
        for (const t of junk) {
          log('closed an extension tab:', t.url.slice(0, 80));
          await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${t.id}`).catch(() => {});
        }
        const gone = new Set(junk.map((t) => t.id));
        list = list.filter((t) => !gone.has(t.id));
        this.cdp.stack = this.cdp.stack.filter((id) => !gone.has(id));
        if (!this.cdp.stack.length && list[0]) this.cdp.stack = [list[0].id];
        if (gone.has(this.cdp.targetId)) await this.cdp.switchTo(this.cdp.stack[this.cdp.stack.length - 1]);
        else await this.cdp.send('Page.bringToFront').catch(() => {});
        this.seen = new Set(list.map((t) => t.id));
        return;
      }
      const known = new Set(this.cdp.stack);
      const fresh = list.filter((t) => !known.has(t.id) && !(this.seen || new Set()).has(t.id));
      this.seen = new Set(list.map((t) => t.id));
      if (fresh.length) {
        const t = fresh[fresh.length - 1];
        log('pop-up window opened:', t.url.slice(0, 80));
        this.reloadedHome = true;
        await this.cdp.switchTo(t.id);
      } else if (!list.some((t) => t.id === this.cdp.targetId) && this.cdp.stack.length > 1) {
        log('pop-up window closed');
        this.cdp.stack = this.cdp.stack.filter((id) => id !== this.cdp.targetId);
        await this.cdp.switchTo(this.cdp.stack[this.cdp.stack.length - 1]);
      }
    } finally {
      this.watching = false;
    }
  }

  async onChrome() {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Network.enable').catch(() => {});
    await this.cdp.send('Runtime.addBinding', { name: '__tvKbd' }).catch(() => {});
    await this.blockPrompts();
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY + ';' + PAGE_HELPERS + ';' + FOCUS_WATCH });
    const cur = await this.cdp.eval('location.href').catch(() => '');
    // On a fresh Chrome, or one sitting on a blank page, show our home.
    if (this.cdp.popup) this.onNavigated(cur || 'about:blank'); // a pop-up: leave it where it is
    else if (!cur || cur.startsWith('about:') || cur.startsWith('chrome:') || cur.startsWith('data:')) await this.goHome();
    else if (this.isHome(cur) && !this.reloadedHome) {
      // The agent just (re)started, maybe after an update: load the newest TV page.
      this.reloadedHome = true;
      await this.cdp.send('Page.reload', { ignoreCache: true }).catch(() => {});
      this.onNavigated(cur);
    } else this.onNavigated(cur);
    await this.inject();
  }

  // No "Allow notifications?" or "Know your location?" prompts on the TV: the touchpad can't reach them.
  async blockPrompts() {
    const origins = new Set();
    for (const svc of Object.values(SERVICES)) {
      origins.add(new URL(svc.home).origin);
      for (const h of svc.hosts) { origins.add('https://' + h); origins.add('https://www.' + h); }
    }
    ['https://www.primevideo.com', 'https://open.spotify.com', 'https://accounts.spotify.com', 'https://music.apple.com', 'https://play.max.com', 'https://auth.max.com'].forEach((o) => origins.add(o));
    let n = 0;
    // Apply to the browser profile this page lives in.
    const info = await this.cdp.send('Target.getTargetInfo').catch(() => null);
    const ctx = info && info.targetInfo && info.targetInfo.browserContextId ? { browserContextId: info.targetInfo.browserContextId } : {};
    for (const origin of origins) {
      for (const name of ['notifications', 'geolocation']) {
        await this.cdp.send('Browser.setPermission', { origin, permission: { name }, setting: 'denied', ...ctx }).then(() => n++, () => {});
      }
    }
    log(`blocked notification and location prompts (${n} rules)`);
  }

  async inject() {
    await this.cdp.eval(OVERLAY + ';' + PAGE_HELPERS + ';' + FOCUS_WATCH).catch(() => {});
    await this.measure();
  }

  async measure() {
    const v = await this.cdp.eval('({ w: innerWidth, h: innerHeight })').catch(() => null);
    if (v && v.w) {
      this.view = v;
      this.ptr.x = Math.min(this.ptr.x, v.w - 1);
      this.ptr.y = Math.min(this.ptr.y, v.h - 1);
    }
  }

  isHome(url) {
    return url.startsWith(this.cfg.server + '/tv/');
  }
  isTerm(url) {
    return url.startsWith(this.cfg.server + '/term/');
  }

  onNavigated(url, sameDoc) {
    this.url = url;
    // A site that isn't a service: part of the service that led there (e.g. its sign-in page),
    // or Chrome when browsing.
    const k = this.isHome(url) ? null : this.isTerm(url) ? 'claudecode' : (serviceFor(url) || (this.openedK === 'chrome' || !this.k ? 'chrome' : this.k));
    if (!sameDoc && /^https?:/.test(url)) this.blockOrigin(url);
    const changed = k !== this.k;
    this.k = k;
    if (!sameDoc) {
      log('page:', url.replace(/[?#].*$/, ''));
      if (this.kbd) { this.kbd = null; this.sendRelay({ t: 'kbd.hide' }); }
    }
    // Within-page moves count too (YouTube's TV app changes only the #…), so the phone always knows the
    // exact page on screen and can save it as a Quick Add.
    if (changed || !sameDoc || url !== this.sentUrl) this.sendState();
  }

  onKbd(payload) {
    let m;
    try { m = JSON.parse(payload); } catch { return; }
    if (m.show) {
      this.kbd = { t: 'kbd.show', type: m.type || 'text', label: m.label || '', value: m.value || '' };
      this.sendRelay(this.kbd);
    } else if (this.kbd) {
      this.kbd = null;
      this.sendRelay({ t: 'kbd.hide' });
    }
  }

  async sendState() {
    if (this.isHome(this.url)) return; // the TV page reports its own state
    const k = this.k || 'chrome';
    const s = SERVICES[k];
    const h = await this.cdp.send('Page.getNavigationHistory').catch(() => null);
    const cur = h && h.entries[h.currentIndex];
    this.sentUrl = this.url;
    this.sendRelay({ t: 'state', mode: 'service', k, name: s.name, music: !!s.music, browser: !!s.browser, term: !!s.term, game: !!s.game,
      url: this.url, title: (cur && cur.title) || '', canBack: !!(h && h.currentIndex > 0), canForward: !!(h && h.currentIndex < h.entries.length - 1) });
  }

  // Deny notification / location prompts on any site the TV visits (nothing can answer them).
  async blockOrigin(url) {
    let origin;
    try { origin = new URL(url).origin; } catch { return; }
    this.blocked = this.blocked || new Set();
    if (this.blocked.has(origin)) return;
    this.blocked.add(origin);
    const info = await this.cdp.send('Target.getTargetInfo').catch(() => null);
    const ctx = info && info.targetInfo && info.targetInfo.browserContextId ? { browserContextId: info.targetInfo.browserContextId } : {};
    for (const name of ['notifications', 'geolocation']) {
      await this.cdp.send('Browser.setPermission', { origin, permission: { name }, setting: 'denied', ...ctx }).catch(() => {});
    }
  }

  // Browser controls from the phone: address/search, back, forward, reload.
  async nav(m) {
    const a = m.a;
    if (a === 'reload') return this.cdp.send('Page.reload').catch(() => {});
    if (a === 'back') return this.back();
    if (a === 'forward') {
      const h = await this.cdp.send('Page.getNavigationHistory');
      const next = h.entries[h.currentIndex + 1];
      if (next) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: next.id });
      return;
    }
    if (a === 'go') {
      const q = String(m.q || '').trim();
      if (!q) return;
      let url;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) url = q;
      else if (/^(localhost|[^\s/]+\.[a-z]{2,})(:\d+)?(\/\S*)?$/i.test(q)) url = 'https://' + q;
      else url = 'https://www.google.com/search?q=' + encodeURIComponent(q);
      if (!/^https?:/i.test(url)) return this.toast("That address can't be opened here.");
      this.job++;
      if (!this.k || serviceFor(url) === null) this.openedK = 'chrome';
      await this.navigate(url);
    }
  }

  // --- relay ---------------------------------------------------------------------------

  connectRelay(tries = 0) {
    const u = new URL(this.cfg.server.replace(/^http/, 'ws') + '/ws');
    u.searchParams.set('tv', this.cfg.tv);
    u.searchParams.set('role', 'box');
    u.searchParams.set('k', this.cfg.secret);
    u.searchParams.set('origin', this.cfg.server);
    const ws = new WebSocket(u);
    let ping = 0;
    ws.onopen = () => {
      tries = 0;
      this.relay = ws;
      log('relay connected');
      ping = setInterval(() => ws.readyState === 1 && ws.send('{"t":"ping"}'), 25000);
      this.sendState();
      if (this.kbd) this.sendRelay(this.kbd);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this.onRelay(m).catch((err) => log('error handling', m.t, err.message));
    };
    ws.onclose = (e) => {
      clearInterval(ping);
      if (this.relay === ws) this.relay = null;
      if (e.code === 1008 || e.code === 4003) log('relay refused this box. Delete', CONFIG, 'to register again.');
      const wait = Math.min(15000, 500 * 2 ** tries);
      log(`relay closed (${e.code}), retrying in ${Math.round(wait / 1000)}s`);
      setTimeout(() => this.connectRelay(tries + 1), wait);
    };
    ws.onerror = () => {};
  }

  sendRelay(msg) {
    if (this.relay && this.relay.readyState === 1) this.relay.send(JSON.stringify(msg));
  }

  // Pop-up boxes from a page (alert, confirm, "Leave site?") can't be reached with the touchpad.
  // "Leave site?" is always answered Leave; the others wait for OK (tap/Enter) or Back (cancel) on the phone.
  onDialog(p) {
    if (p.type === 'beforeunload') {
      log('page asked "Leave site?": leaving');
      this.cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      return;
    }
    this.dialog = p;
    log('page dialog:', p.type, String(p.message).slice(0, 80));
    const text = (p.message ? String(p.message).slice(0, 90) + ' · ' : '') + 'Tap for OK, Back to cancel';
    this.sendRelay({ t: 'toast', text });
  }

  async answerDialog(accept) {
    if (!this.dialog) return false;
    const p = this.dialog;
    this.dialog = null;
    await this.cdp.send('Page.handleJavaScriptDialog', { accept, ...(p.type === 'prompt' ? { promptText: p.defaultPrompt || '' } : {}) }).catch(() => {});
    return true;
  }

  async onRelay(m) {
    // While a pop-up box is open, the page is frozen: OK and Back answer the box first.
    if (this.dialog) {
      if (m.t === 'tap' || m.t === 'click' || (m.t === 'key' && m.key === 'Enter') || m.t === 'select') return this.answerDialog(true);
      if (m.t === 'back' || (m.t === 'key' && m.key === 'Escape')) return this.answerDialog(false);
      if (m.t === 'home' || m.t === 'open' || (m.t === 'intent' && (m.kind === 'play' || m.kind === 'open'))) await this.answerDialog(false);
    }
    // The person took over (or said stop): the voice driver stops.
    if (this.driver.busy && (USER_INPUT.has(m.t) || (m.t === 'voice' && m.phase === 'start'))) this.driver.stop(m.t === 'cancel' ? 'Stopped.' : '');
    switch (m.t) {
      case 'welcome': case 'pong': case 'presence': case 'cancel': return;
      case 'agent.key': this.apiKey = String(m.key || ''); return;
      case 'agent.run': return this.driver.start(m.task, this.apiKey);
      case 'open': return m.url ? this.openUrl(m.url) : this.open(m.k, m.query);
      case 'home': return this.goHome();
      case 'apps': return this.goHome(true); // Home, opening straight into the Apps grid
      case 'apps.pick': return this.open(m.k); // picked on the phone while a service was showing
      case 'nav': return this.nav(m);
      case 'back': return this.back();
      case 'intent': return this.onIntent(m);
      case 'voice':
        if (this.k && (m.phase === 'partial' || m.phase === 'final') && m.text) this.toast(m.text);
        else if (this.k && m.phase === 'start') this.toast('Listening…');
        return;
      case 'control': return this.control(m.control || m);
      case 'media': return this.media(m.a, m.v);
      case 'pad': return this.pad(m.dx, m.dy);
      case 'click': return this.click();
      case 'scroll': return this.wheel(m.dy);
      case 'key': return this.key(m.key, m.shift, m.ctrl);
      case 'text': return m.s && this.cdp.send('Input.insertText', { text: String(m.s) });
      case 'swipe':
        // In a service the main surface is a touchpad; on YouTube TV it's a D-pad.
        if (this.k && SERVICES[this.k].dpad) {
          if (m.phase === 'end') {
            const dx = m.dxTotal ?? m.dx ?? 0, dy = m.dyTotal ?? 0;
            if (Math.abs(dx) > 30 || Math.abs(dy) > 30) await this.key(Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'ArrowRight' : 'ArrowLeft') : (dy < 0 ? 'ArrowDown' : 'ArrowUp'));
          }
        } else if (m.phase !== 'end') await this.pad(m.dx || 0, m.dy || 0);
        return;
      case 'tap':
        return this.k && SERVICES[this.k].dpad ? this.key('Enter') : this.click();
    }
  }

  async onIntent(m) {
    const say = m.say || '';
    if (m.kind === 'play' || m.kind === 'open') {
      if (say) this.toast(say);
      return this.open(m.service, m.query);
    }
    if (m.kind === 'control') {
      if (say && this.k) this.toast(say, 1500);
      return this.control(m.control);
    }
    if (m.kind === 'none' && say && this.k) this.toast(say);
  }

  async control(c) {
    if (!c) return;
    switch (c.a) {
      case 'home': return this.k ? this.goHome() : undefined;
      case 'vol': return this.volume(c.v);
      case 'mute': return this.mute();
      default: return this.media(c.a, c.v);
    }
  }

  toast(text, ms) {
    this.cdp.eval(`window.__tv && __tv.toast(${JSON.stringify(String(text).slice(0, 120))}, ${ms || 3000})`).catch(() => {});
  }

  // --- navigation ------------------------------------------------------------------------

  async setUA(ua) {
    if (ua) { await this.cdp.send('Network.setUserAgentOverride', { userAgent: ua }).catch(() => {}); this.uaSet = true; }
    else if (this.uaSet) {
      const v = await this.cdp.send('Browser.getVersion').catch(() => null);
      if (v) await this.cdp.send('Network.setUserAgentOverride', { userAgent: v.userAgent.replace('HeadlessChrome', 'Chrome') }).catch(() => {});
      this.uaSet = false;
    }
  }

  async navigate(url, ua) {
    await this.setUA(ua);
    await this.cdp.send('Page.navigate', { url });
  }

  async goHome(apps) {
    while (await this.cdp.closePopup()) { /* Home closes pop-up windows first */ }
    this.job++;
    this.openedK = null;
    const from = (this.k ? '#from=' + this.k : '') + (apps ? (this.k ? '&apps' : '#apps') : '');
    await this.navigate(this.cfg.home + from);
  }

  async back() {
    // In a player, Esc first leaves full screen / the player.
    const full = await this.cdp.eval('!!document.fullscreenElement').catch(() => false);
    if (full) return this.key('Escape');
    if (this.k && SERVICES[this.k].dpad) return this.key('Escape');
    const h = await this.cdp.send('Page.getNavigationHistory');
    // In a pop-up window with nowhere to go back to: close it.
    if (this.cdp.popup && h.currentIndex < 1) return this.cdp.closePopup();
    const prev = h.entries[h.currentIndex - 1];
    if (!prev || this.isHome(prev.url) || prev.url.startsWith('about:')) return this.goHome();
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: prev.id });
  }

  // Find something on a service and start it. Resolves true when it started (best effort).
  async play(k, query, alive = () => true) {
    const s = SERVICES[k];
    if (!s) return false;
    const job = ++this.job;
    this.openedK = k;
    const live = () => job === this.job && alive();
    if (k === 'chrome') { await this.nav({ a: 'go', q: query }); return true; }
    const helper = HELPERS[k];
    if (!helper) { await this.navigate(s.home, s.ua); return false; }
    try { return !!(await helper.call(this, query, live)); } catch (e) { log(`${k} helper failed:`, e.message); return false; }
  }

  // A Quick Add: open that exact link. YouTube links open in YouTube's TV app (the one the remote drives),
  // straight into the video or playlist.
  async openUrl(url) {
    if (!/^https?:\/\//i.test(url)) return this.toast("That link can't be opened here.");
    const job = ++this.job;
    const k = serviceFor(url);
    this.openedK = k || 'chrome';
    log('open link', url.slice(0, 100));
    if (k === 'youtube') {
      const tv = await youtubeTvUrl(url).catch(() => null);
      if (job !== this.job) return;
      if (tv) return this.navigate(tv, UA_TV);
    }
    const s = k && SERVICES[k];
    return this.navigate(url, s && s.ua && k !== 'youtube' ? s.ua : undefined);
  }

  // Open a service, and if there's a query, find it and start it.
  async open(k, query) {
    const s = SERVICES[k];
    if (!s) return log('unknown service', k);
    const job = ++this.job;
    this.openedK = k;
    log('open', k, query ? `"${query}"` : '');
    if (k === 'chrome' && query) return this.nav({ a: 'go', q: query });
    const helper = HELPERS[k];
    if (!query || !helper) return this.navigate(s.home, s.ua);
    try {
      const ok = await helper.call(this, query, () => job === this.job);
      if (!ok && job === this.job) this.toast(`Couldn't start it automatically. Pick it on screen.`, 4000);
    } catch (e) {
      log(`${k} helper failed:`, e.message);
      if (job === this.job) this.toast(`Couldn't start it automatically. Pick it on screen.`, 4000);
    }
  }

  // Poll the page until fn (a JS expression) returns something truthy.
  async waitFor(expr, ms = 12000, alive = () => true) {
    const end = Date.now() + ms;
    while (Date.now() < end && alive()) {
      const v = await this.cdp.eval(`(() => { try { ${PAGE_HELPERS}; return (${expr}); } catch (e) { return null; } })()`).catch(() => null);
      if (v) return v;
      await sleep(400);
    }
    return null;
  }

  // Click the element an expression points at (expression must return an Element).
  async clickWhere(expr, ms, alive) {
    const pt = await this.waitFor(`(() => { const el = ${expr}; return el ? __tvh.center(el) : null; })()`, ms, alive);
    if (!pt) return false;
    await sleep(250);
    // Re-measure after scrolling into view.
    const p2 = (await this.cdp.eval(`(() => { ${PAGE_HELPERS}; const el = ${expr}; return el ? __tvh.center(el) : null; })()`).catch(() => null)) || pt;
    await this.mouseClick(p2.x, p2.y);
    return true;
  }

  // --- input -------------------------------------------------------------------------------

  async mouseClick(x, y) {
    this.ptr = { x, y };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async pad(dx = 0, dy = 0) {
    const speed = 2.2;
    this.ptr.x = Math.max(0, Math.min(this.view.w - 1, this.ptr.x + dx * speed));
    this.ptr.y = Math.max(0, Math.min(this.view.h - 1, this.ptr.y + dy * speed));
    const x = Math.round(this.ptr.x), y = Math.round(this.ptr.y);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    this.cdp.eval(`window.__tv && __tv.cursor(${x}, ${y})`).catch(() => {});
  }

  async click() {
    const x = Math.round(this.ptr.x), y = Math.round(this.ptr.y);
    this.cdp.eval(`window.__tv && __tv.cursor(${x}, ${y})`).catch(() => {});
    await this.mouseClick(x, y);
  }

  // Phone two-finger scroll: dy is page pixels, positive = further down. The wheel goes where the
  // pointer is, so whatever is under it scrolls (a Docs page, a Netflix row list). YouTube TV has
  // no scrolling, so there it steps the D-pad up or down instead.
  async wheel(dy = 0) {
    dy = Math.max(-1500, Math.min(1500, Number(dy) || 0));
    if (!dy) return;
    if (this.k && SERVICES[this.k].dpad) {
      this.wheelAcc = (this.wheelAcc || 0) + dy;
      while (Math.abs(this.wheelAcc) >= 180) {
        const down = this.wheelAcc > 0;
        this.wheelAcc -= down ? 180 : -180;
        await this.key(down ? 'ArrowDown' : 'ArrowUp');
      }
      return;
    }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(this.ptr.x), y: Math.round(this.ptr.y), deltaX: 0, deltaY: dy, pointerType: 'mouse' });
  }

  // key: a DOM key name (KEYS below) or one character. shift / ctrl: held down (Ctrl+C = key 'c', ctrl).
  async key(key, shift, ctrl) {
    key = String(key || '');
    // A Chrome bubble has the keyboard when the page itself doesn't have focus: send a real key.
    if (WTYPE && XKEY[key] && !ctrl) {
      const focused = await Promise.race([this.cdp.eval('document.hasFocus()').catch(() => true), sleep(400).then(() => true)]);
      if (focused === false && await realKey(key, shift)) return;
    }
    const k = KEYS[key] || (key.length === 1 ? { key, code: /[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /\d/.test(key) ? 'Digit' + key : '', vk: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!k) return log('unknown key', key);
    const text = ctrl ? undefined : k.text;
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: (shift ? 8 : 0) | (ctrl ? 2 : 0) };
    await this.cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text, unmodifiedText: text });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  // --- playback -----------------------------------------------------------------------------

  async media(a, v) {
    const k = this.k;
    if (a === 'vol') return this.volume(v);
    if (a === 'mute') return this.mute();
    if (!k) return;
    const s = SERVICES[k];
    if (s.music) return this.musicMedia(k, a);
    if (a === 'next') return this.nextEpisode(k);
    // Netflix and Prime listen for the keyboard; YouTube TV too.
    if (k === 'netflix' || k === 'prime' || k === 'youtube') {
      const map = { playpause: 'Space', pause: 'Space', play: 'Space', back10: 'ArrowLeft', fwd10: 'ArrowRight' };
      if (a === 'pause' || a === 'play') {
        // Only press if it would do what was asked.
        const paused = await this.cdp.eval(`(() => { ${PAGE_HELPERS}; const v = __tvh.video(); return v ? v.paused : null; })()`).catch(() => null);
        if (paused === null || (a === 'pause' && paused) || (a === 'play' && !paused)) return;
      }
      if (k === 'youtube' && s.dpad && (a === 'playpause' || a === 'pause' || a === 'play')) return this.key('Enter');
      return map[a] && this.key(map[a]);
    }
    // Anything else with a <video>.
    const js = {
      playpause: 'v.paused ? v.play() : v.pause()', pause: 'v.pause()', play: 'v.play()',
      back10: 'v.currentTime = Math.max(0, v.currentTime - 10)', fwd10: 'v.currentTime = v.currentTime + 10',
    }[a];
    if (js) await this.cdp.eval(`(() => { ${PAGE_HELPERS}; const v = __tvh.video(); if (v) { ${js}; } })()`).catch(() => {});
  }

  async musicMedia(k, a) {
    const sel = {
      spotify: {
        playpause: '[data-testid="control-button-playpause"]', play: '[data-testid="control-button-playpause"]', pause: '[data-testid="control-button-playpause"]',
        next: '[data-testid="control-button-skip-forward"]', back10: '[data-testid="control-button-skip-back"]', fwd10: '[data-testid="control-button-skip-forward"]',
      },
      applemusic: {},
    }[k] || {};
    if (sel[a]) {
      if (await this.clickWhere(`__tvh.find(${JSON.stringify(sel[a])})`, 1500)) return;
    }
    // By label: works on Apple Music and as a fallback on Spotify.
    const words = { playpause: '^(play|pause)$', play: '^play$', pause: '^pause$', next: '^(next|skip forward)', fwd10: '^(next|skip forward)', back10: '^(previous|skip back)' }[a];
    if (words) await this.clickWhere(`__tvh.byText(${JSON.stringify(words)}, document.querySelector('footer, [class*="playback-controls"], [data-testid="now-playing-bar"]') || document)`, 1500);
  }

  async nextEpisode(k) {
    if (k === 'youtube') return this.key('N', true);
    const words = '^(next episode|play next|next)';
    await this.clickWhere(`__tvh.find(['[data-uia="control-next"]', '[data-uia="next-episode-seamless-button"]']) || __tvh.byText(${JSON.stringify(words)})`, 2500);
  }

  volume(step = 10) {
    const n = Math.max(-50, Math.min(50, Math.round(Number(step) || 10)));
    execFile('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${n > 0 ? '+' : ''}${n}%`], (err) => {
      if (err) return log('volume:', err.message);
      execFile('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], (e2, out) => {
        const pct = (String(out).match(/(\d+)%/) || [])[1];
        if (pct) {
          if (this.k) this.toast(`Volume ${pct}%`, 1200);
          this.sendRelay({ t: 'toast', text: `Volume ${pct}%` });
        }
      });
    });
    // Keep it at or under 100%.
    execFile('sh', ['-c', 'v=$(pactl get-sink-volume @DEFAULT_SINK@ | grep -o "[0-9]*%" | head -1 | tr -d %); [ "${v:-0}" -gt 100 ] && pactl set-sink-volume @DEFAULT_SINK@ 100%'], () => {});
  }

  mute() {
    execFile('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle'], (err) => err && log('mute:', err.message));
  }
}

// Messages that mean the person is using the remote themselves.
const USER_INPUT = new Set(['home', 'apps', 'apps.pick', 'nav', 'back', 'open', 'swipe', 'tap', 'pad', 'click', 'scroll', 'key', 'text', 'select', 'cancel']);

// Real key presses into the TV screen (cage) with wtype, for Chrome's own bubbles ("Save password?",
// "Translate?") that CDP key events can't reach: those only go to the web page. The agent runs as
// the same user as the screen, so it can use the screen's Wayland socket directly.
const XKEY = { Enter: 'Return', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'space', ' ': 'space', Backspace: 'BackSpace' };
const WTYPE = ['/usr/bin/wtype', '/usr/local/bin/wtype'].find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
function waylandDisplay() {
  const dir = process.env.XDG_RUNTIME_DIR;
  if (!dir) return null;
  try { return fs.readdirSync(dir).filter((f) => /^wayland-\d+$/.test(f)).sort()[0] || null; } catch { return null; }
}
function realKey(name, shift) {
  const x = XKEY[name], disp = waylandDisplay();
  if (!WTYPE || !x || !disp) return Promise.resolve(false);
  const args = shift ? ['-M', 'shift', '-k', x, '-m', 'shift'] : ['-k', x];
  return new Promise((res) => execFile(WTYPE, args, { env: { ...process.env, WAYLAND_DISPLAY: disp }, timeout: 3000 }, (e) => {
    if (e) log('wtype:', e.message);
    res(!e);
  }));
}

// Tabs no one asked for: an extension's own pages, and the "you just installed us" pages they open.
function isOnboarding(url) {
  if (/^chrome-extension:\/\//.test(url)) return true;
  try {
    const u = new URL(url);
    return /(^|\/)(installed|welcome|onboarding|getting-started|post-install|thank-?you)(\/|$|\.html?)/i.test(u.pathname) && /(extension|chrome|install)/i.test(u.href);
  } catch { return false; }
}

const KEYS = {
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

// ---------------------------------------------------------------------------------------
// Per-service helpers: find `query` on the service and start it. Return true if playback started
// (or at least the right page is showing). `alive()` turns false when something newer was asked.

const HELPERS = {
  async netflix(q, alive) {
    await this.navigate('https://www.netflix.com/search?q=' + encodeURIComponent(q));
    // Profile screen first, if it shows.
    const gate = await this.waitFor(`document.querySelector('.profile-gate-container, .list-profiles') ? 'gate' : (document.querySelector('a[href*="/watch/"], a[href*="/title/"], .search-empty, .noResultsWrapper') ? 'ok' : null)`, 15000, alive);
    if (!alive()) return true;
    if (gate === 'gate') {
      const want = readConfig().netflixProfile || '';
      const pick = want
        ? `[...document.querySelectorAll('.profile-link, .profile-icon, [data-uia*="profile"]')].find(e => (e.textContent || '').trim().toLowerCase() === ${JSON.stringify(want.toLowerCase())})`
        : `__tvh.find(['a.profile-link', '.profile-icon', '[data-uia="action-select-profile+primary"]'])`;
      await this.clickWhere(pick, 5000, alive);
      await this.waitFor(`!document.querySelector('.profile-gate-container, .list-profiles')`, 8000, alive);
      if (!/\/search/.test(this.url)) await this.navigate('https://www.netflix.com/search?q=' + encodeURIComponent(q));
    }
    const id = await this.waitFor(`(() => {
      const a = [...document.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]')].find(__tvh.vis);
      return a ? (a.getAttribute('href').match(/\\/(?:watch|title)\\/(\\d+)/) || [])[1] : null; })()`, 15000, alive);
    if (!id || !alive()) return !!id;
    await this.navigate('https://www.netflix.com/watch/' + id);
    return true;
  },

  async prime(q, alive) {
    await this.navigate('https://www.amazon.com/gp/video/search?phrase=' + encodeURIComponent(q));
    const href = await this.waitFor(`(() => { const a = [...document.querySelectorAll('a[href*="/gp/video/detail/"], a[href*="/detail/"]')].find(__tvh.vis); return a ? a.href : null; })()`, 15000, alive);
    if (!href || !alive()) return !!href;
    await this.navigate(href);
    const played = await this.clickWhere(
      `__tvh.find(['[data-testid="play-button"]', '[data-automation-id="play-button"]', 'a[data-video-type="Feature"]', 'a[data-video-type="Episode"]']) || __tvh.byText('^(resume|play|watch now|continue watching|watch from beginning)')`,
      12000, alive);
    if (played) {
      // "Continue watching?" or "Watch from beginning?" dialogs.
      await sleep(2500);
      if (alive()) await this.clickWhere(`__tvh.byText('^(continue watching|resume|yes)')`, 2500, alive);
    }
    return played;
  },

  async youtube(q, alive) {
    // Find the first video id from YouTube's own results page, then open it in the TV player.
    let id = null;
    try {
      const html = await (await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q), { headers: { 'accept-language': 'en-US' } })).text();
      id = (html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/) || html.match(/"videoId":"([\w-]{11})"/) || [])[1] || null;
    } catch (e) {
      log('youtube lookup failed:', e.message);
    }
    if (!alive()) return true;
    if (id) {
      await this.navigate('https://www.youtube.com/tv#/watch?v=' + id, UA_TV);
      return true;
    }
    await this.navigate('https://www.youtube.com/tv#/search?q=' + encodeURIComponent(q), UA_TV);
    return false;
  },

  async spotify(q, alive) {
    await this.navigate('https://open.spotify.com/search/' + encodeURIComponent(q));
    return this.clickWhere(
      `(() => { const card = document.querySelector('[data-testid="top-result-card"]'); return (card && (card.querySelector('[data-testid="play-button"]') || card)) || __tvh.find('[data-testid="play-button"]'); })()`,
      15000, alive);
  },

  async applemusic(q, alive) {
    await this.navigate('https://music.apple.com/us/search?term=' + encodeURIComponent(q));
    // Hover the top result so its play button shows, then press it.
    const top = await this.waitFor(`(() => { const el = __tvh.find(['[data-testid="top-search-result"]', '.top-search-lockup', '[data-testid="grid"] li', 'ul[class*="shelf"] li']); return el ? __tvh.center(el) : null; })()`, 15000, alive);
    if (!top || !alive()) return !!top;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: top.x, y: top.y });
    await sleep(400);
    return this.clickWhere(`__tvh.find(['[data-testid="play-button"]', 'button.play-button', 'button[aria-label="Play"]']) || __tvh.byText('^play')`, 4000, alive);
  },

  async disney(q, alive) {
    return typeSearch.call(this, 'https://www.disneyplus.com/search', q, alive, ['input[type="search"]', '#search-input', 'input[name="q"]'],
      `[...document.querySelectorAll('a[href*="/entity-"], a[href*="/movies/"], a[href*="/series/"], a[href*="/browse/entity"]')].find(__tvh.vis)`);
  },

  async max(q, alive) {
    return typeSearch.call(this, 'https://play.max.com/search', q, alive, ['input[type="search"]', 'input[aria-label*="Search" i]', 'input'],
      `[...document.querySelectorAll('a[href*="/show/"], a[href*="/movie/"], a[href*="/video/"]')].find(__tvh.vis)`);
  },
};

// Services without a search address: type into their search box, open the first result, press Play.
async function typeSearch(url, q, alive, inputs, firstResult) {
  await this.navigate(url);
  const ok = await this.clickWhere(`__tvh.find(${JSON.stringify(inputs)})`, 15000, alive);
  if (!ok || !alive()) return false;
  await this.cdp.send('Input.insertText', { text: q });
  const opened = await this.clickWhere(firstResult, 10000, alive);
  if (!opened || !alive()) return opened;
  return this.clickWhere(`__tvh.byText('^(play|resume|continue|watch)')`, 10000, alive);
}

// ---------------------------------------------------------------------------------------

// Send sound to the TV: pick an HDMI output as the default once audio is up.
function preferHdmi(tries = 0) {
  if (readConfig().preferHdmi === false) return;
  execFile('pactl', ['list', 'short', 'sinks'], (err, out) => {
    if (err) return tries < 20 && setTimeout(() => preferHdmi(tries + 1), 3000);
    const hdmi = String(out).split('\n').map((l) => l.split('\t')[1]).find((n) => n && /hdmi/i.test(n));
    if (!hdmi) return tries < 20 && setTimeout(() => preferHdmi(tries + 1), 3000);
    execFile('pactl', ['set-default-sink', hdmi], (e) => log(e ? 'could not pick HDMI sound: ' + e.message : 'sound goes to ' + hdmi));
  });
}

process.on('unhandledRejection', (e) => log('unhandled:', e && e.message));

const cfg = await ensureRegistered();
log('TV', cfg.tv, 'server', cfg.server);
preferHdmi();
await new Agent(cfg).start();
