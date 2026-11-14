// The one channel between the phone remote, the TV page and the box.
//
//   link.send(msg)       send a message to the room
//   link.on(fn)          get every message from the room, plus local {t:'link', status, error?}
//   link.status          'local' | 'connecting' | 'open' | 'reconnecting' | 'need-pair' | 'unpaired'
//   link.pairCode(code)  phone only: pair by the 6-character code on the TV. Resolves {name} or throws Error(message)
//   link.unpair()        phone only: forget this TV
//   link.secure          true when the page is on https (the phone may use its microphone)
//   link.standalone      phone only: true when running as the home-screen app (not in Safari)
//   link.prepareInstall() phone only, paired: call when showing "Add to Home Screen". The app it
//                        makes then pairs itself on first launch (iPhone apps don't share Safari's storage).
//   link.showCode()      phone only, unpaired: ask the TV to show a pairing code now (done automatically too)
//   link.voiceSetup()    phone only, on http: resolves { trusted, trustUrl, go() }.
//                        trusted = the phone already trusts the box; go() moves to the https address, still paired.
//                        If not trusted, open trustUrl in Safari to install the box's certificate first.
//
// The TV page connects when its address has ?tv=…&k=… (the box puts them there).
// The phone connects with the key it saved when it paired (from the QR code's #pair=… or a typed code).
// With neither (or ?local on the phone), it falls back to BroadcastChannel so tv/ and remote/
// can be tried side by side in one browser with shared/stub.js.
(function () {
  const fns = [];
  const emit = (m) => fns.forEach((f) => { try { f(m); } catch (e) { console.error(e); } });
  const isRemote = /\/remote\//.test(location.pathname);
  const STORE = 'tv-remote';
  const qs = new URLSearchParams(location.search);

  const standalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const link = { status: 'local', secure: window.isSecureContext && location.protocol === 'https:', standalone, on(fn) { fns.push(fn); }, send() {}, pairCode, unpair, voiceSetup, prepareInstall, showCode };
  window.link = link;

  function setStatus(s, extra) {
    link.status = s;
    emit({ t: 'link', status: s, ...extra });
  }

  // ---- Local fallback ---------------------------------------------------------------
  function local() {
    const ch = 'BroadcastChannel' in window ? new BroadcastChannel('tv-room') : null;
    if (ch) ch.onmessage = (e) => emit(e.data);
    link.send = (msg) => { if (ch) ch.postMessage(msg); };
    link.status = 'local';
  }

  // ---- Relay --------------------------------------------------------------------------
  let ws = null, creds = null, tries = 0, queue = [], pingTimer = 0, stopped = false, wired = false;
  let lastRx = 0, retryTimer = 0, openTimer = 0, wakeTimer = 0;

  function connect() {
    if (!creds || stopped || ws) return;
    clearTimeout(retryTimer);
    setStatus(tries ? 'reconnecting' : 'connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const p = new URLSearchParams({ tv: creds.tv, role: creds.role, k: creds.key, origin: location.origin });
    const sock = new WebSocket(`${proto}//${location.host}/ws?${p}`);
    ws = sock;
    // Phones can sit on a dead "connecting" socket for a long time: give up after 6 seconds.
    clearTimeout(openTimer);
    openTimer = setTimeout(() => { if (sock.readyState !== 1) lost(sock); }, 6000);
    sock.onopen = () => {
      clearTimeout(openTimer);
      tries = 0;
      lastRx = Date.now();
      setStatus('open');
      const q = queue; queue = [];
      q.forEach((m) => sock.send(JSON.stringify(m)));
      clearInterval(pingTimer);
      // Heartbeat: the box answers every ping. Silence means the connection died quietly
      // (common after a phone sleeps or the box restarts), so start over.
      pingTimer = setInterval(() => {
        if (sock.readyState !== 1) return;
        if (Date.now() - lastRx > 25000) return lost(sock);
        sock.send('{"t":"ping"}');
      }, 10000);
    };
    sock.onmessage = (e) => {
      lastRx = Date.now();
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') return;
      if (m.t === 'unpaired') return forget();
      if (m.t === 'presence' && creds.role === 'tv') {
        // The TV page shows who's connected as hello / bye.
        emit(m.remotes.length ? { t: 'hello', name: m.remotes[m.remotes.length - 1] } : { t: 'bye' });
      }
      emit(m);
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      if (e.code === 4001) { ws = null; return forget(); }
      lost(sock);
    };
    sock.onerror = () => {};
  }

  // The connection is gone (closed, timed out or silent): retry with backoff.
  function lost(sock) {
    if (ws !== sock) return;
    ws = null;
    clearInterval(pingTimer);
    clearTimeout(openTimer);
    try { sock.onclose = null; sock.close(); } catch {}
    if (stopped) return;
    setStatus('reconnecting');
    // A phone whose key was removed is turned away at connect. Check once it keeps failing.
    if (creds.role === 'remote' && tries === 2) checkPaired();
    const wait = Math.min(8000, 400 * 2 ** tries++);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, wait + Math.random() * 300);
  }

  // Back from the lock screen / another app: check the connection right away.
  function wake() {
    if (!creds || stopped) return;
    if (!ws) { tries = 0; return connect(); }
    if (ws.readyState !== 1) return;
    const sock = ws, sent = Date.now();
    try { sock.send('{"t":"ping"}'); } catch { return lost(sock); }
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => { if (ws === sock && lastRx < sent) { tries = 0; lost(sock); } }, 2500);
  }

  function checkPaired() {
    fetch('/api/remote/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tv: creds.tv, key: creds.key }) })
      .then((r) => r.json())
      .then((j) => { if (j && j.paired === false) forget(); })
      .catch(() => {});
  }

  function relay(c) {
    creds = c;
    stopped = false;
    link.send = (msg) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
      else if (queue.length < 20 && !/^(swipe|pad|scroll)$/.test(msg.t)) queue.push(msg);
    };
    connect();
    if (wired) return;
    wired = true;
    addEventListener('online', wake);
    addEventListener('pageshow', wake);
    addEventListener('focus', wake);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake());
  }

  // ---- Phone pairing -----------------------------------------------------------------
  function saved() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
  }
  function phoneName() {
    const ua = navigator.userAgent;
    return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Phone';
  }
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.');
    return j;
  }
  async function claim(tv, token) {
    const j = await post('/api/pair/claim', { tv, token, name: phoneName() });
    try { localStorage.setItem(STORE, JSON.stringify({ tv: j.tv, key: j.key, name: j.name })); } catch {}
    if (ws) { const old = ws; ws = null; old.close(); }
    relay({ tv: j.tv, key: j.key, role: 'remote' });
    return { name: j.name };
  }
  async function pairCode(code) {
    const { tv, token } = await post('/api/pair/lookup', { code });
    return claim(tv, token);
  }
  function forget() {
    try { localStorage.removeItem(STORE); } catch {}
    stopped = true;
    if (ws) { const old = ws; ws = null; old.close(); }
    setStatus('unpaired');
    if (isRemote) showCode();
  }
  function unpair() {
    if (ws && ws.readyState === 1) ws.send('{"t":"unpair"}');
    setTimeout(() => { if (!stopped) forget(); }, 400);
  }

  // Home-screen app: point the page's manifest at one with a one-time pairing token in its start
  // address, so the new app pairs itself when it first opens. If iOS ignores it, showCode() is the way in.
  async function prepareInstall() {
    const s = saved();
    if (!s) return { ok: false };
    try {
      const j = await post('/api/pair/app', { tv: s.tv, key: s.key });
      let el = document.querySelector('link[rel="manifest"]');
      if (!el) { el = document.createElement('link'); el.rel = 'manifest'; document.head.appendChild(el); }
      el.href = j.manifest;
      return { ok: true };
    } catch { return { ok: false }; }
  }
  function showCode() {
    return fetch('/api/pair/show', { method: 'POST' }).then((r) => r.json()).then((j) => !!j.shown, () => false);
  }

  async function voiceSetup() {
    const info = await fetch('/api/secure').then((r) => r.json()).catch(() => ({}));
    const trustUrl = `http://${location.host}/trust`;
    if (!info.https) return { trusted: false, available: false, trustUrl, go() {} };
    // If the phone trusts the box, this https request succeeds.
    const trusted = await fetch(`https://${info.host}/api/health`, { cache: 'no-store' }).then((r) => r.ok, () => false);
    return {
      trusted, available: true, trustUrl,
      async go() {
        const s = saved();
        if (!s) return;
        const j = await post('/api/pair/handoff', { key: s.key });
        location.href = j.url;
      },
    };
  }

  // ---- Start ------------------------------------------------------------------------
  if (!isRemote) {
    if (qs.get('tv') && qs.get('k')) relay({ tv: qs.get('tv'), key: qs.get('k'), role: 'tv' });
    else local();
    return;
  }

  const hash = location.hash.match(/pair=([0-9a-f]+)\.([0-9a-f]+)/);
  const s = saved();
  if (hash) {
    history.replaceState(null, '', location.pathname + location.search);
    link.status = 'connecting';
    claim(hash[1], hash[2]).then(
      (r) => emit({ t: 'paired', name: r.name, self: true }),
      (e) => {
        // An old QR code: if this phone is already paired, just carry on.
        if (s && s.tv && s.key) relay({ tv: s.tv, key: s.key, role: 'remote' });
        else { setStatus('need-pair', { error: standalone ? '' : e.message }); showCode(); }
      }
    );
  } else if (/[?&]local\b/.test(location.search)) local();
  else if (s && s.tv && s.key) relay({ tv: s.tv, key: s.key, role: 'remote' });
  else {
    link.status = 'need-pair';
    setTimeout(() => emit({ t: 'link', status: 'need-pair' }), 0); // after the page has called link.on()
    showCode(); // the TV shows a code to type in
  }
})();
