// The phone as the DS: the bottom screen (live, touchable) with the buttons around it.
(() => {
  const $ = (id) => document.getElementById(id);
  let creds = null;
  try { creds = JSON.parse(localStorage.getItem('tv-remote') || 'null'); } catch {}
  if (!creds || !creds.key) { location.replace('/remote/'); return; }

  const BIT = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11 };
  const canvas = $('screen'), ctx = canvas.getContext('2d', { alpha: false });
  const img = ctx.createImageData(256, 192), px32 = new Uint32Array(img.data.buffer);
  const LUT = new Uint32Array(65536);
  for (let c = 0; c < 65536; c++) {
    const r = ((c >> 11) << 3) | (c >> 13), g = (((c >> 5) & 63) << 2) | ((c >> 9) & 3), b = ((c & 31) << 3) | ((c >> 2) & 7);
    LUT[c] = 0xFF000000 | (b << 16) | (g << 8) | r;
  }
  let frame = null;   // the current bottom screen, RGB565

  // ---- Link ---------------------------------------------------------------------------
  let ws = null, title = 'Game', alive = 0, queue = Promise.resolve();
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const p = new URLSearchParams({ role: 'pad', tv: creds.tv, k: creds.key });
    const s = new WebSocket(`${proto}//${location.host}/games/ws?${p}`);
    ws = s; s.binaryType = 'arraybuffer';
    s.onopen = () => { alive = Date.now(); sendMask(true); };
    s.onmessage = (e) => {
      alive = Date.now();
      if (typeof e.data !== 'string') { const d = e.data; queue = queue.then(() => bottom(d)).catch(() => send({ t: 'key' })); return; }
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'game') {
        if (!m.running) return leaveToRemote();
        title = m.title || 'Game'; $('gtitle').textContent = title; document.title = title;
      } else if (m.t === 'slots') renderSlots(m.slots);
      else if (m.t === 'toast') toast(m.text);
      else if (m.t === 'view') showView(m.mode);
    };
    s.onclose = () => { if (ws === s) { ws = null; $('wait').style.display = ''; $('wait').textContent = 'Reconnecting…'; setTimeout(connect, 800); } };
  }
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  setInterval(() => {
    send({ t: 'ping' });
    if (ws && alive && Date.now() - alive > 8000) { const s = ws; ws = null; s.close(); connect(); }   // went quiet (phone slept)
  }, 3000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (!ws) connect(); else send({ t: 'key' }); } });

  async function bottom(buf) {
    const head = new Uint8Array(buf, 0, 2);
    if (head[0] !== 4) return;
    const stream = new Blob([new Uint8Array(buf, 4)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const data = new Uint16Array(await new Response(stream).arrayBuffer());
    if (head[1] === 1 || !frame) { if (head[1] !== 1) throw new Error('need a whole frame'); frame = data; }
    else for (let i = 0; i < data.length; i++) frame[i] ^= data[i];
    for (let i = 0; i < frame.length; i++) px32[i] = LUT[frame[i]];
    ctx.putImageData(img, 0, 0);
    $('wait').style.display = 'none';
  }

  function leaveToRemote() { try { ws && ws.close(); } catch {} ws = null; location.replace('/remote/'); }

  // ---- Buttons: every finger is checked against every button, so you can roll between them ----
  const dpad = $('dpad');
  let mask = 0, sent = -1;
  function sendMask(force) { if (mask !== sent || force) { sent = mask; send({ t: 'btn', mask }); } }
  function dirAt(el, x, y) {
    const r = el.getBoundingClientRect(), dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < r.width * 0.12) return 0;
    const a = Math.atan2(dy, dx) * 180 / Math.PI;   // 0 = right, 90 = down
    let m = 0;
    if (a > -67.5 && a < 67.5) m |= 1 << BIT.right;
    if (a > 22.5 && a < 157.5) m |= 1 << BIT.down;
    if (a > 112.5 || a < -112.5) m |= 1 << BIT.left;
    if (a > -157.5 && a < -22.5) m |= 1 << BIT.up;
    return m;
  }
  const btnTouches = new Map();   // touch id -> mask
  function maskFor(t) {
    const el = document.elementFromPoint(t.clientX, t.clientY);
    if (!el) return 0;
    const d = el.closest('#dpad');
    if (d) return dirAt(d, t.clientX, t.clientY);
    const b = el.closest('[data-b]');
    return b ? 1 << BIT[b.dataset.b] : 0;
  }
  function paint() {
    document.querySelectorAll('[data-b]').forEach((el) => el.classList.toggle('on', !!(mask & (1 << BIT[el.dataset.b]))));
    dpad.classList.toggle('on-u', !!(mask & (1 << BIT.up))); dpad.classList.toggle('on-d', !!(mask & (1 << BIT.down)));
    dpad.classList.toggle('on-l', !!(mask & (1 << BIT.left))); dpad.classList.toggle('on-r', !!(mask & (1 << BIT.right)));
  }
  function recompute() {
    let m = 0; for (const v of btnTouches.values()) m |= v;
    if (m !== mask) { mask = m; sendMask(); paint(); }
  }

  // ---- The touch screen ------------------------------------------------------------------
  let stylus = null, lastSend = 0;
  function screenPoint(t) {
    const r = canvas.getBoundingClientRect();
    return { x: (t.clientX - r.left) / r.width * 256, y: (t.clientY - r.top) / r.height * 192 };
  }
  function onScreen(t) { const r = canvas.getBoundingClientRect(); return t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom; }

  const sheetOpen = () => $('sheet').classList.contains('open');
  document.addEventListener('touchstart', (e) => {
    if (sheetOpen()) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (stylus === null && onScreen(t)) { stylus = t.identifier; const p = screenPoint(t); send({ t: 'touch', x: p.x, y: p.y }); continue; }
      btnTouches.set(t.identifier, maskFor(t));
    }
    recompute();
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (sheetOpen()) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === stylus) {
        const now = performance.now();
        if (now - lastSend > 12) { lastSend = now; const p = screenPoint(t); send({ t: 'touch', x: Math.max(0, Math.min(255, p.x)), y: Math.max(0, Math.min(191, p.y)) }); }
      } else if (btnTouches.has(t.identifier)) btnTouches.set(t.identifier, maskFor(t));
    }
    recompute();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stylus) { stylus = null; send({ t: 'touch', up: 1 }); }
      btnTouches.delete(t.identifier);
    }
    recompute();
  };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
  // Mouse, for testing on a computer.
  let mouseDown = false;
  canvas.addEventListener('mousedown', (e) => { mouseDown = true; const p = screenPoint(e); send({ t: 'touch', x: p.x, y: p.y }); });
  addEventListener('mousemove', (e) => { if (mouseDown) { const p = screenPoint(e); send({ t: 'touch', x: Math.max(0, Math.min(255, p.x)), y: Math.max(0, Math.min(191, p.y)) }); } });
  addEventListener('mouseup', () => { if (mouseDown) { mouseDown = false; send({ t: 'touch', up: 1 }); } });
  document.querySelectorAll('[data-b]').forEach((el) => {
    el.addEventListener('mousedown', () => { btnTouches.set('m', 1 << BIT[el.dataset.b]); recompute(); });
    el.addEventListener('mouseup', () => { btnTouches.delete('m'); recompute(); });
  });

  // ---- Menu: save states -----------------------------------------------------------------
  let slotsCache = [];
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' hr ago';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function renderSlots(list) {
    slotsCache = list || [];
    const box = $('slots'); box.innerHTML = '';
    for (const s of slotsCache) {
      const el = document.createElement('div'); el.className = 'slot';
      const name = s.slot === 'auto' ? 'Auto' : 'Slot ' + s.slot;
      el.innerHTML = `<div class="img">${s.time ? '' : 'Empty'}</div><div class="meta"><b>${name}</b><span>${s.time ? ago(s.time) : ''}</span></div>
        <div class="acts"><button data-a="save"${s.slot === 'auto' ? ' disabled' : ''}>Save</button><button data-a="load"${s.time ? '' : ' disabled'}>Load</button></div>`;
      if (s.img) el.querySelector('.img').style.backgroundImage = `url(${s.img})`;
      el.querySelector('[data-a=save]').onclick = (e) => {
        const b = e.currentTarget;
        // Saving over a slot asks once.
        if (s.time && !b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Replace?'; setTimeout(() => { b.classList.remove('sure'); b.textContent = 'Save'; }, 2500); return; }
        send({ t: 'save', slot: s.slot }); closeMenu();
      };
      el.querySelector('[data-a=load]').onclick = () => { send({ t: 'load', slot: s.slot }); closeMenu(); };
      box.appendChild(el);
    }
  }
  function openMenu() {
    mask = 0; btnTouches.clear(); sendMask(); paint();
    $('sheet').classList.add('open'); send({ t: 'pause', on: true }); send({ t: 'slots' });
  }
  function closeMenu() { $('sheet').classList.remove('open'); send({ t: 'pause', on: false }); }
  // The menu button works on touch (the document handler above takes over the touch otherwise).
  $('menuBtn').addEventListener('touchend', (e) => { e.preventDefault(); openMenu(); });
  $('menuBtn').addEventListener('click', openMenu);
  $('close').onclick = closeMenu;
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeMenu(); });
  // Quick save = slot 1, quick load = the newest save (yours or the automatic one).
  $('qsave').onclick = () => { send({ t: 'save', slot: 1 }); closeMenu(); };
  $('qload').onclick = () => {
    const newest = slotsCache.filter((s) => s.time).sort((a, b) => b.time - a.time)[0];
    if (!newest) return toast('Nothing saved yet');
    send({ t: 'load', slot: newest.slot }); closeMenu();
  };
  $('restart').onclick = (e) => {
    const b = e.currentTarget;
    if (!b.classList.contains('acc')) { b.classList.add('acc'); b.textContent = 'Tap again to restart'; setTimeout(() => { b.classList.remove('acc'); b.textContent = 'Restart game'; }, 3000); return; }
    send({ t: 'reset' }); closeMenu();
  };
  $('leave').onclick = () => { send({ t: 'pause', on: false }); send({ t: 'leave' }); toast('Saving…'); setTimeout(leaveToRemote, 1500); };

  // How the top screen fills the TV. The box remembers it for each game.
  const VIEWS = ['fit', 'fill', 'stretch'], VIEW_NAMES = { fit: 'Fit', fill: 'Fill', stretch: 'Stretch' };
  let view = 'fit';
  function showView(mode) {
    if (!VIEW_NAMES[mode]) return;
    view = mode; $('viewName').textContent = VIEW_NAMES[mode];
    for (const b of $('seg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === mode);
  }
  function pickView(mode) { showView(mode); send({ t: 'view', mode }); }
  const nextView = () => { pickView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]); toast(`TV: ${VIEW_NAMES[view]}`); };
  $('viewBtn').addEventListener('touchend', (e) => { e.preventDefault(); nextView(); });
  $('viewBtn').addEventListener('click', nextView);
  for (const b of $('seg').querySelectorAll('button')) b.onclick = () => pickView(b.dataset.v);
  showView('fit');

  let tt = 0;
  function toast(text) { const el = $('toast'); el.textContent = text; el.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => el.classList.remove('on'), 2200); }

  connect();
})();
