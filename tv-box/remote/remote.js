// Phone remote: one big surface, Back, Home and a hold-to-talk mic.
(() => {
  const $ = (id) => document.getElementById(id);
  const app = $('app'), pad = $('pad'), touch = $('touch');
  const S = window.SERVICES;
  const byKey = (k) => S.find((s) => s.k === k) || window.SPACE_SERVICES('games').find((s) => s.k === k) || S[0];
  const buzz = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };

  let mode = 'home', focusK = null, svcK = null;

  // ---------- Connection and pairing ----------
  // In local mode (?local) the TV's stub answers a hello. With the relay, link.js pairs from the QR code
  // or from the code typed here, and reports its status as {t:'link'}.
  const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone';
  let joined = false;
  if (link.status === 'local') {
    const hello = () => { if (!joined) link.send({ t: 'hello', name }); };
    hello();
    const helloTimer = setInterval(() => (joined ? clearInterval(helloTimer) : hello()), 2000);   // until the TV answers
  }
  function setConn(on, text) { $('st').classList.toggle('on', on); $('stText').textContent = text; }

  link.on((m) => {
    if (m.t === 'link') {
      if (m.status === 'open') { setConn(true, 'Connected'); maybeOfferA2(); }
      else if (m.status === 'connecting' || m.status === 'reconnecting' || m.status === 'closed') setConn(false, 'Reconnecting…');
      else if (m.status === 'need-pair' || m.status === 'unpaired') { setConn(false, 'Not paired'); askCode(m.error); }
      return;
    }
    if (m.t === 'state') { if (m.space && m.space !== space) setSpace(m.space); apply(m); if (m.theme && m.theme !== tvTheme) paintTheme(m.theme); }
    if (m.t === 'toast') flashTip(m.text);
    if (m.t === 'tv.status') tvStatus(m);
    if (m.t === 'space') setSpace(m.name);
    if (m.t === 'sounds') paintSounds(m.on !== false);
    if (m.t === 'game' && m.running && !/[?&]demo\b/.test(location.search)) location.href = '/games/pad.html';
    if (m.t === 'intent' && m.kind === 'do') agentBar('start', m.say || m.heard);
    if (m.t === 'agent') agentBar(m.phase, m.text);
    if (m.t === 'kbd.show') kbdShow(m, false);
    if (m.t === 'kbd.hide') kbdHide();
    if ((m.t === 'paired' || m.t === 'state') && m.mode !== 'pair') {
      joined = true;
      setConn(true, 'Connected');
      if (pairing) { pairing = false; show('vHome'); }
    }
  });

  let pairing = false;
  function askCode(err) {
    pairing = true;
    show('vPair');
    $('hint').textContent = '';
    $('pairErr').textContent = err || '';
  }
  async function submitCode() {
    const code = $('codeIn').value.replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (code.length !== 6) { $('pairErr').textContent = 'The code has 6 letters and numbers.'; return; }
    $('pairErr').textContent = '';
    $('pairGo').textContent = 'Connecting…';
    try {
      await link.pairCode(code);
      pairing = false; joined = true; setConn(true, 'Connected'); show('vHome');
      $('hint').textContent = 'Swipe to move · Tap to open';
    } catch (e) {
      $('pairErr').textContent = e.message || 'That code didn’t work. Check the TV and try again.';
    }
    $('pairGo').textContent = 'Connect';
  }
  $('pairGo').addEventListener('click', submitCode);
  $('codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCode(); });
  ['pointerdown', 'pointerup'].forEach((ev) => $('vPair').addEventListener(ev, (e) => e.stopPropagation()));

  function show(view) {
    ['vHome', 'vVoice', 'vCount', 'vPad', 'vPair'].forEach((v) => $(v).classList.toggle('on', v === view));
  }
  function apply(m) {
    const prev = mode;
    mode = m.mode;
    app.classList.toggle('service', mode === 'service');
    svcK = mode === 'service' ? m.k : null;
    setTermKeys();
    $('appsBtn').classList.toggle('on', mode === 'apps');
    if (mode === 'apps') gridIn(m.focus && m.focus.k); else gridOut();
    const web = mode === 'service' && m.k === 'chrome';
    app.classList.toggle('web', web);
    if (web) showAddr(m.url, m.title);
    // Music services get Next instead of ±10s.
    document.querySelectorAll('.vid').forEach((b) => (b.hidden = !!m.music));
    document.querySelectorAll('.mus').forEach((b) => (b.hidden = !m.music));
    if (mode === 'service') {
      show('vPad');
      $('padSvc').textContent = m.k === 'chrome' ? (m.title || 'Chrome') : byKey(m.k).name;
      $('hint').textContent = 'Drag to move · Tap to click · Two fingers to scroll';
      $('tip').textContent = 'Hold to speak · “Pause” or “Turn it down”';
    } else if (mode === 'countdown') {
      show('vCount');
      $('cdText').textContent = (m.countdown && m.countdown.say) || 'Playing';
      const arc = $('arc');
      arc.style.transition = 'none'; arc.style.strokeDashoffset = 0;
      requestAnimationFrame(() => requestAnimationFrame(() => { arc.style.transition = 'stroke-dashoffset 3s linear'; arc.style.strokeDashoffset = 107; }));
      $('hint').textContent = '';
    } else if (mode === 'voice') {
      show('vVoice');
      $('hint').textContent = '';
    } else {
      show('vHome');
      $('hint').textContent = mode === 'results' ? 'Swipe to choose · Tap to play' : mode === 'pair' ? 'Connecting to the TV…' : mode === 'apps' ? 'Swipe any way to move · Tap to open' : 'Swipe to move · Tap to open';
      $('now').textContent = mode === 'apps' ? 'All apps' : 'On screen';
      $('tip').textContent = 'Hold to speak · “Open Spotify”';
      const k = mode === 'results' && m.results ? (m.results.find((r) => r.on) || {}).service : m.focus && m.focus.k;
      const label = mode === 'results' && m.results ? (m.results.find((r) => r.on) || {}).title : m.focus && m.focus.name;
      if (k && (k !== focusK || prev !== mode || label !== $('svc').textContent)) {
        if (focusK && k !== focusK) buzz();
        focusK = k;
        swapTo(byKey(k), label);
      }
    }
  }
  // ---------- All apps: the same tiles as the TV, in the same order ----------
  const agrid = $('agrid'), atiles = $('atiles');
  const tileMark = (s) => s.k === 'disney' ? '<span class="dw">Disney<span style="color:#7FD6F5">+</span></span>'
    : window.SERVICE_MARK(s.k, s.k === 'youtube' ? '#FF0033' : (s.k === 'netflix' || s.k === 'prime' || s.k === 'spotify' || s.k === 'claudecode' || s.k === 'gdocs' || s.k === 'gsheets' || s.placeholder) ? s.accent : '#fff', 40);
  // Tiles follow the current space (rebuilt when it changes).
  let tiles = [];
  function buildTiles(list) {
    atiles.innerHTML = '';
    atiles.style.setProperty('--cols', list.length > 8 ? 5 : 4);
    tiles = list.map((s, i) => {
      const b = document.createElement('button');
      b.className = 'at'; b.dataset.k = s.k;
      b.style.transitionDelay = i * 0.035 + 's';
      b.innerHTML = `<i style="background:${s.bg}">${tileMark(s)}</i><span>${s.name}</span>`;
      b.addEventListener('click', () => pick(s.k, b));
      atiles.appendChild(b);
      return b;
    });
  }
  buildTiles(window.SPACE_SERVICES('living'));
  ['pointerdown', 'pointerup', 'pointermove'].forEach((ev) => agrid.addEventListener(ev, (e) => e.stopPropagation()));
  let gridOn = false, gridTimer = 0, picked = null;
  function gridSel(k) { tiles.forEach((t) => t.classList.toggle('on', t.dataset.k === k)); }
  function gridIn(k) {
    clearTimeout(gridTimer);
    gridSel(k);
    if (gridOn) return;
    gridOn = true; picked = null;
    agrid.classList.remove('out', 'launch'); agrid.classList.add('on'); agrid.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => requestAnimationFrame(() => agrid.classList.add('in')));
  }
  function gridOut() {
    if (!gridOn) return;
    gridOn = false;
    agrid.setAttribute('aria-hidden', 'true');
    if (!picked) agrid.classList.add('out');
    gridTimer = setTimeout(() => agrid.classList.remove('on', 'in', 'out', 'launch'), picked ? 420 : 300);
    tiles.forEach((t) => t.classList.remove('pick'));
  }
  function pick(k, b) {
    if (!gridOn || picked) return;
    picked = k;
    buzz(12);
    gridSel(k); b.classList.add('pick'); agrid.classList.add('launch');
    link.send({ t: 'apps.pick', k });
  }

  // ---------- Browser bar (Chrome and any other website) ----------
  const addr = $('addr');
  let pageUrl = '';
  const pretty = (u) => (u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  function showAddr(url, title) {
    pageUrl = url || '';
    if (document.activeElement !== addr) addr.value = pretty(pageUrl);
  }
  addr.addEventListener('focus', () => { addr.value = pageUrl; requestAnimationFrame(() => addr.select()); });
  addr.addEventListener('blur', () => { addr.value = pretty(pageUrl); });
  $('addrForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = addr.value.trim();
    if (q && q !== pageUrl) link.send({ t: 'nav', a: 'go', q });
    buzz(10);
    addr.blur();
  });
  [['navBack', 'back'], ['navFwd', 'forward'], ['navReload', 'reload']].forEach(([id, a]) =>
    $(id).addEventListener('click', () => { link.send({ t: 'nav', a }); buzz(); }));

  function swapTo(s, label) {
    $('svc').classList.add('swap'); $('logo').classList.add('swap');
    setTimeout(() => {
      $('svc').textContent = label || s.name;
      $('logo').innerHTML = s.k === 'disney'
        ? '<span style="font:600 40px Inter,system-ui;letter-spacing:-.03em;color:#0B1437">Disney<span style="color:#1A6A86">+</span></span>'
        : window.SERVICE_MARK(s.k, s.k === 'youtube' || s.k === 'netflix' || s.k === 'spotify' ? s.accent : s.solid, 64);
      $('svc').classList.remove('swap'); $('logo').classList.remove('swap');
    }, 120);
  }

  // ---------- The surface ----------
  // Home and results: swipe sends deltas live (the TV runs the spring), release sends speed.
  // Inside a service: a touchpad. Drag moves the pointer, tap clicks, two fingers scroll.
  const pts = new Map();
  let start = null, lastX = 0, lastY = 0, acc = 0, accY = 0, accScroll = 0, samples = [], frame = 0, moved = 0;
  // Two-finger scroll. Once a second finger lands the gesture is a scroll until every finger is up:
  // no pointer moves and no click. Natural direction (drag up to read further down), with a coast after.
  // Sent as {t:'scroll', dy}: page pixels, positive = further down the page.
  const SCROLL_GAIN = 2.6;
  let scrolling = false, sY = 0, sSamples = [], coast = 0;
  const centroidY = () => { let y = 0; for (const p of pts.values()) y += p.y; return y / pts.size; };
  function stopCoast() { if (coast) cancelAnimationFrame(coast); coast = 0; }
  function startCoast() {
    const now = performance.now();
    const ss = sSamples.filter((x) => now - x.t < 120);
    if (ss.length < 2) return;
    const a = ss[0], b = ss[ss.length - 1];
    if (b.t - a.t < 16) return;
    let v = -(b.y - a.y) / (b.t - a.t) * SCROLL_GAIN * 16.7;  // page pixels per frame
    if (Math.abs(v) < 4) return;
    v = Math.max(-260, Math.min(260, v));
    const step = () => {
      v *= 0.93;
      if (Math.abs(v) < 1.5) { coast = 0; return; }
      link.send({ t: 'scroll', dy: Math.round(v) });
      coast = requestAnimationFrame(step);
    };
    coast = requestAnimationFrame(step);
  }
  // iOS: keep two fingers from zooming the page.
  ['gesturestart', 'gesturechange'].forEach((ev) => pad.addEventListener(ev, (e) => e.preventDefault()));

  function flush() {
    frame = 0;
    if (mode === 'service') {
      if (scrolling) { const dy = Math.round(-accScroll * SCROLL_GAIN); if (dy) link.send({ t: 'scroll', dy }); }
      else if (acc || accY) link.send({ t: 'pad', dx: acc * 1.8, dy: accY * 1.8 });
    } else if (acc) link.send({ t: 'swipe', phase: 'move', dx: acc });
    acc = 0; accY = 0; accScroll = 0;
  }
  const queue = () => { if (!frame) frame = requestAnimationFrame(flush); };   // at most one message per frame

  pad.addEventListener('pointerdown', (e) => {
    if (pairing) return;
    pad.setPointerCapture(e.pointerId);
    stopCoast();
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2 && mode === 'service') {
      if (!scrolling) { scrolling = true; acc = 0; accY = 0; accScroll = 0; touch.classList.remove('on'); }
      sY = centroidY(); sSamples = [{ y: sY, t: performance.now() }];
    }
    if (pts.size > 1) return;
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
    lastX = e.clientX; lastY = e.clientY; moved = 0; samples = [{ x: e.clientX, t: start.t }];
    const r = pad.getBoundingClientRect();
    touch.style.left = e.clientX - r.left + 'px'; touch.style.top = e.clientY - r.top + 'px';
    touch.classList.add('on');
  });
  pad.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    const p = pts.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY; lastY = e.clientY;
    if (scrolling) {
      const c = centroidY(), now = performance.now();
      accScroll += c - sY; sY = c;
      sSamples.push({ y: c, t: now });
      while (sSamples.length > 2 && now - sSamples[0].t > 120) sSamples.shift();
      queue();
      return;
    }
    if (pts.size >= 2) return;
    const r = pad.getBoundingClientRect();
    touch.style.left = e.clientX - r.left + 'px'; touch.style.top = e.clientY - r.top + 'px';
    moved = Math.max(moved, Math.hypot(e.clientX - start.x, e.clientY - start.y));
    acc += dx; accY += dy;
    const now = performance.now();
    samples.push({ x: e.clientX, t: now });
    while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
    if (moved > 8 && mode !== 'countdown' && mode !== 'voice') queue();
  });
  function end(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (scrolling) {
      if (pts.size > 0) { sY = centroidY(); return; }   // one finger still down: keep scrolling, no jump
      scrolling = false; start = null;
      touch.classList.remove('on');
      if (frame) { cancelAnimationFrame(frame); flush(); }
      if (e.type !== 'pointercancel') startCoast();
      return;
    }
    if (pts.size > 0 || !start) return;
    touch.classList.remove('on');
    const dt = performance.now() - start.t;
    if (moved < 10 && dt < 350) {
      link.send({ t: mode === 'service' ? 'click' : 'tap' });
      buzz(10);
    } else if (mode !== 'service' && mode !== 'countdown') {
      if (frame) { cancelAnimationFrame(frame); flush(); }
      const a = samples[0], b = samples[samples.length - 1];
      const vx = b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
      link.send({ t: 'swipe', phase: 'end', vx, dxTotal: b.x - start.x, dyTotal: lastY - start.y });
    }
    start = null;
  }
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);

  $('cancel').addEventListener('click', (e) => { e.stopPropagation(); link.send({ t: 'back' }); buzz(12); });
  $('cancel').addEventListener('pointerdown', (e) => e.stopPropagation());
  $('back').addEventListener('click', () => { if (gridOn) gridOut(); link.send({ t: 'back' }); buzz(); });
  $('appsBtn').addEventListener('click', () => { if (gridOn) gridOut(); link.send({ t: 'apps' }); buzz(); });
  $('home').addEventListener('click', () => { if (gridOn) gridOut(); link.send({ t: 'home' }); buzz(); });
  // A long press on Back also goes Home (handy inside a service).
  let backHold = 0;
  $('back').addEventListener('pointerdown', () => { backHold = setTimeout(() => { link.send({ t: 'home' }); buzz(20); backHold = -1; }, 600); });
  $('back').addEventListener('pointerup', () => { if (backHold > 0) clearTimeout(backHold); });
  document.querySelectorAll('.mbtn').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.a;
    link.send({ t: 'media', a: a.startsWith('vol') ? 'vol' : a, v: a === 'volup' ? 10 : a === 'voldown' ? -10 : undefined });
    buzz();
  }));

  // ---------- Voice: hold to talk ----------
  // Uses the phone's own live speech recognition. Where there is none (a desktop test), it plays a sample phrase.
  // ?demo forces the sample phrases (for trying it on a laptop).
  const SR = /demo/.test(location.search) ? null : (window.SpeechRecognition || window.webkitSpeechRecognition);
  const samplesSaid = ['Play the new episode of The Last of Us', 'Open Spotify', 'Play Andor on Disney Plus', 'Pause'];
  let sampleIx = 0, rec = null, said = '', fake = 0, talking = false;

  function renderSaid(text, final) {
    const w = text.split(/\s+/).filter(Boolean);
    const soft = final ? w.length : Math.max(0, w.length - 2);
    $('said').innerHTML = w.map((x, i) => (i >= soft ? `<span class="soft">${x}</span>` : x)).join(' ');
  }
  function partial(text) { said = text; renderSaid(text, false); link.send({ t: 'voice', phase: 'partial', text }); }

  function startTalk(e) {
    e.preventDefault();
    if (talking) return;
    // While Claude is working, the mic is a Stop button.
    if (agentOn) { link.send({ t: 'cancel' }); buzz(15); agentBar('stopped', 'Stopped'); return; }
    // On the box's plain address the iPhone won't share the microphone: offer the one-time setup instead.
    if (link.status !== 'local' && link.secure === false && link.voiceSetup && !/demo/.test(location.search)) { openVoiceSetup(); return; }
    talking = true; said = '';
    $('mic').classList.add('on'); buzz(15);
    show('vVoice'); $('said').innerHTML = '';
    link.send({ t: 'voice', phase: 'start' });
    if (SR) {
      rec = new SR();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.onresult = (ev) => { let t = ''; for (const r of ev.results) t += r[0].transcript; partial(t.trim()); };
      // No microphone or permission refused: fall back to a sample phrase so the flow can still be tried.
      rec.onerror = () => { rec = null; if (talking && !said) startSample(); };
      try { rec.start(); } catch (err) { rec = null; }
    }
    if (!rec) startSample();
  }
  function startSample() {
    const words = samplesSaid[sampleIx++ % samplesSaid.length].split(' ');
    let i = 0;
    clearInterval(fake);
    fake = setInterval(() => { if (i < words.length) partial(words.slice(0, ++i).join(' ')); }, 180);
  }
  function stopTalk() {
    if (!talking) return;
    talking = false;
    $('mic').classList.remove('on');
    clearInterval(fake);
    const finish = () => {
      if (said) { renderSaid(said, true); link.send({ t: 'voice', phase: 'final', text: said }); }
      else { link.send({ t: 'voice', phase: 'cancel' }); show('vHome'); }
    };
    if (rec) { rec.onend = finish; try { rec.stop(); } catch (err) { finish(); } rec = null; }
    else finish();
  }
  const mic = $('mic');
  mic.addEventListener('pointerdown', startTalk);
  mic.addEventListener('pointerup', stopTalk);
  mic.addEventListener('pointercancel', stopTalk);
  mic.addEventListener('pointerleave', stopTalk);
  mic.addEventListener('contextmenu', (e) => e.preventDefault());

  swapTo(S[0]);
  // ---------- More: arrow keys, typing, pairing ----------
  let tipTimer = 0;
  function flashTip(text) {
    const tip = $('tip'), was = tip.dataset.base || tip.textContent;
    tip.dataset.base = was;
    tip.textContent = text;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { tip.textContent = tip.dataset.base; delete tip.dataset.base; }, 2500);
  }
  const sheet = $('sheet');
  const closeSheet = () => { sheet.hidden = true; $('forgetConfirm').hidden = true; };
  $('more').addEventListener('click', () => { sheet.hidden = false; });
  $('sheetX').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  $('keysv').querySelectorAll('.k').forEach((b) => b.addEventListener('click', () => { link.send({ t: 'key', key: b.dataset.k }); buzz(); }));

  $('pairAnother').addEventListener('click', () => { link.send({ t: 'pair.request' }); closeSheet(); flashTip('The TV is showing a new code'); });
  $('forget').addEventListener('click', () => { $('forgetConfirm').hidden = false; });
  $('forgetNo').addEventListener('click', () => { $('forgetConfirm').hidden = true; });
  $('forgetYes').addEventListener('click', () => { closeSheet(); link.unpair && link.unpair(); });
  // ---------- Claude is on it: live steps, with Stop ----------
  const abar = $('abar');
  $('abMark').innerHTML = window.SERVICE_MARK('claude', '#D97757', 18);
  let abTimer = 0;
  // No bar over the touchpad (Jared's ask): while Claude works, the mic turns into a Stop button and
  // the line under it shows the current step. A run that goes quiet for a minute is treated as over.
  let agentOn = false, agentDog = 0;
  function agentBar(phase, text) {
    clearTimeout(abTimer); clearTimeout(agentDog);
    abar.classList.remove('on');
    const end = phase === 'done' || phase === 'fail' || phase === 'stopped';
    const t = text || (phase === 'stopped' ? 'Stopped' : phase === 'done' ? 'Done' : phase === 'fail' ? 'Couldn’t finish that' : 'On it…');
    const tip = $('tip');
    if (!end) {
      if (!agentOn) { tip.dataset.base = tip.dataset.base || tip.textContent; if (phase === 'start') buzz(10); }
      agentOn = true;
      mic.classList.add('stop');
      mic.setAttribute('aria-label', 'Stop');
      clearTimeout(tipTimer);
      tip.textContent = t;
      agentDog = setTimeout(() => agentBar('done', ' '), 60000);
      return;
    }
    const was = agentOn;
    agentOn = false;
    mic.classList.remove('stop');
    mic.setAttribute('aria-label', 'Hold to speak');
    if (tip.dataset.base && was) { tip.textContent = tip.dataset.base; delete tip.dataset.base; }
    if (t.trim()) flashTip(t);
  }
  $('abStop').addEventListener('click', () => { link.send({ t: 'cancel' }); buzz(15); $('abText').innerHTML = '<b>Claude</b> · Stopping…'; });
  $('abKey').addEventListener('click', () => { abar.classList.remove('on'); openKeySheet(); });
  ['pointerdown', 'pointerup', 'pointermove'].forEach((ev) => abar.addEventListener(ev, (e) => e.stopPropagation()));

  // ---------- Claude key (saved on the box, checked with Anthropic first) ----------
  const ksheet = $('ksheet');
  const creds = () => { try { return JSON.parse(localStorage.getItem('tv-remote') || 'null'); } catch (e) { return null; } };
  async function keyApi(body) {
    const c = creds();
    if (!c) throw new Error('Pair this phone with the TV first.');
    const r = await fetch('/api/settings/claude', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tv: c.tv, key: c.key, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'The TV box didn’t accept that.');
    return j;
  }
  function showKeyState(j) {
    $('kStat').classList.toggle('on', !!j.set);
    $('kStatText').textContent = j.set ? `Key saved (${j.hint || '…'}) · hands-free is on` : 'No key yet · voice shows choices instead';
    $('kRemove').hidden = !j.set;
    $('kSave').textContent = j.set ? 'Replace key' : 'Save key';
    $('claudeKeyHint').textContent = j.set ? 'On' : 'Off';
  }
  async function openKeySheet() {
    sheet.hidden = true;
    ksheet.hidden = false;
    $('kErr').textContent = ''; $('kIn').value = '';
    const local = link.status === 'local';
    const safe = local || link.secure;
    $('kSecure').hidden = safe; $('kForm').hidden = !safe;
    $('kStatText').textContent = 'Checking…';
    try { showKeyState(local ? { set: false } : await keyApi({ read: true })); }
    catch (e) { $('kStatText').textContent = 'Couldn’t reach the TV box'; }
  }
  $('claudeKey').addEventListener('click', openKeySheet);
  $('ksX').addEventListener('click', () => { ksheet.hidden = true; $('kIn').blur(); });
  ksheet.addEventListener('click', (e) => { if (e.target === ksheet) ksheet.hidden = true; });
  $('kGoSecure').addEventListener('click', () => { ksheet.hidden = true; openVoiceSetup(); });
  $('kPaste').addEventListener('click', async () => {
    try { $('kIn').value = (await navigator.clipboard.readText()).trim(); buzz(); }
    catch (e) { $('kIn').focus(); $('kErr').textContent = 'Tap the box, then press and hold to paste.'; }
  });
  $('kSave').addEventListener('click', async () => {
    const v = $('kIn').value.replace(/\s+/g, '');
    if (!v) { $('kErr').textContent = 'Paste your key first.'; return; }
    $('kErr').textContent = ''; $('kSave').textContent = 'Checking with Claude…'; $('kSave').disabled = true;
    try { const j = await keyApi({ anthropicKey: v }); showKeyState(j); $('kIn').value = ''; flashTip('Hands-free voice is on'); buzz(20); }
    catch (e) { $('kErr').textContent = e.message; $('kSave').textContent = 'Save key'; }
    $('kSave').disabled = false;
  });
  $('kRemove').addEventListener('click', async () => {
    try { showKeyState(await keyApi({ anthropicKey: '' })); flashTip('Key removed'); } catch (e) { $('kErr').textContent = e.message; }
  });
  ['pointerdown', 'pointerup'].forEach((ev) => ksheet.addEventListener(ev, (e) => e.stopPropagation()));

  // ---------- Spaces (Living room, School, Games): the title opens the picker ----------
  let space = 'living';
  const spacesEl = $('spaces');
  function spaceIcons(k) {
    return window.SPACE_SERVICES(k).slice(0, 7).map((x) => `<i style="background:${x.bg}">${tileMark(x)}</i>`).join('');
  }
  $('spList').innerHTML = window.SPACES.map((sp, i) => {
    const n = window.SPACE_SERVICES(sp.k).filter((x) => !x.placeholder).length;
    return `<button class="spc" data-k="${sp.k}" style="transition-delay:${0.06 + i * 0.05}s"><div class="h"><b>${sp.name}</b><span>${n ? n + ' apps' : 'Empty'}</span></div>
      <div class="s">${sp.sub}</div><div class="ic">${spaceIcons(sp.k)}</div></button>`;
  }).join('');
  function setSpace(k) {
    if (!window.SPACES.some((x) => x.k === k)) return;
    space = k;
    $('spaceName').textContent = window.SPACES.find((x) => x.k === k).name;
    document.querySelectorAll('.spc').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    buildTiles(window.SPACE_SERVICES(k));
  }
  function openSpaces(open) {
    spacesEl.classList.toggle('on', open);
    spacesEl.setAttribute('aria-hidden', open ? 'false' : 'true');
    $('spaceBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) buzz(8);
  }
  $('spaceBtn').addEventListener('click', () => openSpaces(!spacesEl.classList.contains('on')));
  $('spX').addEventListener('click', () => openSpaces(false));
  document.querySelectorAll('.spc').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.k;
    if (k !== space) { link.send({ t: 'space', name: k }); setSpace(k); buzz(14); }
    setTimeout(() => openSpaces(false), 180);
  }));
  ['pointerdown', 'pointerup', 'pointermove'].forEach((ev) => spacesEl.addEventListener(ev, (e) => e.stopPropagation()));
  setSpace('living');

  // ---------- TV power (Roku on the network; the box switches to its own HDMI on power-on) ----------
  const pwr = $('pwrBtn');
  let tv = { found: false, on: null, hdmi: null, busy: false, hint: '' }, lastHint = '';
  function tvStatus(m) {
    tv = { ...tv, ...m };
    pwr.classList.toggle('on', tv.on === true);
    pwr.classList.toggle('busy', !!tv.busy);
    pwr.classList.toggle('lost', !tv.found);
    pwr.setAttribute('aria-pressed', tv.on === true ? 'true' : 'false');
    $('pwrLbl').textContent = !tv.found ? 'TV power' : tv.busy ? (tv.on ? 'Turning off…' : 'Turning on…') : tv.on === true ? 'Turn TV off' : 'Turn TV on';
    $('pwrSub').textContent = !tv.found ? 'Looking for your TV…' : `${tv.name || 'TV'}${tv.on === true ? ' · On' : tv.on === false ? ' · Off' : ''}`;
    $('pwHint').hidden = !tv.hint; $('pwHint').textContent = tv.hint || '';
    $('pwIpBox').hidden = !!tv.found;
    document.querySelectorAll('#pwHdmi button').forEach((b) => b.classList.toggle('on', +b.dataset.h === tv.hdmi));
    if (tv.hint && tv.hint !== lastHint) flashTip(tv.hint);
    lastHint = tv.hint || '';
  }
  pwr.addEventListener('click', () => {
    if (!tv.found || !tv.hdmi) { flashTip(tv.found ? 'Pick the HDMI port first' : 'Still looking for your TV'); if (!tv.found) return; }
    link.send({ t: 'tv.power', on: tv.on === null ? undefined : !tv.on });
    pwr.classList.add('busy'); buzz(15);
  });
  document.querySelectorAll('#pwHdmi button').forEach((b) => b.addEventListener('click', () => {
    link.send({ t: 'tv.setup', hdmi: +b.dataset.h }); tvStatus({ hdmi: +b.dataset.h }); buzz(10);
  }));
  $('pwIpGo').addEventListener('click', () => { const ip = $('pwIp').value.trim(); if (ip) { link.send({ t: 'tv.setup', ip }); $('pwrSub').textContent = 'Checking…'; buzz(10); } });
  $('pwSearch').addEventListener('click', () => { link.send({ t: 'tv.setup', ip: '' }); $('pwrSub').textContent = 'Looking for your TV…'; });

  // ---------- Touchpad ⇄ arrow keys (corner switch on the pad; remembered on this phone) ----------
  const swapBtn = $('padSwap'), keysv = $('keysv');
  function setKeys(on, quiet) {
    pad.classList.toggle('keys', on);
    keysv.setAttribute('aria-hidden', on ? 'false' : 'true');
    swapBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    swapBtn.setAttribute('aria-label', on ? 'Switch to touchpad' : 'Switch to arrow keys');
    try { localStorage.setItem('remote-keys', on ? '1' : '0'); } catch (e) {}
    if (!quiet) buzz(8);
  }
  swapBtn.addEventListener('click', () => setKeys(!pad.classList.contains('keys')));
  [swapBtn, keysv].forEach((el) => ['pointerdown', 'pointerup', 'pointermove'].forEach((ev) => el.addEventListener(ev, (e) => e.stopPropagation())));
  try { if (localStorage.getItem('remote-keys') === '1') setKeys(true, true); } catch (e) {}

  // ---------- TV sounds (the box remembers; it tells every phone on connect and on change) ----------
  function paintSounds(v) { $('soundLine').setAttribute('aria-checked', v ? 'true' : 'false'); }
  $('soundLine').addEventListener('click', () => {
    const v = $('soundLine').getAttribute('aria-checked') !== 'true';
    paintSounds(v); link.send({ t: 'sounds', on: v }); buzz(10);
  });

  // ---------- TV theme (the TV remembers it; state tells us which is on) ----------
  const THEMES = [
    { k: 'light', name: 'Light', sw: 'linear-gradient(135deg,#FBFAF7,#E9E5DC)' },
    { k: 'dark', name: 'Dark', sw: 'linear-gradient(135deg,#2A2927,#121211)' },
    { k: 'nature', name: 'Nature', sw: 'linear-gradient(160deg,#9CC3D9 0%,#E7C9A0 45%,#4E7A5A 46%,#22402F 100%)' },
    { k: 'tech', name: 'Tech', sw: 'radial-gradient(circle at 30% 70%,#3B7BFF 0,#0D1424 45%,#06080D 100%)' },
    { k: 'rain', name: 'Rain', sw: 'linear-gradient(170deg,#3A4C5E 0%,#18222C 55%,#0A0F15 100%)' },
    { k: 'jungle', name: 'Jungle', sw: 'radial-gradient(circle at 60% 35%,#BFE8A8 0,#2F7A4A 30%,#12301F 62%,#06110A 100%)' },
    { k: 'aurora', name: 'Aurora', sw: 'linear-gradient(160deg,#7A5AE0 0%,#2BD9A8 42%,#0B1C24 70%,#050B12 100%)' },
  ];
  let tvTheme = 'light';
  const tsheet = $('tsheet');
  $('tgrid').innerHTML = THEMES.map((t) => `<button class="tcard" data-k="${t.k}"><i style="background:${t.sw}"></i><span>${t.name}</span></button>`).join('');
  $('athemes').innerHTML = THEMES.map((t) => `<button data-k="${t.k}"><i style="background:${t.sw}"></i>${t.name}</button>`).join('');
  function paintTheme(k) {
    if (k) tvTheme = k;
    document.querySelectorAll('.tcard,#athemes button').forEach((b) => b.classList.toggle('on', b.dataset.k === tvTheme));
    $('themeHint').textContent = (THEMES.find((t) => t.k === tvTheme) || THEMES[0]).name;
  }
  function pickTheme(k) { link.send({ t: 'theme', name: k }); paintTheme(k); buzz(10); }
  document.querySelectorAll('.tcard,#athemes button').forEach((b) => b.addEventListener('click', () => pickTheme(b.dataset.k)));
  $('themeLine').addEventListener('click', () => { sheet.hidden = true; tsheet.hidden = false; });
  $('tsX').addEventListener('click', () => { tsheet.hidden = true; });
  tsheet.addEventListener('click', (e) => { if (e.target === tsheet) tsheet.hidden = true; });
  ['pointerdown', 'pointerup'].forEach((ev) => tsheet.addEventListener(ev, (e) => e.stopPropagation()));
  paintTheme();

  // ---------- Add to Home Screen (offered once, gently; always in •••) ----------
  const standalone = !!(link.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const a2 = $('a2sheet');
  $('a2Line').hidden = standalone;
  function openA2() {
    sheet.hidden = true;
    const safe = link.status === 'local' || link.secure;
    $('a2Secure').hidden = safe;
    $('a2Ios').hidden = !safe || !ios; $('a2Other').hidden = !safe || ios; $('a2Note').hidden = !safe;
    a2.hidden = false;
    $('a2Point').hidden = !(safe && ios);   // Safari's Share button is at the bottom on iPhone
    if (safe && link.prepareInstall) Promise.resolve().then(() => link.prepareInstall()).catch(() => {});
    try { localStorage.setItem('tv-a2hs', '1'); } catch (e) {}
  }
  const closeA2 = () => { a2.hidden = true; $('a2Point').hidden = true; };
  $('a2Line').addEventListener('click', openA2);
  $('a2X').addEventListener('click', closeA2);
  a2.addEventListener('click', (e) => { if (e.target === a2) closeA2(); });
  $('a2GoSecure').addEventListener('click', () => { closeA2(); openVoiceSetup(); });
  ['pointerdown', 'pointerup'].forEach((ev) => a2.addEventListener(ev, (e) => e.stopPropagation()));
  // The one-time offer: Safari on https, paired, not yet an app, after the remote has been in use for a bit.
  let a2Offer = 0;
  function maybeOfferA2() {
    if (standalone || !ios || !link.secure || a2Offer) return;
    try { if (localStorage.getItem('tv-a2hs')) return; } catch (e) { return; }
    a2Offer = setTimeout(() => { if (sheet.hidden && ksheet.hidden && $('vsheet').hidden && $('kbd').hidden && mode !== 'voice') openA2(); else a2Offer = 0; }, 20000);
  }

  // ---------- One-time voice setup (trust the box's certificate, then move to https) ----------
  let vs = null;
  async function openVoiceSetup() {
    $('vsheet').hidden = false;
    $('vsErr').textContent = '';
    await checkTrust(false);
  }
  async function checkTrust(after) {
    try { vs = await link.voiceSetup(); } catch (e) { vs = null; }
    if (!vs || vs.available === false) {
      $('vsTrust').hidden = true; $('vsGo').hidden = true;
      $('vsErr').textContent = 'Voice isn’t set up on this TV box yet. Swipe and tap still work.';
      return;
    }
    $('vsGet').href = vs.trustUrl;
    $('vsTrust').hidden = vs.trusted; $('vsGo').hidden = !vs.trusted;
    $('vsErr').textContent = after && !vs.trusted ? 'The phone doesn’t trust the TV box yet. Check that “TV box” is turned on in Certificate Trust Settings.' : '';
  }
  $('vsX').addEventListener('click', () => { $('vsheet').hidden = true; });
  $('vsDone').addEventListener('click', async () => { $('vsDone').textContent = 'Checking…'; await checkTrust(true); $('vsDone').textContent = 'Done'; });
  $('vsSwitch').addEventListener('click', async () => {
    $('vsSwitch').textContent = 'Switching…';
    try { await vs.go(); } catch (e) { $('vsErr').textContent = 'Couldn’t switch. Make sure the phone is on the same Wi-Fi as the TV and try again.'; $('vsSwitch').textContent = 'Switch to the secure remote'; }
  });
  ['pointerdown', 'pointerup'].forEach((ev) => $('vsheet').addEventListener(ev, (e) => e.stopPropagation()));
  // ---------- Keyboard ----------
  // The TV tells us when a text box is selected (kbd.show / kbd.hide). Typing is sent live: the difference between
  // what was in the field and what is there now becomes Backspaces plus new text, so paste, autocomplete and
  // dictation all work. Return sends Enter.
  const kin = $('kbdIn');
  let kPrev = '', composing = false, kOpen = false;
  const KT = {
    text: { type: 'text', mode: 'text', ac: 'off', cap: 'sentences' },
    search: { type: 'search', mode: 'search', ac: 'off', cap: 'off', hint: 'search' },
    email: { type: 'email', mode: 'email', ac: 'email', cap: 'off' },
    password: { type: 'password', mode: 'text', ac: 'current-password', cap: 'off' },
    number: { type: 'text', mode: 'numeric', ac: 'off', cap: 'off' },
    url: { type: 'url', mode: 'url', ac: 'url', cap: 'off' },
  };
  function kbdShow(m, manual) {
    const k = KT[m.type] || KT.text;
    kin.type = k.type;
    kin.setAttribute('inputmode', k.mode);
    kin.setAttribute('autocomplete', k.ac);
    kin.setAttribute('autocapitalize', k.cap);
    kin.setAttribute('enterkeyhint', k.hint || 'go');
    kin.placeholder = m.label || (manual ? 'Type on the TV' : 'Type here');
    $('kbdLabel').textContent = m.label ? m.label : svcK === 'claudecode' ? 'Typing in Claude Code' : 'Typing on the TV';
    kin.value = manual ? '' : (m.type === 'password' ? '' : (m.value || ''));
    kPrev = kin.value;
    $('kbd').hidden = false;
    kOpen = true;
    $('kbdTap').hidden = false;
    // iOS opens the keyboard only from a tap. Try anyway; if it opened, the screen shrinks and the button goes away.
    try { kin.focus({ preventScroll: true }); } catch (e) {}
    buzz(10);
  }
  // Claude Code: terminal keys in the keyboard panel, and each Enter starts a fresh line.
  function setTermKeys() {
    const term = svcK === 'claudecode';
    $('termKeys').hidden = !term;
    $('kbdTab').textContent = term ? 'Tab' : 'Next field';
    if (term) $('kbdLabel').textContent = 'Typing in Claude Code';
  }
  $('termKeys').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const m = { t: 'key', key: b.dataset.k };
    if (b.dataset.shift) m.shift = true;
    if (b.dataset.ctrl) m.ctrl = true;
    link.send(m); buzz();
  }));
  function kbdHide() {
    if (!kOpen) return;
    kOpen = false;
    kin.blur();
    $('kbd').hidden = true;
  }
  function sendDiff() {
    const now = kin.value;
    let i = 0;
    while (i < kPrev.length && i < now.length && kPrev[i] === now[i]) i++;
    for (let n = kPrev.length - i; n > 0; n--) link.send({ t: 'key', key: 'Backspace' });
    if (now.length > i) link.send({ t: 'text', s: now.slice(i) });
    kPrev = now;
  }
  kin.addEventListener('compositionstart', () => { composing = true; });
  kin.addEventListener('compositionend', () => { composing = false; sendDiff(); });
  kin.addEventListener('input', () => { if (!composing) sendDiff(); });
  kin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendDiff(); link.send({ t: 'key', key: 'Enter' }); buzz(); if (svcK === 'claudecode') { kin.value = ''; kPrev = ''; } }
    else if (e.key === 'Backspace' && kin.value === '') link.send({ t: 'key', key: 'Backspace' });   // delete what was there before
    else if (e.key === 'Tab') { e.preventDefault(); link.send({ t: 'key', key: 'Tab' }); }
  });
  kin.addEventListener('focus', () => { $('kbdTap').hidden = true; });
  $('kbdTap').addEventListener('click', () => { kin.focus(); });
  $('kbdBack').addEventListener('click', () => {
    link.send({ t: 'key', key: 'Backspace' });
    kin.value = kin.value.slice(0, -1); kPrev = kin.value; buzz();
  });
  $('kbdTab').addEventListener('click', () => { link.send({ t: 'key', key: 'Tab' }); kin.value = ''; kPrev = ''; buzz(); });
  $('kbdEnter').addEventListener('click', () => { link.send({ t: 'key', key: 'Enter' }); buzz(); if (svcK === 'claudecode') { kin.value = ''; kPrev = ''; } });
  $('kbdDone').addEventListener('click', kbdHide);
  $('kbdBtn').addEventListener('click', () => kbdShow({ type: 'text' }, true));   // a tap, so the keyboard opens right away
  ['pointerdown', 'pointerup'].forEach((ev) => $('kbd').addEventListener(ev, (e) => e.stopPropagation()));
})();
