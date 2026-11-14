// TV home: one card in a quiet room, moved by the phone.
(() => {
  // Spaces (Living room, School, Games) filter the cards. Switching space reloads the page behind a curtain,
  // so every list built from S (carousel, pager, grid) is simply built for the new space.
  let SPACE = 'living';
  try { SPACE = localStorage.getItem('tv-space') || 'living'; } catch (e) {}
  if (!window.SPACES.some((x) => x.k === SPACE)) SPACE = 'living';
  const S = window.SPACE_SERVICES(SPACE);
  const $ = (id) => document.getElementById(id);
  const screen = $('screen');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const byKey = (k) => S.find((s) => s.k === k) || window.SERVICES.find((s) => s.k === k) || S[0];

  // ---------- Fit the 1920×1080 layout to any screen ----------
  function fit() {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    screen.style.transform = `translate(${(innerWidth - 1920 * s) / 2}px,${(innerHeight - 1080 * s) / 2}px) scale(${s})`;
  }
  addEventListener('resize', fit);
  fit();

  function tick() {
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
  }
  tick();
  setInterval(tick, 10000);

  // ---------- Cards ----------
  const stage = $('stage');
  function cardHTML(s) {
    const dark = s.fg === '#fff';
    const l = s.line || {};
    const sub = [l.kind, l.left].filter(Boolean).join(' · ');
    const prog = l.progress != null
      ? `<div class="prog" style="background:${dark ? 'rgba(255,255,255,.22)' : '#E4E0D8'}"><i style="width:${l.progress * 100}%;background:${s.k === 'netflix' ? s.accent : s.fg}"></i></div>`
      : '';
    const pill = dark
      ? 'background:rgba(255,255,255,.12);color:#fff;border-color:rgba(255,255,255,.25)'
      : 'background:#fff;color:#5E5B55;border-color:#E4E0D8';
    return `<div class="card" style="background:${s.bg};color:${s.fg}">
      ${s.mark()}
      <div class="row"><div class="meta" style="color:${dark ? 'rgba(255,255,255,.72)' : '#5E5B55'}"><b style="color:${s.fg}">${l.title || s.tag || ''}</b>${sub}${prog}</div>
      <div class="open" style="${pill}">Open</div></div>
      <div class="shade"></div></div>`;
  }
  const slots = S.map((s) => {
    const el = document.createElement('div');
    el.className = 'slot';
    el.innerHTML = cardHTML(s);
    stage.appendChild(el);
    return el;
  });
  const shades = slots.map((el) => el.querySelector('.shade'));
  $('pager').innerHTML = S.map(() => '<i></i>').join('');
  const dots = [...$('pager').children];

  // ---------- Spring carousel ----------
  // pos is a fractional card index. The phone moves `raw` directly; on release a spring settles to a whole card.
  const SPAN = 240;            // phone pixels per card
  const K = 170, C = 22;       // spring stiffness and damping
  let pos = 0, raw = 0, vel = 0, target = 0, dragging = false, raf = 0, focus = -1;
  const max = S.length - 1;
  const rubber = (p) => (p < 0 ? p * 0.35 : p > max ? max + (p - max) * 0.35 : p);

  function layout() {
    for (let i = 0; i < slots.length; i++) {
      const el = slots[i], d = i - pos, a = Math.abs(d), sg = Math.sign(d);
      if (a > 2.6) { el.style.visibility = 'hidden'; continue; }
      el.style.visibility = '';
      const near = Math.min(a, 1), far = Math.max(0, Math.min(a - 1, 1));
      const x = sg * (820 * near + 480 * far);
      const sc = 1 - 0.44 * near - 0.16 * far;
      el.style.transform = `translate3d(${x}px,0,0) scale(${sc})`;
      el.style.opacity = 1 - 0.5 * near - 0.4 * far;
      el.style.zIndex = 100 - Math.round(a * 10);
      shades[i].style.opacity = Math.min(a, 1.4) * 0.38;
      el.classList.toggle('focus', a < 0.5);
    }
    const f = Math.round(Math.max(0, Math.min(max, pos)));
    if (f !== focus) { const was = focus; focus = f; onFocus(); if (was >= 0 && mode === 'home') window.TVSound.tick(f > was ? 1 : -1); }
  }

  function run() {
    if (raf) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      if (!dragging) {
        if (reduce) { pos = target; vel = 0; }
        else { vel += (-K * (pos - target) - C * vel) * dt; pos += vel * dt; }
        if (Math.abs(pos - target) < 0.0005 && Math.abs(vel) < 0.002) {
          pos = target; vel = 0; layout(); raf = 0; return;
        }
      }
      layout();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function swipeMove(dx) {
    if (!dragging) { dragging = true; raw = pos; vel = 0; }
    raw -= dx / SPAN;
    pos = rubber(raw);
    run();
  }
  function swipeEnd(vx) {
    // vx is the phone's release speed in px/ms; a hard fling carries over several cards.
    const v = (-(vx || 0) * 1000) / SPAN;          // cards per second
    const projected = pos + v * 0.22;
    target = Math.max(0, Math.min(max, Math.round(projected)));
    vel = v;
    dragging = false;
    run();
  }
  function step(n) { target = Math.max(0, Math.min(max, target + n)); run(); }

  let capTimer = 0;
  function onFocus() {
    const s = S[focus];
    dots.forEach((d, i) => d.classList.toggle('on', i === focus));
    const name = $('capName');
    name.classList.add('swap');
    clearTimeout(capTimer);
    capTimer = setTimeout(() => { name.textContent = s.name; name.classList.remove('swap'); }, 140);
    sendState();
  }

  // ---------- Modes ----------
  let mode = 'home', results = [], rsel = 0, cdTimer = 0, pending = null;
  let quick = [], qtiles = [], qOn = false, qsel = -1;   // Quick Adds (built further down)
  function setMode(m) {
    const prev = mode;
    mode = m;
    // Entering the pair screen while connected: ask the box for a fresh code (it answers with {t:'pair'}).
    if (m === 'pair' && prev !== 'pair' && link.status === 'open') link.send({ t: 'pair.request' });
    screen.classList.toggle('m-pairing', m === 'pair');
    screen.classList.toggle('m-voice', m === 'voice');
    screen.classList.toggle('m-results', m === 'results');
    screen.classList.toggle('m-countdown', m === 'countdown');
    screen.classList.toggle('m-apps', m === 'apps');
    screen.classList.toggle('m-busy', m !== 'home');
    window.TVTheme.setBusy(m === 'opening');
    sendState();
  }
  function sendState() {
    const s = S[Math.max(0, mode === 'apps' ? gsel : focus)];
    link.send({ t: 'state', mode, space: SPACE, theme: window.TVTheme.current, focus: { k: s.k, name: s.name },
      quick: mode === 'apps' && qOn ? { on: true, id: qsel >= 0 && quick[qsel] ? quick[qsel].id : null } : undefined,
      results: mode === 'results' ? results.map((r, i) => ({ ...r, on: i === rsel })) : undefined,
      countdown: mode === 'countdown' ? pending : undefined });
  }

  // ---------- Voice ----------
  const bars = [18, 34, 52, 40, 26, 48, 30, 20, 44, 36, 22, 14];
  $('wave').innerHTML = bars.map((h, i) => `<i style="--h:${h}px;animation-delay:${i * 0.08}s"></i>`).join('');
  let shown = 0;
  function showWords(text, final) {
    const words = (text || '').split(/\s+/).filter(Boolean);
    const soft = final ? words.length : Math.max(0, words.length - 2);
    const html = words.map((w, i) => `<span class="${i >= soft ? 'soft' : ''}" style="${i < shown ? 'animation:none' : ''}">${esc(w)}</span>`).join(' ');
    $('said').innerHTML = html;
    shown = words.length;
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function onVoice(m) {
    if (m.phase === 'start') { shown = 0; $('said').innerHTML = ''; setMode('voice'); }
    else if (m.phase === 'partial' || m.phase === 'final') {
      if (mode !== 'voice') setMode('voice');
      showWords(m.text, m.phase === 'final');
    } else if (m.phase === 'cancel') setMode('home');
  }

  function onIntent(m) {
    if (m.kind === 'search') {
      results = (m.results || []).slice(0, 3);
      rsel = 0;
      $('resQ').innerHTML = `“<b>${esc(m.query || m.say || '')}</b>”`;
      $('rrow').innerHTML = results.map((r, i) => {
        const s = byKey(r.service);
        return `<div class="r ${i === 0 ? 'on' : ''}"><div>
          <div class="badge"><i style="background:${s.solid};color:#fff;font-weight:600">${s.k === 'disney' ? '+' : window.SERVICE_MARK(s.k, s.accent, 18)}</i>${esc(s.name)}</div>
          <div class="t">${esc(r.title)}</div><div class="s">${esc(r.sub || '')}</div></div>
          <div class="go">▶ ${i === 0 ? 'Play now' : 'Play'}</div></div>`;
      }).join('');
      setMode('results');
    } else if (m.kind === 'play') {
      countdown(m.service, m.say, m.query);
    } else if (m.kind === 'open') {
      jumpTo(m.service);
      setMode('home');
      setTimeout(() => openService(m.service, m.query), reduce ? 0 : 450);
    } else if (m.kind === 'do') {
      // Claude drives the screen for this one; show what it's doing.
      setMode('home');
      agent('start', m.say || m.heard || 'On it…');
    } else {
      setMode('home');
      toast(m.say || 'Done');
    }
  }

  // ---------- Agent strip: Claude is on it ----------
  const agEl = $('agent');
  $('agMark').innerHTML = window.SERVICE_MARK('claude', '#D97757', 28);
  let agTimer = 0;
  // Jared wants only the plain white bubble while Claude works, no Claude pill: every step shows as the toast.
  // (The box no longer draws its own page bubble on Home, so there's exactly one.)
  function agent(phase, text) {
    clearTimeout(agTimer);
    const end = phase === 'done' || phase === 'fail' || phase === 'stopped';
    const t = text || (phase === 'stopped' ? 'Stopped' : phase === 'done' ? 'Done' : phase === 'fail' ? 'Couldn’t finish that' : '');
    agEl.classList.remove('on'); $('screen').classList.remove('ag-on');
    if (t) toast(t, end ? (phase === 'fail' ? 5000 : phase === 'stopped' ? 1600 : 2800) : 8000);
  }
  function moveResult(n) {
    const was = rsel;
    rsel = Math.max(0, Math.min(results.length - 1, rsel + n));
    if (rsel !== was) window.TVSound.tick(n, 0.9);
    [...$('rrow').children].forEach((el, i) => {
      el.classList.toggle('on', i === rsel);
      el.querySelector('.go').textContent = i === rsel ? '▶ Play now' : '▶ Play';
    });
    sendState();
  }

  function countdown(k, say, query) {
    const s = byKey(k);
    pending = { k, say, query };
    $('cdCard').style.background = s.bg;
    $('cdCard').innerHTML = s.mark();
    $('cdText').textContent = say || `Playing on ${s.name}`;
    const arc = $('ringArc');
    arc.style.transition = 'none';
    arc.style.strokeDashoffset = 119.4;
    setMode('countdown');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      arc.style.transition = 'stroke-dashoffset 3s linear';
      arc.style.strokeDashoffset = 0;
    }));
    clearTimeout(cdTimer);
    cdTimer = setTimeout(() => { const p = pending; pending = null; jumpTo(p.k); openService(p.k, p.query); }, 3000);
  }
  function cancelCountdown() { clearTimeout(cdTimer); pending = null; setMode('home'); toast('Cancelled'); }

  function jumpTo(k) {
    const i = S.findIndex((s) => s.k === k);
    if (i < 0) return;
    target = i;
    if (reduce || mode !== 'home') { pos = i; vel = 0; layout(); } else run();
  }

  // ---------- Open a service: the card grows to fill the room ----------
  const take = $('takeoverIn');
  const cardRect = { left: 520, top: 253, width: 880, height: 495 };   // the focused card at rest
  function place(r, radius) {
    take.style.left = r.left + 'px'; take.style.top = r.top + 'px';
    take.style.width = r.width + 'px'; take.style.height = r.height + 'px';
    take.style.borderRadius = radius + 'px';
  }
  function openService(k, query, fromRect) {
    const s = byKey(k);
    if (s.placeholder) { toast(`${s.name} is empty for now`); if (mode === 'apps') closeGrid(); return; }
    window.TVSound.open();
    setMode('opening');
    take.className = 'takeover-in';
    take.style.transition = 'none';
    take.style.background = s.solid;
    take.innerHTML = `${s.mark()}<div class="note">Opening ${esc(s.name)}${query ? ' · ' + esc(query) : ''}</div>`;
    place(fromRect || cardRect, fromRect ? 32 : 36);
    take.style.opacity = 1;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const d = reduce ? 0 : 0.6;
      take.style.transition = `left ${d}s var(--ease), top ${d}s var(--ease), width ${d}s var(--ease), height ${d}s var(--ease), border-radius ${d}s var(--ease)`;
      place({ left: 0, top: 0, width: 1920, height: 1080 }, 0);
      if (fromRect) setTimeout(() => { gridEl.classList.remove('in'); faces.forEach((f) => (f.style.opacity = 0)); }, d * 1000);
      setTimeout(() => {
        take.classList.add('full');
        link.send({ t: 'open', k, query });   // the box agent takes it from here
      }, d * 1000);
    }));
  }
  // Coming back: start full screen in the service's color and settle back into the card.
  function returnFrom(k) {
    const s = byKey(k);
    jumpTo(k);
    pos = target; layout();
    take.className = 'takeover-in full';
    take.style.transition = 'none';
    take.style.background = s.solid;
    take.innerHTML = s.mark();
    place({ left: 0, top: 0, width: 1920, height: 1080 }, 0);
    take.style.opacity = 1;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const d = reduce ? 0 : 0.6;
      take.style.transition = `left ${d}s var(--ease), top ${d}s var(--ease), width ${d}s var(--ease), height ${d}s var(--ease), border-radius ${d}s var(--ease), opacity .35s ${d * 0.8}s`;
      place(cardRect, 36);
      take.style.opacity = 0;
      setMode('home');
    }));
  }

  // ---------- Pairing ----------
  let isPaired = false;
  function showPair(code, url) {
    if (isPaired) return;
    $('code').textContent = code.length === 6 ? code.slice(0, 3) + '·' + code.slice(3) : code;
    $('pairUrl').textContent = url.replace(/^https?:\/\//, '').replace(/#.*$/, '');
    const box = $('qr');
    if (window.qrcode) {
      const q = qrcode(0, 'M');
      q.addData(url);
      q.make();
      box.innerHTML = q.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
    } else {
      box.textContent = 'QR';
    }
    $('pairCard').classList.remove('flip');
    setMode('pair');
  }
  function paired(name) {
    isPaired = true;
    $('status').classList.add('on');
    $('statusText').textContent = name || 'Phone';
    try { localStorage.setItem('tv-paired', '1'); } catch (e) {}
    if (mode !== 'pair') { toast(`${name || 'Phone'} connected`); return; }
    $('pairWho').textContent = name || 'Phone';
    $('pairCard').classList.add('flip');
    setTimeout(() => setMode('home'), 1600);
  }

  // Quiet pairing hint when no phone has connected for a while (sent by the box). code:null hides it.
  function pairHint(code, url) {
    const el = $('phint');
    if (!code) { el.classList.remove('on'); return; }
    $('phintCode').textContent = code.length === 6 ? code.slice(0, 3) + '·' + code.slice(3) : code;
    if (window.qrcode && url) {
      const q = qrcode(0, 'M');
      q.addData(url);
      q.make();
      $('phintQr').innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
    }
    el.classList.add('on');
  }

  let toastTimer = 0;
  function toast(text, ms) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 3000);
  }

  // ---------- All apps: the carousel zooms out into a grid of square tiles ----------
  const gridEl = $('grid');
  const COLS = S.length > 8 ? 5 : 4, T = 280, GX = 56, GY = 40, NAME = 52;
  let gsel = 0, gridTimer = 0;
  const tileMark = (s) => s.k === 'youtube' ? window.SERVICE_MARK('youtube', '#FF0033', 120)
    : s.k === 'disney' ? '<span class="mk-word" style="font-size:64px;color:#fff">Disney<span style="color:#7FD6F5">+</span></span>'
    : window.SERVICE_MARK(s.k, s.k === 'netflix' ? s.accent : s.k === 'prime' ? s.accent : s.k === 'spotify' || s.k === 'claudecode' || s.k === 'gdocs' || s.k === 'gsheets' || s.placeholder ? s.accent : '#fff', s.k === 'prime' ? 150 : 120);
  const faces = S.map((s) => {
    const f = document.createElement('div');
    f.className = 'gface';
    f.style.background = s.bg;
    f.innerHTML = tileMark(s);
    gridEl.appendChild(f);
    return f;
  });
  const names = S.map((s) => {
    const n = document.createElement('div');
    n.className = 'gname';
    n.textContent = s.name;
    gridEl.appendChild(n);
    return n;
  });
  // Grid spots, with a short last row centered.
  const rows = Math.ceil(S.length / COLS);
  const spots = S.map((_, i) => {
    const r = Math.floor(i / COLS), c = i % COLS;
    const inRow = Math.min(COLS, S.length - r * COLS);
    const rowW = inRow * T + (inRow - 1) * GX;
    const totalH = rows * (T + NAME) + (rows - 1) * GY;
    return { left: (1920 - rowW) / 2 + c * (T + GX), top: (1080 - totalH) / 2 + 10 + r * (T + NAME + GY), width: T, height: T };
  });
  names.forEach((n, i) => { n.style.left = spots[i].left + 'px'; n.style.top = spots[i].top + T + 14 + 'px'; });

  // Theme row under the grid: Down from the last row reaches it, tap applies.
  const trow = document.createElement('div');
  trow.className = 'trow';
  trow.innerHTML = '<span class="tl">Theme</span>' + window.TVTheme.LIST.map((t) => `<span class="tchip" data-k="${t.k}"><i style="background:${t.sw}"></i>${t.name}</span>`).join('');
  // Jared keeps themes in the phone's ••• menu only: the row stays built (for 'theme' messages) but hidden.
  trow.hidden = true; trow.style.display = 'none';
  gridEl.appendChild(trow);
  const tchips = [...trow.querySelectorAll('.tchip')];
  let tsel = -1;
  function paintThemes() {
    tchips.forEach((c, i) => { c.classList.toggle('cur', c.dataset.k === window.TVTheme.current); c.classList.toggle('sel', i === tsel); });
  }
  function setTheme(k) { const was = window.TVTheme.current; window.TVTheme.apply(k); paintThemes(); sendState(); if (window.TVTheme.current !== was) window.TVSound.confirm(); }

  // Where each carousel card sits right now, in 1920×1080 units.
  function slotRect(i) {
    const sr = screen.getBoundingClientRect(), k = sr.width / 1920;
    const r = slots[i].getBoundingClientRect();
    if (slots[i].style.visibility === 'hidden' || !r.width) {
      const side = i < focus ? -1 : 1;
      return { left: 960 + side * 1300 - 176, top: 540 - 99, width: 352, height: 198, opacity: 0 };
    }
    return { left: (r.left - sr.left) / k, top: (r.top - sr.top) / k, width: r.width / k, height: r.height / k, opacity: +slots[i].style.opacity || 1 };
  }
  function setFace(f, r, radius, op) {
    f.style.left = r.left + 'px'; f.style.top = r.top + 'px';
    f.style.width = r.width + 'px'; f.style.height = r.height + 'px';
    f.style.borderRadius = radius + 'px';
    f.style.opacity = op;
  }
  function paintSel() {
    faces.forEach((f, i) => {
      const on = i === gsel;
      f.classList.toggle('on', on);
      f.style.transform = on ? 'translateY(-10px) scale(1.06)' : '';
    });
    names.forEach((n, i) => { n.classList.toggle('on', i === gsel); n.style.transform = i === gsel ? 'translateY(8px)' : ''; });
  }
  const SPRING = 'cubic-bezier(.2,1.25,.35,1)';   // a small overshoot, like the carousel's spring
  function openGrid() {
    clearTimeout(gridTimer);
    tsel = -1; paintThemes();
    if (mode === 'results' || mode === 'voice') setMode('home');
    gsel = Math.max(0, Math.min(max, Math.round(pos)));
    faces.forEach((f, i) => {
      f.style.transition = 'none';
      f.style.transform = '';
      const r = slotRect(i);
      setFace(f, r, 36 * (r.width / 880), r.opacity);
    });
    setMode('apps');
    window.TVSound.gridIn();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const d = reduce ? 0 : 0.62;
      faces.forEach((f, i) => {
        const delay = reduce ? 0 : Math.abs(i - gsel) * 0.03;
        f.style.transition = `left ${d}s ${SPRING} ${delay}s, top ${d}s ${SPRING} ${delay}s, width ${d}s ${SPRING} ${delay}s, height ${d}s ${SPRING} ${delay}s, border-radius ${d}s var(--ease) ${delay}s, opacity .3s ${delay}s, transform .45s var(--ease), box-shadow .45s`;
        setFace(f, spots[i], 32, 1);
      });
      paintSel();
      gridTimer = setTimeout(() => gridEl.classList.add('in'), reduce ? 0 : 280);
    }));
  }
  function gridMove(v) {
    if (!v) return;
    const [dx, dy] = v;
    if (qOn) { quickMove(dx, dy); return; }
    if (dy > 0 && Math.floor(gsel / COLS) === rows - 1) { quickEnter(); return; }   // Down past the last row: Quick Adds
    if (tsel >= 0) {                                   // in the theme row
      if (dy < 0) { tsel = -1; paintSel(); paintThemes(); return; }
      if (dx) { const n = Math.max(0, Math.min(tchips.length - 1, tsel + dx)); if (n !== tsel) { tsel = n; paintThemes(); window.TVSound.tick(dx, 0.8); } }
      return;
    }
    if (!trow.hidden && dy > 0 && Math.floor(gsel / COLS) === rows - 1) {
      tsel = Math.max(0, tchips.findIndex((c) => c.dataset.k === window.TVTheme.current));
      faces.forEach((f) => { f.classList.remove('on'); f.style.transform = ''; });
      names.forEach((n) => { n.classList.remove('on'); n.style.transform = ''; });
      paintThemes();
      window.TVSound.tick(1, 0.8);
      return;
    }
    let n = gsel;
    if (dx) n = gsel + dx;
    if (dy) {
      // Up and down keep the column; on the short last row, take the nearest tile.
      const r = Math.floor(gsel / COLS) + dy;
      if (r < 0 || r >= rows) return;
      const x = spots[gsel].left;
      let best = -1, bd = 1e9;
      spots.forEach((p, i) => { if (Math.floor(i / COLS) === r && Math.abs(p.left - x) < bd) { bd = Math.abs(p.left - x); best = i; } });
      n = best;
    }
    if (n < 0 || n > max || n === gsel) return;
    window.TVSound.tick(n > gsel ? 1 : -1, 0.8);
    gsel = n;
    paintSel();
    sendState();
  }
  function closeGrid() {
    clearTimeout(gridTimer);
    tsel = -1; paintThemes();
    if (qOn) quickLeave(true);
    window.TVSound.gridOut();
    gridEl.classList.remove('in');
    // Land the carousel on the chosen app, then send every tile back to its card.
    target = gsel; pos = gsel; vel = 0; layout();
    const d = reduce ? 0 : 0.5;
    faces.forEach((f, i) => {
      const r = slotRect(i);
      f.style.transition = `left ${d}s var(--ease), top ${d}s var(--ease), width ${d}s var(--ease), height ${d}s var(--ease), border-radius ${d}s var(--ease), opacity ${d}s var(--ease), transform .3s var(--ease)`;
      f.style.transform = '';
      f.classList.remove('on');
      setFace(f, r, 36 * (r.width / 880), r.opacity);
    });
    gridTimer = setTimeout(() => {
      faces.forEach((f) => { f.style.transition = 'opacity .2s'; f.style.opacity = 0; });
      setMode('home');
    }, d * 1000);
  }
  function openFromGrid() {
    if (tsel >= 0) { setTheme(tchips[tsel].dataset.k); return; }
    if (qOn) { if (qsel >= 0 && quick[qsel]) openQuick(quick[qsel], qtiles[qsel]); return; }
    clearTimeout(gridTimer);
    const s = S[gsel];
    focus = gsel; target = gsel; pos = gsel; vel = 0; layout();
    const r = spots[gsel];
    faces[gsel].style.opacity = 0;
    openService(s.k, undefined, { left: r.left, top: r.top, width: r.width, height: r.height });
  }

  // ---------- Quick Adds: saved links under the grid. Down from the last row slides the apps up. ----------
  const QT = 150, QGX = 44, QGY = 30, QNAME = 40, QCOLS = 8;
  const gridBottom = spots.length ? Math.max(...spots.map((p) => p.top)) + T + NAME : 760;
  const qLabelTop = gridBottom + 78;                   // just peeks in at the bottom of the apps
  const qTop = qLabelTop + 110;
  // How far the apps slide up: enough to sit the Quick Adds in the middle of the room (never above y=230).
  const qShift = () => {
    const qr = Math.max(1, Math.ceil(quick.length / QCOLS)), h = 110 + qr * (QT + QNAME) + (qr - 1) * QGY;
    return Math.max(0, qLabelTop - Math.max(230, (1080 - h) / 2 - 20));
  };
  const qwrap = document.createElement('div');
  qwrap.className = 'quick';
  qwrap.innerHTML = `<div class="q-label" style="top:${qLabelTop}px">Quick Adds<svg class="q-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></div>
    <div class="q-empty" style="top:${qTop}px">Open a video or a page on the TV, then tap <b>＋ Quick Add</b> on your phone.<br>It shows up here, one tap away.</div>`;
  gridEl.appendChild(qwrap);
  function quickSpot(i) {
    const n = qtiles.length, r = Math.floor(i / QCOLS), c = i % QCOLS;
    const inRow = Math.min(QCOLS, n - r * QCOLS);
    const rowW = inRow * QT + (inRow - 1) * QGX;
    return { left: (1920 - rowW) / 2 + c * (QT + QGX), top: qTop + r * (QT + QNAME + QGY), width: QT, height: QT };
  }
  function buildQuick(items) {
    const keep = qsel >= 0 && quick[qsel] ? quick[qsel].id : null;
    quick = Array.isArray(items) ? items : [];
    qtiles.forEach((t) => t.remove());
    qtiles = quick.map((q, i) => {
      const f = window.QUICK_FACE(q, QT);
      const t = document.createElement('div');
      t.className = 'qtile';
      t.style.transitionDelay = `${Math.min(i, 10) * 0.03}s`;
      t.innerHTML = `<div class="qface" style="background:${f.bg}">${f.html}</div><div class="qname">${esc(q.name)}</div>`;
      qwrap.appendChild(t);
      return t;
    });
    qtiles.forEach((t, i) => { const p = quickSpot(i); t.style.left = p.left + 'px'; t.style.top = p.top + 'px'; });
    qwrap.classList.toggle('none', !quick.length);
    if (qOn) gridEl.style.transform = `translateY(${-qShift()}px)`;
    if (qOn) { const i = quick.findIndex((q) => q.id === keep); qsel = i >= 0 ? i : quick.length ? Math.min(Math.max(qsel, 0), quick.length - 1) : -1; paintQuick(); }
  }
  function paintQuick() { qtiles.forEach((t, i) => t.classList.toggle('on', qOn && i === qsel)); }
  function quickEnter(i) {
    if (qOn && i == null) return;
    // Start on the Quick Add under the app that was picked.
    if (i == null) {
      const x = spots[gsel] ? spots[gsel].left + T / 2 : 960;
      i = -1;
      let bd = 1e9;
      qtiles.forEach((t, j) => { const p = quickSpot(j); if (j < QCOLS && Math.abs(p.left + QT / 2 - x) < bd) { bd = Math.abs(p.left + QT / 2 - x); i = j; } });
    }
    qOn = true; qsel = quick.length ? Math.max(0, Math.min(quick.length - 1, i)) : -1;
    faces.forEach((f) => { f.classList.remove('on'); f.style.transform = ''; });
    names.forEach((n) => { n.classList.remove('on'); n.style.transform = ''; });
    gridEl.classList.add('q-on');
    gridEl.style.transform = `translateY(${-qShift()}px)`;
    paintQuick();
    window.TVSound.tick(1, 0.8);
    sendState();
  }
  function quickLeave(quiet) {
    if (!qOn) return;
    // Back up into the apps, on the one above.
    if (qsel >= 0) {
      const x = quickSpot(qsel).left + QT / 2;
      let best = gsel, bd = 1e9;
      spots.forEach((p, j) => { if (Math.floor(j / COLS) === rows - 1 && Math.abs(p.left + T / 2 - x) < bd) { bd = Math.abs(p.left + T / 2 - x); best = j; } });
      gsel = best;
    }
    qOn = false; qsel = -1;
    gridEl.classList.remove('q-on');
    gridEl.style.transform = '';
    paintQuick();
    if (!quiet) { paintSel(); window.TVSound.tick(-1, 0.8); sendState(); }
  }
  function quickMove(dx, dy) {
    if (!quick.length) { if (dy < 0) quickLeave(); return; }
    const r = Math.floor(qsel / QCOLS), qrows = Math.ceil(quick.length / QCOLS);
    let n = qsel;
    if (dx) n = qsel + dx;
    if (dy) {
      const nr = r + dy;
      if (nr < 0) { quickLeave(); return; }
      if (nr >= qrows) return;
      const x = quickSpot(qsel).left;
      let bd = 1e9;
      quick.forEach((_, j) => { if (Math.floor(j / QCOLS) === nr && Math.abs(quickSpot(j).left - x) < bd) { bd = Math.abs(quickSpot(j).left - x); n = j; } });
    }
    if (n < 0 || n >= quick.length || n === qsel) return;
    window.TVSound.tick(n > qsel ? 1 : -1, 0.8);
    qsel = n;
    paintQuick();
    sendState();
  }
  // Open a Quick Add: its tile grows to fill the room, then the box opens that exact link.
  function openQuick(q, tile) {
    clearTimeout(gridTimer);
    const f = window.QUICK_FACE(q, 300);
    const g = window.QUICK_ICONS.find((x) => x.k === q.icon);
    let from = cardRect, radius = 36;
    if (tile && mode === 'apps') {
      const sr = screen.getBoundingClientRect(), k = sr.width / 1920, r = tile.querySelector('.qface').getBoundingClientRect();
      from = { left: (r.left - sr.left) / k, top: (r.top - sr.top) / k, width: r.width / k, height: r.height / k };
      radius = 26;
      tile.classList.add('gone');
    }
    window.TVSound.open();
    const fromGrid = mode === 'apps';
    setMode('opening');
    take.className = 'takeover-in';
    take.style.transition = 'none';
    take.style.background = f.bg;
    take.style.color = g ? g.fg : q.k === 'youtube' ? '#0F0F0F' : '#fff';
    take.innerHTML = `${f.html}<div class="note">${esc(q.name)}</div>`;
    place(from, radius);
    take.style.opacity = 1;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const d = reduce ? 0 : 0.6;
      take.style.transition = `left ${d}s var(--ease), top ${d}s var(--ease), width ${d}s var(--ease), height ${d}s var(--ease), border-radius ${d}s var(--ease)`;
      place({ left: 0, top: 0, width: 1920, height: 1080 }, 0);
      setTimeout(() => {
        if (fromGrid) {
          gridEl.classList.remove('in'); faces.forEach((x) => (x.style.opacity = 0));
          gridEl.style.transition = 'none'; quickLeave(true); requestAnimationFrame(() => (gridEl.style.transition = ''));
          qtiles.forEach((t) => t.classList.remove('gone'));
        }
        take.classList.add('full');
        link.send({ t: 'open', k: q.k || 'chrome', url: q.url });
      }, d * 1000);
    }));
  }

  // ---------- Spaces ----------
  const spaceOf = (k) => window.SPACES.find((x) => x.k === k) || window.SPACES[0];
  document.querySelector('.grid-label').textContent = SPACE === 'living' ? 'All apps' : spaceOf(SPACE).name;
  let switching = false;
  function switchSpace(name) {
    if (switching || !window.SPACES.some((x) => x.k === name)) return;
    switching = true;
    const sp = spaceOf(name), cur = $('spacefx');
    try { localStorage.setItem('tv-space', name); sessionStorage.setItem('tv-space-enter', JSON.stringify({ name: sp.name, sub: sp.sub })); } catch (e) {}
    $('sfxName').textContent = sp.name; $('sfxSub').textContent = sp.sub;
    window.TVSound.gridOut();
    screen.classList.add('sp-out');                 // the row sinks and fades
    cur.classList.add('on');                        // the new space's name rises in
    setTimeout(() => location.replace(location.pathname + location.search), reduce ? 50 : 700);
  }
  // Arriving in a space: the curtain is up with its name; it lifts and the row rises in.
  (() => {
    let enter = false;
    try { enter = !!sessionStorage.getItem('tv-space-enter'); sessionStorage.removeItem('tv-space-enter'); } catch (e) {}
    if (!enter) return;
    const cur = $('spacefx'), sp = spaceOf(SPACE);
    $('sfxName').textContent = sp.name; $('sfxSub').textContent = sp.sub;
    cur.classList.add('on', 'still'); screen.classList.add('sp-in');
    document.documentElement.classList.remove('sp-enter');   // the classes above now hold the curtain
    requestAnimationFrame(() => requestAnimationFrame(() => {
      cur.classList.remove('still');
      setTimeout(() => { cur.classList.remove('on'); screen.classList.remove('sp-in'); }, reduce ? 0 : 650);
    }));
  })();

  // ---------- Messages ----------
  function handle(m) {
    switch (m.t) {
      case 'apps':
        if (mode === 'apps') closeGrid();
        else if (mode === 'home' || mode === 'results' || mode === 'voice') openGrid();
        break;
      case 'space': if (m.name && m.name !== SPACE) switchSpace(m.name); break;
      case 'sounds': window.TVSound.setOn(m.on !== false); break;
      case 'theme':
        setTheme(m.name);
        break;
      case 'quick': buildQuick(m.items); break;
      case 'quick.view':                                  // the phone scrolled its Apps grid to Quick Adds (or back)
        if (mode === 'apps') m.on ? quickEnter() : quickLeave();
        break;
      case 'quick.open': {
        const i = quick.findIndex((q) => q.id === m.id);
        if (i < 0) break;
        if (mode === 'apps') {
          if (!qOn) quickEnter(i); else { qsel = i; paintQuick(); }
          clearTimeout(gridTimer); gridTimer = setTimeout(() => openQuick(quick[i], qtiles[i]), reduce ? 0 : 320);
        } else if (mode === 'home' || mode === 'results' || mode === 'voice') openQuick(quick[i]);
        break;
      }
      case 'apps.pick': {
        // The phone tapped a tile: move the highlight there, then open it from the grid.
        const i = S.findIndex((s) => s.k === m.k);
        if (i < 0) break;
        if (mode === 'apps') {
          if (qOn) quickLeave(true);
          tsel = -1; paintThemes(); gsel = i; paintSel();
          clearTimeout(gridTimer); gridTimer = setTimeout(openFromGrid, 140);
        } else if (mode === 'home' || mode === 'results' || mode === 'voice') { jumpTo(m.k); openService(m.k); }
        break;
      }
      case 'key':
        if (mode === 'apps') {
          if (m.key === 'Enter') openFromGrid();
          else if (m.key === 'Escape') qOn ? quickLeave() : closeGrid();
          else gridMove({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[m.key]);
        } else if (mode === 'home') {
          if (m.key === 'ArrowLeft') step(-1); else if (m.key === 'ArrowRight') step(1);
          else if (m.key === 'Enter') openService(S[focus].k);
          else if (m.key === 'ArrowDown' || m.key === 'ArrowUp') openGrid();
        } else if (mode === 'results') {
          if (m.key === 'ArrowLeft') moveResult(-1); else if (m.key === 'ArrowRight') moveResult(1);
          else if (m.key === 'Enter') handle({ t: 'tap' }); else if (m.key === 'Escape') setMode('home');
        } else if (mode === 'countdown' && m.key === 'Escape') cancelCountdown();
        break;
      case 'swipe':
        if (mode === 'apps') {
          if (m.phase !== 'end') break;
          const dx = m.dxTotal || 0, dy = m.dyTotal || 0;
          if (Math.max(Math.abs(dx), Math.abs(dy)) < 40) break;
          if (Math.abs(dx) >= Math.abs(dy)) gridMove([dx < 0 ? 1 : -1, 0]); else gridMove([0, dy < 0 ? 1 : -1]);
          break;
        }
        if (mode === 'home') m.phase === 'end' ? swipeEnd(m.vx) : swipeMove(m.dx || 0);
        else if (mode === 'results' && m.phase === 'end' && Math.abs(m.dxTotal || 0) > 40) moveResult(m.dxTotal < 0 ? 1 : -1);
        break;
      case 'tap':
        if (mode === 'apps') openFromGrid();
        else if (mode === 'home') openService(S[focus].k);
        else if (mode === 'results') { const r = results[rsel]; jumpTo(r.service); openService(r.service, r.title); }
        else if (mode === 'countdown') cancelCountdown();
        break;
      case 'back':
        if (mode === 'apps') qOn ? quickLeave() : closeGrid();
        else if (mode === 'countdown') cancelCountdown();
        else if (mode === 'results' || mode === 'voice') setMode('home');
        break;
      case 'home':
        if (mode === 'apps') { gsel = 0; closeGrid(); }
        else if (mode === 'opening') returnFrom(S[focus].k);
        else if (mode === 'countdown') cancelCountdown();
        else if (mode !== 'pair') { setMode('home'); target = 0; run(); }
        break;
      case 'voice': if (mode !== 'pair' && mode !== 'opening') onVoice(m); break;
      case 'intent': if (mode !== 'pair') onIntent(m); break;
      case 'pair': showPair(m.code, m.url); break;
      case 'paired': paired(m.name); break;
      case 'pair.hint': pairHint(m.code, m.url); break;
      case 'link': if (m.status === 'open' && mode === 'pair') link.send({ t: 'pair.request' }); break;
      case 'toast': toast(m.text); break;
      case 'agent': agent(m.phase, m.text); break;
      case 'hello': $('status').classList.add('on'); $('statusText').textContent = m.name || 'Phone'; sendState(); break;
      case 'bye': $('status').classList.remove('on'); $('statusText').textContent = 'No remote'; break;
    }
  }
  link.on(handle);

  // Keyboard, for testing without a phone: ← → Enter, Esc, H.
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') mode === 'home' ? step(1) : handle({ t: 'swipe', phase: 'end', vx: -0.6, dxTotal: -60 });
    else if (e.key === 'ArrowLeft') mode === 'home' ? step(-1) : handle({ t: 'swipe', phase: 'end', vx: 0.6, dxTotal: 60 });
    else if (e.key === 'Enter') handle({ t: 'tap' });
    else if (e.key === 'Escape') handle({ t: 'back' });
    else if (e.key === 'h' || e.key === 'H') handle({ t: 'home' });
    else if (e.key === 'a' || e.key === 'A') handle({ t: 'apps' });
    else if (e.key === 's' || e.key === 'S') {   // testing: next space
      const i = window.SPACES.findIndex((x) => x.k === SPACE), n = window.SPACES[(i + 1) % window.SPACES.length].k;
      link.send({ t: 'space', name: n }); switchSpace(n);
    }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') handle({ t: 'key', key: e.key });
  });

  // ---------- Start ----------
  layout();
  const from = (location.hash.match(/from=([a-z]+)/) || [])[1];
  const wantApps = /(^#|&)apps\b/.test(location.hash);
  if (from || wantApps) {
    history.replaceState(null, '', location.pathname + location.search);
    if (from) returnFrom(from); else setMode('home');
    if (wantApps) setTimeout(() => { gsel = Math.max(0, focus); openGrid(); }, from ? 700 : 50);
  }
  else {
    let pairedBefore = false;
    try { pairedBefore = localStorage.getItem('tv-paired') === '1'; } catch (e) {}
    if (pairedBefore || /skip-pair/.test(location.search)) setMode('home');
    else setMode('pair');
  }
  link.send({ t: 'tv-ready' });
})();
