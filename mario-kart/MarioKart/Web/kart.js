// Kart Party: Mario Kart DS for up to 4 players. The host's phone (in the app) runs every racer's DS, one
// thread each (see worker.js), linked inside the phone so the game's wireless timing holds. Friends join
// with a link in any browser (or the code in the app): their buttons and tilt go to the host through the
// relay server, and their own screens and sound come back. The game file never leaves the host's phone.
// Relay messages: text JSON, or binary with a kind byte and a seat byte (1-3 = the friend it's for/from):
//   3 friend -> host: buttons [3, seat, keysLo, keysHi, steer+128, touching, x, y]
//   5 host -> friend: screen JPEG [5, seat, 0 top | 1 bottom, ...jpeg]
//   6 host -> friend: sound, 16-bit stereo [6, seat, ...pcm]     7: data saver sound, 16-bit mono at half rate
(function () {
  const $ = (id) => document.getElementById(id);
  const BIT = { a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9, x: 10, y: 11 };
  const K = { INPUT: 3, VIDEO: 5, AUDIO: 6, MONO: 7 };
  const DEFAULT_SERVER = 'https://tv-interface-production.up.railway.app';   // the Railway server; can be changed under "Server"
  const COLORS = ['#E5483B', '#3F8FE5', '#F2B33D', '#3FAE49'];
  // Everything unlocked (all characters, karts, cups, Mirror). Action Replay codes; the save itself isn't changed.
  const CHEATS = [
    '92056E14 00004002', '12056E12 000020FF', 'D2000000 00000000',
    '92026C74 00002015', '12026C76 00002001', '12026C78 000046C0', '12026D40 00002001', '12026D42 000046C0',
    '12026D6A 00002001', '12026D6C 000046C0', '12026D94 00002001', '12026D96 000046C0', 'D2000000 00000000',
    '921189DA 00006831', '121189D6 00002001', '121189D8 000046C0', 'D2000000 00000000',
    '92056DBC 00002800', '12056DBE 000046C0', 'D2000000 00000000',
  ];

  const store = {
    get: (k, d = '') => { try { const v = localStorage.getItem('mk-' + k); return v == null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('mk-' + k, v); } catch {} },
  };
  let pid = store.get('pid'); if (!pid) { pid = Math.random().toString(36).slice(2, 12); store.set('pid', pid); }
  // Browser friend: the page opened from the host's invite link (<server>/kart/ABCD) in Safari or any browser.
  // It can only join (the host's phone runs the race in the app), and it talks to the server it came from.
  const webPlay = /^\/kart(\/|$)/.test(location.pathname) && /^https?:$/.test(location.protocol);
  const linkCode = webPlay ? ((location.pathname.match(/^\/kart\/([A-Za-z]{4})/) || [])[1] || '').toUpperCase() : '';
  const server = () => webPlay ? location.origin : (store.get('server') || DEFAULT_SERVER).replace(/\/+$/, '');
  $('name').value = store.get('name');
  $('server').value = server();
  if (webPlay) {
    document.body.classList.add('web');
    $('startBtn').hidden = true; $('serverLink').hidden = true;
    $('code').value = linkCode;
    $('blurb').textContent = linkCode
      ? `You're joining race ${linkCode}. Type your name and tap Join. Tip: Share › Add to Home Screen makes it full screen.`
      : 'Type the 4-letter code from the host’s phone and tap Join.';
  }

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
  $('startBtn').onclick = async () => {
    const n = ready(); if (!n) return;
    unlockSenses();
    // The game file must be in the app first (Jared supplies it; it's never downloaded or shared).
    let ok = false;
    try { ok = (await fetch('/rom', { method: 'HEAD', cache: 'no-store' })).ok; } catch {}
    if (!ok) { $('romRow').hidden = false; $('hmsg').textContent = 'First, pick your Mario Kart DS game file (.nds). The app keeps it, so this is only needed once.'; return; }
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = ''; for (const b of crypto.getRandomValues(new Uint8Array(4))) code += abc[b % abc.length];
    begin('host', n, code);
  };
  $('romPick').onclick = () => $('romFile').click();
  $('romFile').onchange = async () => {
    const f = $('romFile').files && $('romFile').files[0]; if (!f) return;
    if (f.size < 8e6 || f.size > 80e6) { $('hmsg').textContent = 'That file doesn’t look like a DS game. Pick the .nds file.'; return; }
    $('hmsg').textContent = 'Copying the game into the app…';
    try {
      const r = await fetch('/rom', { method: 'PUT', body: await f.arrayBuffer() });
      if (!r.ok) throw new Error();
      $('romRow').hidden = true; $('hmsg').textContent = 'Got it. Tap Start a race.';
    } catch { $('hmsg').textContent = 'Could not copy the file. Try again.'; }
  };
  $('joinBtn').onclick = () => {
    const code = $('code').value.trim().toUpperCase();
    if (code.length !== 4) { $('hmsg').textContent = 'Type the 4-letter code from the host’s phone.'; $('code').focus(); return; }
    const n = ready(); if (!n) return;
    unlockSenses();
    begin('guest', n, code);
  };

  // ---- Sound: a small queue of 16-bit stereo chunks, played at the phone's own rate ---------
  let actx = null, aq = [], aqFrames = 0, aOff = 0;
  function startAudio() {
    if (actx) return;
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

  // ---- The two screens: the race (top) big, the map/touch screen small; tap the small one to swap --
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

  // ---- Buttons, the steering stick and the touch screen ------------------------------------------
  let mask = 0, stylus = null, touchXY = null, stickMask = 0, autoGas = store.get('autogas') === 'on';
  const btnTouches = new Map();
  const zone = $('stickzone'), base = $('stickbase'), knob = $('knob');
  let stick = null;   // { id, x, y } where the thumb first landed
  const stickR = () => base.getBoundingClientRect().width / 2;
  function placeBase(x, y) { const z = zone.getBoundingClientRect(); base.style.left = (x - z.left) + 'px'; base.style.top = (y - z.top) + 'px'; }
  function moveStick(x, y) {
    const r = stickR();
    let dx = (x - stick.x) / r, dy = (y - stick.y) / r;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    knob.style.transform = `translate(${dx * r * 0.62}px, ${dy * r * 0.62}px)`;
    let m = 0;
    if (Math.min(1, len) >= 0.22) {
      if (dx > 0.35) m |= 1 << BIT.right;
      if (dx < -0.35) m |= 1 << BIT.left;
      if (dy < -0.55) m |= 1 << BIT.up;
      if (dy > 0.55) m |= 1 << BIT.down;
    }
    if (m !== stickMask) { stickMask = m; recompute(); }
  }
  function releaseStick() {
    stick = null; stickMask = 0; knob.style.transform = ''; base.classList.remove('live');
    base.style.left = ''; base.style.top = ''; recompute();
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
    // Auto gas: A stays held, except while braking (B) so you can back up.
    if (autoGas && playing() && !(m & (1 << BIT.b))) m |= 1 << BIT.a;
    if (m !== mask) { mask = m; paint(); sendInput(); }
  }
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
      else if (btnTouches.has(t.identifier)) btnTouches.set(t.identifier, maskFor(t));   // slide from GAS onto DRIFT
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
  // Mouse and keyboard, for playing on a computer.
  let mouse = false;
  bot.addEventListener('mousedown', (e) => { if (bottomBig) { mouse = true; touchXY = screenPoint(e); sendInput(); } });
  addEventListener('mousemove', (e) => { if (mouse) { touchXY = screenPoint(e); sendInput(); } });
  addEventListener('mouseup', () => { if (mouse) { mouse = false; touchXY = null; sendInput(); } });
  document.querySelectorAll('[data-b]').forEach((el) => {
    el.addEventListener('mousedown', () => { btnTouches.set('m', 1 << BIT[el.dataset.b]); recompute(); });
    el.addEventListener('mouseup', () => { btnTouches.delete('m'); recompute(); });
  });
  const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', x: 'a', z: 'b', s: 'r', a: 'l', c: 'x', d: 'y', Enter: 'start', Shift: 'select' };
  addEventListener('keydown', (e) => { const b = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key]; if (b && playing() && !sheetOpen() && !e.repeat) { btnTouches.set('k' + b, 1 << BIT[b]); recompute(); e.preventDefault(); } });
  addEventListener('keyup', (e) => { const b = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key]; if (b) { btnTouches.delete('k' + b); recompute(); } });

  // ---- Tilt the phone like a steering wheel (held sideways). Left is negative. --------------------
  const DEAD = 3, FULL = 26;
  let steer = 0, tiltOn = false, motionOk = false, steerSentAt = 0;
  const hasMotion = () => 'DeviceMotionEvent' in window && ('ontouchstart' in window);
  function unlockSenses() {   // iPhones ask for sound and motion once; this must run from a tap
    startAudio();
    if (store.get('tilt', 'on') === 'on' && hasMotion()) setTilt(true, false);
  }
  function setTilt(on, user) {
    if (on && !motionOk) {
      const go = () => { motionOk = true; addEventListener('devicemotion', onMotion); setTilt(true, user); };
      const ask = window.DeviceMotionEvent && DeviceMotionEvent.requestPermission;
      if (typeof ask === 'function') DeviceMotionEvent.requestPermission().then((r) => (r === 'granted' ? go() : toast('Motion is off: steer with the stick'))).catch(() => toast('Motion is off: steer with the stick'));
      else go();
      return;
    }
    tiltOn = on;
    document.body.classList.toggle('tilting', on);
    $('tiltBtn').classList.toggle('live', on);
    if (!on) setSteer(0);
    if (user) { store.set('tilt', on ? 'on' : 'off'); toast(on ? 'Tilt the phone to steer' : 'Steer with the stick'); }
  }
  function onMotion(e) {
    if (!tiltOn || sheetOpen()) return;
    const g = e.accelerationIncludingGravity; if (!g || g.x == null) return;
    if (Math.hypot(g.x, g.y) < 3) return setSteer(0);   // lying flat: no steering
    const t = Math.atan2(g.y, g.x), t0 = Math.abs(t) > Math.PI / 2 ? Math.PI : 0;
    let d = (t - t0) * 180 / Math.PI; if (d > 180) d -= 360; if (d < -180) d += 360;
    const a = Math.abs(d);
    setSteer(a < DEAD ? 0 : Math.sign(d) * Math.min(100, Math.round((a - DEAD) / (FULL - DEAD) * 100)));
  }
  function setSteer(v) {
    const fill = $('steerfill'); fill.style.width = Math.abs(v) / 2 + '%'; fill.style.left = v < 0 ? 50 - Math.abs(v) / 2 + '%' : '50%';
    const now = performance.now();
    if (v !== steer && (Math.abs(v - steer) >= 4 || v === 0 || Math.abs(v) === 100 || now - steerSentAt > 60)) { steer = v; steerSentAt = now; sendInput(); }
  }
  $('tiltBtn').addEventListener('click', () => { if (!hasMotion()) return toast('Tilt works on a phone'); setTilt(!tiltOn, true); });
  const paintGas = () => { $('gasBtn').classList.toggle('live', autoGas); };
  $('gasBtn').addEventListener('click', () => { autoGas = !autoGas; store.set('autogas', autoGas ? 'on' : 'off'); paintGas(); recompute(); toast(autoGas ? 'Auto gas on: you only steer' : 'Auto gas off: hold GAS'); });
  paintGas();

  // ---- Menu ---------------------------------------------------------------------------------
  let role = '', myName = '', room = '', mySeat = 0, roomInfo = { host: null, players: [] }, statsBy = {}, lite = false;
  $('menuBtn').addEventListener('click', () => { $('sheet').classList.add('open'); btnTouches.clear(); if (stick) releaseStick(); setSteer(0); recompute(); showWho(); });
  $('close').onclick = () => $('sheet').classList.remove('open');
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) $('sheet').classList.remove('open'); });
  async function shareCode() {
    const url = `${server()}/kart/${room}`;
    const text = `Race Mario Kart DS with me! Open this link in Safari (or any browser), turn your phone sideways and tap Join: ${url}\n\nHave the Kart Party app? Type the code ${room} instead.`;
    if (navigator.share) { try { await navigator.share({ title: 'Kart Party', text }); return; } catch {} }
    try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast('The code is ' + room); }
  }
  $('shareBtn').onclick = shareCode; $('sbtn').onclick = shareCode;
  $('liteBtn').onclick = () => {
    lite = !lite; store.set('lite', lite ? 'on' : 'off'); paintLite();
    sendText({ t: 'lite', on: lite }); toast(lite ? 'Data saver on' : 'Data saver off');
  };
  const paintLite = () => { $('liteBtn').textContent = 'Data saver: ' + (lite ? 'on (uses less cell data)' : 'off'); };
  $('leave').onclick = () => { leaving = true; sendText({ t: 'leave' }); stopAll(); setTimeout(() => location.reload(), 500); };
  const esc = (s) => String(s).replace(/[<>&"]/g, '');
  function racers() {
    const list = [];
    if (roomInfo.host) list.push({ seat: 0, name: roomInfo.host.name, away: roomInfo.host.away });
    for (const p of roomInfo.players || []) list.push(p);
    return list;
  }
  function showWho() {
    const rows = [`Race code: <b>${room}</b>`];
    for (let s = 0; s < 4; s++) {
      const p = racers().find((q) => q.seat === s);
      const tags = [s === mySeat ? 'you' : '', s === 0 ? 'runs the race' : '', p && p.away ? 'reconnecting' : ''].filter(Boolean).join(', ');
      const fps = role === 'host' && statsBy[s] ? ` · ${statsBy[s].fps} fps` : '';
      rows.push(`<span class="dot" style="background:${COLORS[s]}"></span>Player ${s + 1}: ${p ? esc(p.name) + (tags ? ` (${tags})` : '') + fps : 'open'}`);
    }
    $('who').innerHTML = rows.join('<br>');
  }

  // ---- Talking to the relay -------------------------------------------------------------------
  let ws = null, leaving = false, retry = 0, everOpen = false, waitingCode = false;
  function sendText(o) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch {} }
  const wsSend = (buf) => { if (ws && ws.readyState === 1 && ws.bufferedAmount < 2e6) ws.send(buf); };
  function connect() {
    const base = server().replace(/^http/, 'ws');
    const q = new URLSearchParams({ game: 'kart', role, room, name: myName, id: pid });
    const s = new WebSocket(`${base}/ws?${q}`);
    s.binaryType = 'arraybuffer';
    ws = s;
    s.onopen = () => {
      retry = 0; everOpen = true;
      if (role === 'guest') { sendText({ t: 'hello', rate: rate(), lite }); sendInput(); }
    };
    s.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'room') onRoom(m);
        else if (m.t === 'error') { leaving = true; status(m.msg, '', '', false); setTimeout(() => location.reload(), 3500); }
        else if (m.t === 'ended') { leaving = true; status('The host ended the race', 'Back to the start in a moment…'); setTimeout(() => location.reload(), 3000); }
        else if (role === 'host' && host) host.text(m);
        return;
      }
      const u = new Uint8Array(e.data);
      if (role === 'host') { if (u[0] === K.INPUT && host) host.input(u); return; }
      if (u[0] === K.VIDEO) drawJpeg(u[2], u.subarray(3));
      else if (u[0] === K.AUDIO) playPcm(new Int16Array(e.data.slice(2)));
      else if (u[0] === K.MONO) { const m1 = new Int16Array(e.data.slice(2)), st = new Int16Array(m1.length * 4); for (let i = 0; i < m1.length; i++) st[4 * i] = st[4 * i + 1] = st[4 * i + 2] = st[4 * i + 3] = m1[i]; playPcm(st); }
    };
    s.onclose = () => {
      if (ws !== s || leaving) return;
      ws = null;
      if (!everOpen && retry >= 3) { leaving = true; status("Can't reach the server", 'Check your internet, or the server address on the start screen.'); setTimeout(() => location.reload(), 4000); return; }
      if (role === 'guest') status('Reconnecting…'); else toast('Reconnecting to the server…');
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
    const keys = mask, st = tiltOn ? steer : 0;
    if (role === 'host') { host && host.localInput(keys, st, touchXY); return; }
    const b = new Uint8Array(8);
    b[0] = K.INPUT; b[1] = mySeat; b[2] = keys & 255; b[3] = keys >> 8; b[4] = (st + 128) & 255;
    if (touchXY) { b[5] = 1; b[6] = touchXY[0]; b[7] = touchXY[1]; }
    wsSend(b);
  }

  function onRoom(m) {
    roomInfo = m;
    if (m.you != null) {
      mySeat = m.you;
      document.documentElement.style.setProperty('--acc', COLORS[mySeat] || COLORS[0]);
      $('seatTag').textContent = 'P' + (mySeat + 1);
    }
    const friends = (m.players || []).filter((p) => !p.away);
    if (role === 'host') {
      $('codeTag').textContent = 'CODE ' + room;
      if (friends.length && waitingCode) { waitingCode = false; if (shown) status(null); }
      host && host.sync(m.players || []);
    } else if (!m.host || m.host.away) { if (!shown) status('Waiting for the host’s phone…'); }
    else if (!shown) status(`Joining ${m.host.name}’s race…`, 'Their phone is starting your DS. This takes a few seconds.');
    if (sheetOpen()) showWho();
  }

  async function begin(r, n, code) {
    role = r; myName = n; room = code; mySeat = 0;
    document.body.classList.add('playing'); document.body.classList.toggle('guest', role === 'guest');
    $('codeTag').textContent = role === 'host' ? 'CODE ' + room : '';
    lite = role === 'guest' && store.get('lite') === 'on'; paintLite(); $('liteBtn').hidden = role !== 'guest';
    recompute();
    if (role === 'host') {
      waitingCode = true;
      status('Starting the race…', 'This phone runs the race for everyone. Keep it plugged in if you can.');
      host = createHost(); host.start();
    } else status('Connecting…');
    if (!(await wake())) { leaving = true; status("Can't reach the server", 'Check your internet, or the server address on the start screen.'); setTimeout(() => location.reload(), 5000); return; }
    connect();
  }

  // ---- The host's phone: every racer's console ---------------------------------------------------
  let host = null;
  function stopAll() { if (host) { host.stop(); host = null; } }

  function idb() {
    return new Promise((res, rej) => { const r = indexedDB.open('kart-party', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function idbGet(key) { try { const db = await idb(); return await new Promise((res) => { const r = db.transaction('files').objectStore('files').get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); } catch { return null; } }
  async function idbPut(key, val) { try { const db = await idb(); await new Promise((res) => { const t = db.transaction('files', 'readwrite'); t.objectStore('files').put(val, key); t.oncomplete = res; t.onerror = res; }); } catch {} }
  // Game saves (times, ghosts, settings) go to files inside the app (/save/NAME); IndexedDB is a backup.
  async function loadSave(key) {
    try { const r = await fetch('/save/' + key, { cache: 'no-store' }); if (r.ok) { const b = await r.arrayBuffer(); if (b.byteLength) return b; } } catch {}
    return idbGet(key);
  }
  function storeSave(key, buf) { fetch('/save/' + key, { method: 'PUT', body: buf.slice(0) }).catch(() => {}); idbPut(key, buf); }
  document.addEventListener('visibilitychange', () => { if (document.hidden && host) host.flush(); });

  function createHost() {
    const consoles = new Map();   // seat 0 (this phone), 1-3 (friends, streamed) -> { worker, lite, rate }
    const gone = new Map();       // seat -> timer: a friend who left is retired after a moment
    const prefs = new Map();      // seat -> { rate, lite } from the friend's hello
    let rom = null, wasm = null, stopped = false, players = [];

    async function start() {
      try {
        const [r, w] = await Promise.all([
          fetch('/rom', { cache: 'no-store' }).then((x) => { if (!x.ok) throw new Error('The game file is missing from the app'); return x.arrayBuffer(); }),
          WebAssembly.compileStreaming ? WebAssembly.compileStreaming(fetch('dsweb.wasm')).catch(() => null) : null,
        ]);
        rom = r; wasm = w;
      } catch (e) { status(e.message || 'Something went wrong', 'Close the app and try again.'); return; }
      if (stopped) return;
      spawn(0, myName);
      sync(players);
    }

    async function spawn(seat, name) {
      if (consoles.has(seat) || !rom || stopped) return;
      const mine = seat === 0, pr = prefs.get(seat) || {};
      const c = { worker: null, lite: mine ? false : !!pr.lite };
      consoles.set(seat, c);
      const saved = await loadSave('save-' + seat);
      if (stopped || consoles.get(seat) !== c) return;
      const w = new Worker('worker.js');
      c.worker = w;
      w.onmessage = (e) => onWorker(seat, c, e.data);
      w.onerror = (e) => status('The race stopped on this phone', String(e.message || ''));
      const romCopy = rom.slice(0), sav = saved ? saved.slice(0) : null;
      w.postMessage({ t: 'init', seat, name, rom: romCopy, sav, cheats: CHEATS, rate: mine ? rate() : pr.rate || 48000, remote: !mine, lite: c.lite, wasm }, sav ? [romCopy, sav] : [romCopy]);
      // Link this console to every other one, directly (a pipe between their threads).
      for (const [s2, c2] of consoles) {
        if (s2 === seat || !c2.worker) continue;
        const ch = new MessageChannel();
        w.postMessage({ t: 'port', seat: s2, port: ch.port1 }, [ch.port1]);
        c2.worker.postMessage({ t: 'port', seat, port: ch.port2 }, [ch.port2]);
      }
      if (mine) sendInput();
      else toast(`${name} joined as player ${seat + 1}`);
    }
    function retire(seat) {
      const c = consoles.get(seat); if (!c) return;
      consoles.delete(seat);
      if (c.worker) { c.worker.postMessage({ t: 'stop' }); setTimeout(() => c.worker.terminate(), 1500); }
      for (const c2 of consoles.values()) c2.worker && c2.worker.postMessage({ t: 'unport', seat });
    }
    // The relay's list of friends: start a console for each new one, retire the ones who left.
    function sync(list) {
      players = list;
      if (!rom || stopped) return;
      const here = new Set();
      for (const p of list) {
        here.add(p.seat);
        clearTimeout(gone.get(p.seat)); gone.delete(p.seat);
        if (!p.away) spawn(p.seat, p.name);
      }
      for (const seat of consoles.keys()) if (seat !== 0 && !here.has(seat) && !gone.has(seat)) gone.set(seat, setTimeout(() => { gone.delete(seat); retire(seat); }, 3000));
    }
    function onWorker(seat, c, d) {
      const mine = seat === 0;
      if (d.t === 'frame') { if (mine) drawRaw(d.top, d.bot); }
      else if (d.t === 'audio') {
        if (mine) playPcm(new Int16Array(d.pcm));
        else if (c.lite) {   // data saver: one channel at half the rate
          const st = new Int16Array(d.pcm), m1 = new Int16Array(st.length >> 2);
          for (let i = 0; i < m1.length; i++) m1[i] = (st[4 * i] + st[4 * i + 1] + st[4 * i + 2] + st[4 * i + 3]) >> 2;
          const out = new Uint8Array(2 + m1.byteLength); out[0] = K.MONO; out[1] = seat; out.set(new Uint8Array(m1.buffer), 2); wsSend(out);
        } else { const b = new Uint8Array(2 + d.pcm.byteLength); b[0] = K.AUDIO; b[1] = seat; b.set(new Uint8Array(d.pcm), 2); wsSend(b); }
      } else if (d.t === 'jpeg') {
        if (mine) return;
        const j = new Uint8Array(d.buf), b = new Uint8Array(3 + j.length); b[0] = K.VIDEO; b[1] = seat; b[2] = d.which === 'bot' ? 1 : 0; b.set(j, 3); wsSend(b);
      } else if (d.t === 'save') storeSave('save-' + seat, d.buf);
      else if (d.t === 'stats') statsBy[seat] = d;
      else if (d.t === 'error') status('The race could not start', d.msg);
    }
    function text(m) {
      const seat = m.seat | 0; if (seat < 1 || seat > 3) return;
      if (m.t === 'hello') {
        prefs.set(seat, { rate: Math.max(8000, Math.min(96000, Number(m.rate) || 48000)), lite: !!m.lite });
        const c = consoles.get(seat); if (c && c.worker) { c.lite = !!m.lite; c.worker.postMessage({ t: 'lite', on: c.lite }); }
      } else if (m.t === 'lite') {
        const pr = prefs.get(seat) || {}; pr.lite = !!m.on; prefs.set(seat, pr);
        const c = consoles.get(seat); if (c) { c.lite = !!m.on; c.worker && c.worker.postMessage({ t: 'lite', on: c.lite }); }
      }
    }
    function input(u) {
      const c = consoles.get(u[1]); if (!u[1] || !c || !c.worker) return;
      c.worker.postMessage({ t: 'input', keys: u[2] | (u[3] << 8), steer: u[4] - 128, touch: u[5] ? [u[6], u[7]] : null });
    }
    function localInput(keys, st, t) { const c = consoles.get(0); if (c && c.worker) c.worker.postMessage({ t: 'input', keys, steer: st, touch: t }); }
    function flush() { for (const c of consoles.values()) c.worker && c.worker.postMessage({ t: 'save' }); }
    function stop() { stopped = true; for (const seat of [...consoles.keys()]) retire(seat); }
    return { start, sync, text, input, localInput, flush, stop };
  }

  // The code stays on the screen until a friend joins. Tap it to look at the game meanwhile (it's also in the corner).
  let codeHidden = false;
  $('status').addEventListener('click', (e) => { if (role === 'host' && waitingCode && shown && e.target.id !== 'sbtn') { codeHidden = true; status(null); } });
  setInterval(() => {
    if (role === 'host' && waitingCode && shown && !codeHidden) status('Invite up to 3 friends', 'Send them the link, or they type this code in Kart Party. Then everyone picks Multiplayer in the game.', room, true);
  }, 1000);
  window.kartDebug = () => ({ role, room, mySeat, roomInfo, stats: statsBy, drawn, audio: aqFrames, shown, steer, mask });
})();
