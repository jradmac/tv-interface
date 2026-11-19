// Mario & Luigi. Mario's phone runs both Nintendo DS consoles (one thread each, see worker.js), linked
// inside the phone so the game's wireless timing holds. Luigi's phone sends its buttons through the
// relay server and gets Luigi's screens and sound back. The game file stays on the phones.
// Relay messages: text JSON, or binary with a kind byte:
//   3 Luigi -> Mario: buttons [3, 0, keysLo, keysHi, 0, touching, x, y]
//   5 Mario -> Luigi: screen JPEG [5, 1, 0 top | 1 bottom, ...jpeg]
//   6 Mario -> Luigi: sound, 16-bit stereo [6, 1, ...pcm]     7: data saver sound, 16-bit mono at half rate
//   9 Mario -> big screens: Mario's screen JPEG [9, ...jpeg]   10: Mario's sound [10, rate u32, ...16-bit stereo]
//   (only while a big-screen page from "Show on a big screen" is open; the relay says so with {t:'watchers'})
(function () {
  const $ = (id) => document.getElementById(id);
  const BIT = { a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9, x: 10, y: 11 };
  const K = { INPUT: 3, VIDEO: 5, AUDIO: 6, MONO: 7, SHOT: 9, SOUND: 10 };
  const DEFAULT_SERVER = 'https://tv-interface-production.up.railway.app';   // the Railway server; can be changed under "Server"

  const store = {
    get: (k, d = '') => { try { const v = localStorage.getItem('ml-' + k); return v == null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('ml-' + k, v); } catch {} },
  };
  let pid = store.get('pid'); if (!pid) { pid = Math.random().toString(36).slice(2, 12); store.set('pid', pid); }
  const server = () => (store.get('server') || (DEFAULT_SERVER.startsWith('http') ? DEFAULT_SERVER : '')).replace(/\/+$/, '');
  $('name').value = store.get('name');
  $('server').value = server();

  let toastT = 0;
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2400); }
  function status(text, sub, code, btn) {
    const el = $('status');
    if (text == null) { el.style.display = 'none'; return; }
    el.style.display = 'flex'; $('stext').textContent = text; $('ssub').textContent = sub || '';
    $('scode').textContent = code || ''; $('sbtn').hidden = !btn;
  }

  // ---- Home ---------------------------------------------------------------------------------
  $('serverLink').onclick = () => $('serverRow').classList.toggle('open');
  $('serverSave').onclick = () => { store.set('server', $('server').value.trim()); $('serverRow').classList.remove('open'); toast('Server saved'); };
  $('code').addEventListener('input', () => { $('code').value = $('code').value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
  function ready() {
    const n = $('name').value.trim().slice(0, 10);
    if (!n) { $('hmsg').textContent = 'Type your name first.'; $('name').focus(); return null; }
    if (!server()) { $('hmsg').textContent = 'Set the server address first (tap Server).'; $('serverRow').classList.add('open'); return null; }
    store.set('name', n); $('name').blur(); $('code').blur();
    return n;
  }
  $('startBtn').onclick = () => {
    const n = ready(); if (!n) return;
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = ''; const r = crypto.getRandomValues(new Uint8Array(4)); for (const b of r) code += abc[b % abc.length];
    begin('mario', n, code);
  };
  $('joinBtn').onclick = () => {
    const code = $('code').value.trim().toUpperCase();
    if (code.length !== 4) { $('hmsg').textContent = 'Type the 4-letter code from Mario’s phone.'; $('code').focus(); return; }
    const n = ready(); if (!n) return;
    begin('luigi', n, code);
  };

  // ---- Sound: a small queue of 16-bit stereo chunks, played at the phone's own rate ---------
  let actx = null, aq = [], aqFrames = 0, aOff = 0;
  function startAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      actx = new AC({ latencyHint: 'interactive' });
      const node = actx.createScriptProcessor(1024, 0, 2);
      node.onaudioprocess = (e) => {
        const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
        let i = 0;
        while (i < L.length && aq.length) {
          const c = aq[0], n = c.length >> 1;
          while (i < L.length && aOff < n) { L[i] = c[aOff * 2] / 32768; R[i] = c[aOff * 2 + 1] / 32768; i++; aOff++; }
          if (aOff >= n) { aq.shift(); aqFrames -= n; aOff = 0; }
        }
        for (; i < L.length; i++) { L[i] = 0; R[i] = 0; }
      };
      node.connect(actx.destination);
      actx.resume();
    } catch { actx = null; }
  }
  function playPcm(pcm) {
    if (!actx) return;
    const max = actx.sampleRate * 0.15;   // never let sound fall more than 0.15 s behind
    aq.push(pcm); aqFrames += pcm.length >> 1;
    while (aqFrames > max && aq.length > 1) { aqFrames -= (aq.shift().length >> 1) - aOff; aOff = 0; }
  }
  const rate = () => (actx ? actx.sampleRate : 48000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && actx && actx.state !== 'running') actx.resume().catch(() => {}); });

  // ---- The two screens: the game (top) big, the touch screen small; tap the small one to swap --
  const top = $('top'), bot = $('bot'), tctx = top.getContext('2d'), bctx = bot.getContext('2d');
  const tImg = tctx.createImageData(256, 192), bImg = bctx.createImageData(256, 192);
  let bottomBig = false;
  function setBig(bottom) {
    bottomBig = bottom;
    const big = bottom ? bot : top, small = bottom ? top : bot;
    $('screens').insertBefore(big, $('screens').firstChild); $('smallslot').insertBefore(small, $('smallslot').firstChild);
  }
  $('smallslot').addEventListener('click', () => setBig(!bottomBig));
  let shown = false;
  function firstPicture() { if (!shown) { shown = true; if (!waitingCode) status(null); } }
  function drawRaw(topBuf, botBuf) {
    tImg.data.set(new Uint8ClampedArray(topBuf)); tctx.putImageData(tImg, 0, 0);
    bImg.data.set(new Uint8ClampedArray(botBuf)); bctx.putImageData(bImg, 0, 0);
    firstPicture();
  }
  const decoding = [0, 0], drawn = [0, 0];
  function drawJpeg(which, buf) {
    if (decoding[which] > 1) return;   // behind: skip a picture
    decoding[which]++;
    createImageBitmap(new Blob([buf], { type: 'image/jpeg' })).then((bm) => {
      (which ? bctx : tctx).drawImage(bm, 0, 0); bm.close && bm.close(); firstPicture(); drawn[which]++;
    }).catch(() => {}).finally(() => decoding[which]--);
  }

  // ---- Buttons and the touch screen -----------------------------------------------------------
  let mask = 0, stylus = null, touchXY = null, stickMask = 0;
  const btnTouches = new Map();
  // ---- The joystick: lands under the left thumb, then reads the direction it's pushed --------------
  const zone = $('stickzone'), base = $('stickbase'), knob = $('knob');
  let stick = null;   // { id, x, y } where the thumb first landed
  const stickR = () => base.getBoundingClientRect().width / 2;
  function placeBase(x, y) {
    const z = zone.getBoundingClientRect();
    base.style.left = (x - z.left) + 'px'; base.style.top = (y - z.top) + 'px';
  }
  function moveStick(x, y) {
    const r = stickR();
    let dx = (x - stick.x) / r, dy = (y - stick.y) / r;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    knob.style.transform = `translate(${dx * r * 0.62}px, ${dy * r * 0.62}px)`;
    let m = 0;
    if (Math.min(1, len) >= 0.22) {
      if (dx > 0.3) m |= 1 << BIT.right;
      if (dx < -0.3) m |= 1 << BIT.left;
      if (dy < -0.5) m |= (1 << BIT.b) | (1 << BIT.up);   // up: jump (held = higher), and climb vines
      if (dy > 0.55) m |= 1 << BIT.down;                  // down: squat; in the air: ground pound
      if (Math.abs(dx) > 0.82) m |= 1 << BIT.y;          // pushed all the way sideways: run
    }
    base.classList.toggle('run', !!(m & (1 << BIT.y)));
    if (m !== stickMask) { stickMask = m; recompute(true); }
  }
  function releaseStick() {
    stick = null; stickMask = 0; knob.style.transform = ''; base.classList.remove('live', 'run');
    base.style.left = ''; base.style.top = ''; recompute(true);
  }
  function maskFor(t) {
    const el = document.elementFromPoint(t.clientX, t.clientY);
    if (!el) return 0;
    const b = el.closest('[data-b]'); return b ? 1 << BIT[b.dataset.b] : 0;
  }
  function paint() {
    document.querySelectorAll('[data-b]').forEach((el) => el.classList.toggle('on', !!(mask & (1 << BIT[el.dataset.b]))));
  }
  function recompute() {
    let m = stickMask; for (const v of btnTouches.values()) m |= v;
    if (shakeStep === 1) m &= ~(1 << BIT.y); else if (shakeStep === 2) m |= 1 << BIT.y;
    if (m !== mask) { mask = m; paint(); sendInput(); }
  }
  // Shake the phone to use the item (fireball etc.): a fresh press of Y, even while full tilt is already running (holding Y).
  // The app calls mlShake() from the phone's motion sensor; a browser can use the F key.
  let shakeStep = 0, shakeT = 0;
  window.mlShake = () => {
    if (!playing() || sheetOpen() || shakeStep) return false;
    shakeStep = 1; recompute();
    shakeT = setTimeout(() => { shakeStep = 2; recompute(); shakeT = setTimeout(() => { shakeStep = 0; recompute(); }, 130); }, 50);
    return true;
  };
  const sheetOpen = () => $('sheet').classList.contains('open');
  const playing = () => document.body.classList.contains('playing');
  const inside = (el, t) => { const r = el.getBoundingClientRect(); return t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom; };
  function screenPoint(t) { const r = bot.getBoundingClientRect(); return [Math.max(0, Math.min(255, Math.round((t.clientX - r.left) / r.width * 256))), Math.max(0, Math.min(191, Math.round((t.clientY - r.top) / r.height * 192)))]; }
  document.addEventListener('touchstart', (e) => {
    if (!playing() || sheetOpen()) return;
    if (e.target.closest && e.target.closest('.tool,#smallslot,#status')) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (stylus === null && bottomBig && inside(bot, t)) { stylus = t.identifier; touchXY = screenPoint(t); sendInput(); continue; }
      if (!stick && inside(zone, t) && !(t.target.closest && t.target.closest('[data-b],.tool'))) {
        stick = { id: t.identifier, x: t.clientX, y: t.clientY }; placeBase(t.clientX, t.clientY); base.classList.add('live'); moveStick(t.clientX, t.clientY); continue;
      }
      btnTouches.set(t.identifier, maskFor(t));
    }
    recompute();
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (!playing() || sheetOpen()) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === stylus) { touchXY = screenPoint(t); sendInput(); }
      else if (stick && t.identifier === stick.id) moveStick(t.clientX, t.clientY);
      else if (btnTouches.has(t.identifier)) btnTouches.set(t.identifier, maskFor(t));
    }
    recompute();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stylus) { stylus = null; touchXY = null; sendInput(); }
      if (stick && t.identifier === stick.id) releaseStick();
      btnTouches.delete(t.identifier);
    }
    recompute();
  };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
  // Mouse and keyboard, for trying it on a computer.
  let mouse = false;
  bot.addEventListener('mousedown', (e) => { if (bottomBig) { mouse = true; touchXY = screenPoint(e); sendInput(); } });
  addEventListener('mousemove', (e) => { if (mouse) { touchXY = screenPoint(e); sendInput(); } });
  addEventListener('mouseup', () => { if (mouse) { mouse = false; touchXY = null; sendInput(); } });
  const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', z: 'b', x: 'y', a: 'x', s: 'a', Enter: 'start', Shift: 'select' };
  addEventListener('keydown', (e) => { if (e.key === 'f' && !e.repeat) window.mlShake();
    const b = KEYS[e.key]; if (b && playing() && !e.repeat) { btnTouches.set('k' + b, 1 << BIT[b]); recompute(); e.preventDefault(); } });
  addEventListener('keyup', (e) => { const b = KEYS[e.key]; if (b) { btnTouches.delete('k' + b); recompute(); } });

  // ---- Menu ---------------------------------------------------------------------------------
  let role = '', myName = '', room = '', roomInfo = { host: null, guest: null }, statsBy = {}, lite = false;
  $('menuBtn').addEventListener('click', () => { $('sheet').classList.add('open'); btnTouches.clear(); if (stick) releaseStick(); recompute(); showWho(); });
  $('close').onclick = () => $('sheet').classList.remove('open');
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) $('sheet').classList.remove('open'); });
  async function shareCode() {
    const text = `Play Super Mario Bros. with me as Luigi! Open the Mario & Luigi app and type the code ${room}`;
    if (navigator.share) { try { await navigator.share({ title: 'Mario & Luigi', text }); return; } catch {} }
    try { await navigator.clipboard.writeText(room); toast('Code copied: ' + room); } catch { toast('The code is ' + room); }
  }
  $('shareBtn').onclick = shareCode; $('sbtn').onclick = shareCode;
  // "Show on a big screen": a link that opens Mario's screen, with sound, in any browser (TV, laptop).
  const watchBtn = $('shareBtn').cloneNode(false);
  watchBtn.id = 'watchBtn'; watchBtn.textContent = 'Show on a big screen'; watchBtn.hidden = true;
  $('shareBtn').after(watchBtn);
  const watchInfo = document.createElement('div');
  watchInfo.id = 'watchInfo'; watchInfo.hidden = true;
  watchInfo.style.cssText = 'font-size:13px;line-height:1.4;opacity:.8;text-align:center;word-break:break-all;user-select:text;-webkit-user-select:text;margin:2px 0 6px';
  watchBtn.after(watchInfo);
  const watchUrl = () => `${server()}/w/${room}?k=${wk}`;
  watchBtn.onclick = async () => {
    const url = watchUrl();
    watchInfo.hidden = false;
    watchInfo.innerHTML = `Open this in the TV or laptop browser:<br><b>${url.replace(/^https?:\/\//, '')}</b>`;
    if (navigator.share) { try { await navigator.share({ title: 'Mario & Luigi on the big screen', url }); return; } catch {} }
    try { await navigator.clipboard.writeText(url); toast('Big-screen link copied'); } catch {}
  };
  $('liteBtn').onclick = () => {
    lite = !lite; store.set('lite', lite ? 'on' : 'off'); paintLite();
    sendText({ t: 'lite', on: lite }); toast(lite ? 'Data saver on' : 'Data saver off');
  };
  const paintLite = () => { $('liteBtn').textContent = 'Data saver: ' + (lite ? 'on (uses less cell data)' : 'off'); };
  $('leave').onclick = () => { leaving = true; sendText({ t: 'leave' }); stopAll(); setTimeout(() => location.reload(), 500); };
  function showWho() {
    const rows = [];
    const h = roomInfo.host, g = roomInfo.guest;
    rows.push(`Room code: <b>${room}</b>`);
    if (role === 'mario' && watching) rows.push(`Big screen: showing on ${watching === 1 ? '1 screen' : watching + ' screens'}${watchSound ? ', with sound' : ''}`);
    rows.push(`Mario: ${h ? esc(h.name) + (h.away ? ' (reconnecting)' : '') : '—'}${role === 'mario' && statsBy[0] ? ` · ${statsBy[0].fps} fps` : ''}`);
    rows.push(`Luigi: ${g ? esc(g.name) + (g.away ? ' (reconnecting)' : '') : 'not here yet'}${role === 'mario' && statsBy[1] ? ` · ${statsBy[1].fps} fps` : ''}`);
    $('who').innerHTML = rows.join('<br>');
  }
  const esc = (s) => String(s).replace(/[<>&"]/g, '');

  // ---- Talking to the relay -------------------------------------------------------------------
  let ws = null, leaving = false, retry = 0, everOpen = false, waitingCode = false, wk = '', watching = 0, watchSound = false;
  function sendText(o) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch {} }
  const wsSend = (buf) => { if (ws && ws.readyState === 1 && ws.bufferedAmount < 2e6) ws.send(buf); };
  function connect() {
    const base = server().replace(/^http/, 'ws');
    const q = new URLSearchParams({ role: role === 'mario' ? 'host' : 'guest', room, name: myName, id: pid });
    if (role === 'mario') q.set('wk', wk);
    const s = new WebSocket(`${base}/ws?${q}`);
    s.binaryType = 'arraybuffer';
    ws = s;
    s.onopen = () => {
      retry = 0; everOpen = true;
      if (role === 'luigi') { sendText({ t: 'hello', rate: rate(), lite }); sendInput(); }
      else if (host) host.hello();
    };
    s.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'room') onRoom(m);
        else if (m.t === 'error') { leaving = true; status(m.msg, '', '', false); setTimeout(() => location.reload(), 3500); }
        else if (m.t === 'ended') { leaving = true; status('Mario ended the game', 'Back to the start in a moment…'); setTimeout(() => location.reload(), 3000); }
        else if (role === 'mario' && host) host.text(m);
        return;
      }
      const u = new Uint8Array(e.data);
      if (role === 'mario') { if (u[0] === K.INPUT && host) host.input(u); return; }
      if (u[0] === K.VIDEO) drawJpeg(u[2], u.subarray(3));
      else if (u[0] === K.AUDIO) playPcm(new Int16Array(e.data.slice(2)));
      else if (u[0] === K.MONO) { const m1 = new Int16Array(e.data.slice(2)), st = new Int16Array(m1.length * 4); for (let i = 0; i < m1.length; i++) st[4 * i] = st[4 * i + 1] = st[4 * i + 2] = st[4 * i + 3] = m1[i]; playPcm(st); }
    };
    s.onclose = () => {
      if (ws !== s || leaving) return;
      ws = null;
      if (!everOpen && retry >= 3) { leaving = true; status("Can't reach the server", 'Check your internet, or the server address on the start screen.'); setTimeout(() => location.reload(), 4000); return; }
      if (role === 'luigi') status('Reconnecting…'); else toast('Reconnecting to the server…');
      setTimeout(connect, Math.min(4000, 500 * ++retry));
    };
  }
  // The server may be asleep (free hosting): wake it first so the first connect doesn't time out.
  async function wake() {
    for (let i = 0; i < 40 && !leaving; i++) {
      try { const r = await fetch(server() + '/health', { cache: 'no-store' }); if (r.ok) return true; } catch {}
      if (i === 1) status('Waking up the server…', 'This takes up to a minute the first time today.');
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  function sendInput() {
    const keys = mask;
    if (role === 'mario') { host && host.localInput(keys, touchXY); return; }
    const b = new Uint8Array(8);
    b[0] = K.INPUT; b[2] = keys & 255; b[3] = keys >> 8;
    if (touchXY) { b[5] = 1; b[6] = touchXY[0]; b[7] = touchXY[1]; }
    wsSend(b);
  }

  function onRoom(m) {
    roomInfo = m;
    if (role === 'mario') {
      $('codeTag').textContent = m.guest ? '' : 'CODE ' + room;   // out of the way once Luigi is in
      if (m.guest && !m.guest.away) { if (waitingCode) { waitingCode = false; if (shown) status(null); toast(`${m.guest.name} joined as Luigi`); } }
      host && host.guest(m.guest);
    } else if (!m.host || m.host.away) { if (!shown) status('Waiting for Mario’s phone…'); }
    else if (!shown) status(`Joining ${m.host.name}’s game…`, 'Their phone is starting Luigi. This takes a few seconds.');
    if (sheetOpen()) showWho();
  }

  async function begin(r, n, code) {
    role = r; myName = n; room = code;
    document.body.classList.add('playing'); document.body.classList.toggle('luigi', role === 'luigi');
    startAudio();   // a tap is needed before a phone plays sound
    $('codeTag').textContent = role === 'mario' ? 'CODE ' + room : '';
    lite = role === 'luigi' && store.get('lite') === 'on'; paintLite(); $('liteBtn').hidden = role !== 'luigi';
    $('shareBtn').hidden = role !== 'mario'; watchBtn.hidden = role !== 'mario';
    if (role === 'mario') { const abc = 'abcdefghjkmnpqrstuvwxyz23456789'; wk = ''; for (const b of crypto.getRandomValues(new Uint8Array(6))) wk += abc[b % abc.length]; }
    if (role === 'mario') {
      waitingCode = true;
      status('Starting the game…', 'Keep this phone plugged in if you can: it runs the game for both of you.');
      host = createHost(); host.start();
    } else status('Connecting…');
    if (!(await wake())) { leaving = true; status("Can't reach the server", 'Check your internet, or the server address on the start screen.'); setTimeout(() => location.reload(), 5000); return; }
    connect();
  }

  // ---- Mario's phone: both consoles -------------------------------------------------------------
  let host = null;
  function stopAll() { if (host) { host.stop(); host = null; } }

  function idb() {
    return new Promise((res, rej) => { const r = indexedDB.open('mario-luigi', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function idbGet(key) { try { const db = await idb(); return await new Promise((res) => { const r = db.transaction('files').objectStore('files').get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); } catch { return null; } }
  async function idbPut(key, val) { try { const db = await idb(); await new Promise((res) => { const t = db.transaction('files', 'readwrite'); t.objectStore('files').put(val, key); t.oncomplete = res; t.onerror = res; }); } catch {} }

  function createHost() {
    const consoles = new Map();   // 0 Mario (this phone), 1 Luigi (streamed) -> { worker, lite }
    let rom = null, wasm = null, stopped = false, guestRate = 48000, guestLite = false, guestGone = 0;

    async function start() {
      try {
        const [r, w] = await Promise.all([
          fetch('nsmb-coop.nds').then((x) => { if (!x.ok) throw new Error('The game file is missing from the app'); return x.arrayBuffer(); }),
          WebAssembly.compileStreaming ? WebAssembly.compileStreaming(fetch('dsweb.wasm')).catch(() => null) : null,
        ]);
        rom = r; wasm = w;
      } catch (e) { status(e.message || 'Something went wrong', 'Close the app and try again.'); return; }
      if (stopped) return;
      spawn(0, myName);
      if (roomInfo.guest && !roomInfo.guest.away) spawn(1, roomInfo.guest.name);
    }
    function hello() { /* the relay says who's here with the room message */ }

    async function spawn(seat, name) {
      if (consoles.has(seat) || !rom) return;
      const mine = seat === 0;
      const c = { worker: null, lite: mine ? false : guestLite };
      consoles.set(seat, c);
      const saved = await idbGet('save-' + seat);
      if (stopped || consoles.get(seat) !== c) return;
      const w = new Worker('worker.js');
      c.worker = w;
      w.onmessage = (e) => onWorker(seat, c, e.data);
      w.onerror = (e) => status('The game stopped on this phone', String(e.message || ''));
      const romCopy = rom.slice(0), sav = saved ? saved.slice(0) : null;
      w.postMessage({ t: 'init', seat, name, rom: romCopy, sav, cheats: [], rate: mine ? rate() : guestRate, remote: !mine, lite: c.lite, wasm }, sav ? [romCopy, sav] : [romCopy]);
      for (const [s2, c2] of consoles) {
        if (s2 === seat || !c2.worker) continue;
        const ch = new MessageChannel();
        w.postMessage({ t: 'port', seat: s2, port: ch.port1 }, [ch.port1]);
        c2.worker.postMessage({ t: 'port', seat, port: ch.port2 }, [ch.port2]);
      }
      if (mine) { sendInput(); if (watching) w.postMessage({ t: 'map', on: true, mode: 'top' }); }
    }
    function retire(seat) {
      const c = consoles.get(seat); if (!c) return;
      consoles.delete(seat);
      if (c.worker) { c.worker.postMessage({ t: 'stop' }); setTimeout(() => c.worker.terminate(), 1500); }
      for (const c2 of consoles.values()) c2.worker && c2.worker.postMessage({ t: 'unport', seat });
    }
    function onWorker(seat, c, d) {
      const mine = seat === 0;
      if (d.t === 'frame') { if (mine) drawRaw(d.top, d.bot); }
      else if (d.t === 'audio') {
        if (mine) {
          // While a big screen plays the sound, this phone stays quiet so the two don't echo.
          if (watching && watchSound) { const b = new Uint8Array(5 + d.pcm.byteLength); b[0] = K.SOUND; new DataView(b.buffer).setUint32(1, rate(), true); b.set(new Uint8Array(d.pcm), 5); wsSend(b); }
          else playPcm(new Int16Array(d.pcm));
        }
        else if (c.lite) {   // data saver: one channel at half the rate
          const st = new Int16Array(d.pcm), m1 = new Int16Array(st.length >> 2);
          for (let i = 0; i < m1.length; i++) m1[i] = (st[4 * i] + st[4 * i + 1] + st[4 * i + 2] + st[4 * i + 3]) >> 2;
          const out = new Uint8Array(2 + m1.byteLength); out[0] = K.MONO; out[1] = 1; out.set(new Uint8Array(m1.buffer), 2); wsSend(out);
        } else { const b = new Uint8Array(2 + d.pcm.byteLength); b[0] = K.AUDIO; b[1] = 1; b.set(new Uint8Array(d.pcm), 2); wsSend(b); }
      } else if (d.t === 'jpeg') {
        if (mine) { if (d.which === 'map' && watching) { const j = new Uint8Array(d.buf), b = new Uint8Array(1 + j.length); b[0] = K.SHOT; b.set(j, 1); wsSend(b); } return; }
        const j = new Uint8Array(d.buf), b = new Uint8Array(3 + j.length); b[0] = K.VIDEO; b[1] = 1; b[2] = d.which === 'bot' ? 1 : 0; b.set(j, 3); wsSend(b);
      } else if (d.t === 'save') idbPut('save-' + seat, d.buf);
      else if (d.t === 'stats') statsBy[seat] = d;
      else if (d.t === 'error') status('The game could not start', d.msg);
    }
    function guest(g) {
      clearTimeout(guestGone);
      if (g && !g.away) spawn(1, g.name);
      // Luigi left (or lost the connection for good): stop Luigi's console after a moment.
      else if (!g) guestGone = setTimeout(() => retire(1), 3000);
    }
    function watchers(n, sound) {
      watching = Math.max(0, n | 0); watchSound = !!sound && watching > 0;
      const c = consoles.get(0); if (c && c.worker) c.worker.postMessage({ t: 'map', on: watching > 0, mode: 'top' });
      if (sheetOpen()) showWho();
    }
    function text(m) {
      if (m.t === 'watchers') { const was = watching; watchers(m.n, m.sound); if (watching > was) toast('Showing on the big screen'); return; }
      if (m.t === 'hello') { guestRate = Math.max(8000, Math.min(96000, Number(m.rate) || 48000)); guestLite = !!m.lite; const c = consoles.get(1); if (c && c.worker) { c.lite = guestLite; c.worker.postMessage({ t: 'lite', on: guestLite }); } }
      else if (m.t === 'lite') { guestLite = !!m.on; const c = consoles.get(1); if (c) { c.lite = guestLite; c.worker && c.worker.postMessage({ t: 'lite', on: guestLite }); } }
    }
    function input(u) {
      const c = consoles.get(1); if (!c || !c.worker) return;
      c.worker.postMessage({ t: 'input', keys: u[2] | (u[3] << 8), steer: 0, touch: u[5] ? [u[6], u[7]] : null });
    }
    function localInput(keys, t) { const c = consoles.get(0); if (c && c.worker) c.worker.postMessage({ t: 'input', keys, steer: 0, touch: t }); }
    function stop() { stopped = true; for (const seat of [...consoles.keys()]) retire(seat); }
    return { start, hello, guest, text, input, localInput, stop };
  }

  // The code stays on the screen until Luigi joins. Tap it to look at the game meanwhile (it's also in the corner).
  let codeHidden = false;
  $('status').addEventListener('click', (e) => { if (role === 'mario' && waitingCode && shown && e.target.id !== 'sbtn') { codeHidden = true; status(null); } });
  setInterval(() => {
    if (role === 'mario' && waitingCode && shown && !codeHidden) status('Waiting for Luigi', 'On the other phone: open Mario & Luigi, tap Join, and type', room, true);
  }, 1000);
  window.mlDebug = () => ({ role, room, roomInfo, stats: statsBy, drawn, audio: aqFrames, shown, wk, watching, watchSound });
})();
