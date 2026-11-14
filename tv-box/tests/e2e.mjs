import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)(require_path());
function require_path() { return process.env.PW || 'playwright'; }
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const S = process.env.S, SERVER = 'http://127.0.0.1:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const proxy = process.env.HTTPS_PROXY;
const box = await chromium.launch({ args: ['--remote-debugging-port=9222', '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080',
  ] });
const ctx = await box.newContext({ viewport: { width: 1920, height: 1080 } });
// The real services aren't reachable from here: serve a stand-in page for each.
await ctx.route(/^https:\/\/(www\.youtube\.com|open\.spotify\.com|www\.netflix\.com|music\.apple\.com|www\.google\.com|claude\.ai|learningsuite\.byu\.edu|docs\.google\.com|example\.org|www\.example\.org)\//, (route) =>
  route.fulfill({ contentType: 'text/html', body: '<html><body style="background:#222;color:#fff;font:40px sans-serif"><h1>' + new URL(route.request().url()).host + '</h1><video></video><input id=q aria-label=Search><input id=pw type=password><div style="height:6000px"></div><script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; })</script></body></html>' }));
await ctx.route(/cdnjs\.cloudflare\.com/, (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
const tvPage = await ctx.newPage();
// Leave pop-up boxes for the agent to handle (Playwright would otherwise dismiss them itself).
let dialogs = [];
tvPage.on('dialog', (d) => dialogs.push(d.type()));
fs.rmSync(S + '/agentdir', { recursive: true, force: true });
const agent = spawn('node', [S + '/x/agent/agent.mjs'], { env: { ...process.env, TV_SERVER: SERVER, TV_AGENT_DIR: S + '/agentdir', PATH: process.env.PATH } });
let alog = '';
// The Claude Code terminal daemon (a plain shell stands in for claude).
const termd = spawn('node', [S + '/x/termd/termd.mjs'], { env: { ...process.env, TV_SERVER: SERVER, HOME: S, TERM_CMD: 'PS1="tv$ " exec bash --norc --noprofile -i' } });
termd.stderr.on('data', (d) => process.stdout.write('  [termd!] ' + d));
agent.stdout.on('data', (d) => { alog += d; process.stdout.write('  [agent] ' + d); });
agent.stderr.on('data', (d) => { alog += d; process.stdout.write('  [agent!] ' + d); });

let phoneB = null;
try {
  // Agent registers, then puts Chrome on our home.
  for (let i = 0; i < 40 && !tvPage.url().includes('/tv/'); i++) await sleep(250);
  ok(tvPage.url().includes('/tv/?tv='), 'agent opened TV home: ' + tvPage.url().replace(/k=\w+/, 'k=…'));
  await tvPage.waitForFunction(() => window.link && link.status === 'open', null, { timeout: 8000 });
  ok(true, 'TV page connected to relay');
  // Pairing screen shows a code + QR.
  await tvPage.waitForFunction(() => /[A-Z0-9]{3}·[A-Z0-9]{3}/.test(document.getElementById('code')?.textContent || ''), null, { timeout: 5000 });
  const code = (await tvPage.textContent('#code')).replace('·', '');
  ok(code.length === 6, 'TV shows pairing code ' + code);

  // Phone pairs by typed code.
  phoneB = await chromium.launch();
  const phone = await (await phoneB.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).newPage();
  phone.on('pageerror', (e) => console.log('PHONE ERROR ' + e.message));
  await phone.goto(SERVER + '/remote/');
  ok(await phone.evaluate(() => link.status) === 'need-pair', 'unpaired phone asks to pair');
  const res = await phone.evaluate((c) => link.pairCode(c), code);
  ok(res.name === 'iPhone', 'phone paired by code as ' + res.name);
  await phone.waitForFunction(() => window.link && link.status === 'open', null, { timeout: 5000 });
  await tvPage.waitForFunction(() => document.getElementById('statusText')?.textContent === 'iPhone', null, { timeout: 5000 });
  ok(true, 'TV shows phone connected');
  const bad = await phone.evaluate(() => link.pairCode('AAAAAA').then(() => 'ok', (e) => e.message));
  ok(/didn't match/.test(bad), 'wrong code gives a clear message');
  // Re-pair (bad code didn't break the saved key)
  await phone.reload(); await phone.waitForFunction(() => window.link && link.status === 'open', null, { timeout: 5000 });
  ok(true, 'phone reconnects after reload with saved key');

  // Messages: collect on phone.
  await phone.evaluate(() => { window.got = []; link.on((m) => got.push(m)); });
  await sleep(1800); // pair flip back to home
  // Swipe right twice on home -> focus moves
  const f0 = await tvPage.textContent('#name').catch(() => null);
  await phone.evaluate(() => link.send({ t: 'swipe', phase: 'end', vx: -1.2, dxTotal: -120 }));
  await sleep(900);
  const states = await phone.evaluate(() => got.filter((m) => m.t === 'state').map((m) => m.focus && m.focus.k));
  ok(states.length > 0 && states[states.length - 1] !== 'netflix', 'swipe moved focus on TV: ' + states.slice(-1));

  // Voice: "open youtube" -> intent -> TV opens -> agent navigates
  await phone.evaluate(() => link.send({ t: 'voice', phase: 'final', text: 'open youtube' }));
  await phone.waitForFunction(() => got.some((m) => m.t === 'intent' && m.kind === 'open'), null, { timeout: 5000 });
  ok(true, 'voice became an open intent');
  for (let i = 0; i < 40 && !/youtube/.test(tvPage.url()); i++) await sleep(250);
  ok(/youtube\.com\/tv/.test(tvPage.url()), 'agent opened YouTube TV: ' + tvPage.url());
  await phone.waitForFunction(() => got.some((m) => m.t === 'state' && m.mode === 'service' && m.k === 'youtube'), null, { timeout: 8000 });
  ok(true, 'phone told a service is showing');
  await sleep(2500);
  const ua = await tvPage.evaluate(() => navigator.userAgent);
  ok(/SMART-TV/.test(ua), 'YouTube got the TV user agent');
  const perm = await tvPage.evaluate(async () => [Notification.permission, (await navigator.permissions.query({ name: 'geolocation' })).state]);
  ok(perm[0] === 'denied' && perm[1] === 'denied', 'notification + location prompts blocked on services: ' + perm.join(','));
  await tvPage.screenshot({ path: S + '/shot-youtube.png' });

  // Pad + click inside service draw the pointer
  await phone.evaluate(() => { for (let i = 0; i < 5; i++) link.send({ t: 'pad', dx: 20, dy: 10 }); });
  await sleep(500);
  const dot = await tvPage.evaluate(() => !!window.__tv);
  ok(dot, 'overlay injected in service page');
  await tvPage.focus('#q');
  await phone.waitForFunction(() => got.some((m) => m.t === 'kbd.show' && m.label === 'Search'), null, { timeout: 4000 }).then(() => ok(true, 'phone told a text box got focus'), () => ok(false, 'kbd.show'));
  await phone.evaluate(() => { link.send({ t: 'text', s: 'abc' }); link.send({ t: 'key', key: 'Backspace' }); });
  await sleep(600);
  ok(await tvPage.inputValue('#q') === 'ab', 'phone typing reached the TV text box: ' + await tvPage.inputValue('#q'));
  await tvPage.focus('#pw');
  await phone.waitForFunction(() => got.some((m) => m.t === 'kbd.show' && m.type === 'password'), null, { timeout: 4000 }).then(() => ok(true, 'password box reported as password'), () => ok(false, 'password kbd'));
  await tvPage.evaluate(() => document.activeElement.blur());
  await phone.waitForFunction(() => got.length && got.filter((m) => /^kbd/.test(m.t)).slice(-1)[0].t === 'kbd.hide', null, { timeout: 4000 }).then(() => ok(true, 'keyboard hidden when focus leaves'), () => ok(false, 'kbd.hide'));

  // A page pop-up (alert) is answered with OK from the phone.
  await phone.evaluate(() => link.send({ t: 'click' }));   // also gives the page a real click, so it may ask "Leave site?"
  await sleep(300);
  tvPage.evaluate(() => { window.alerted = 0; setTimeout(() => { alert('Are you still watching?'); window.alerted = 1; }, 0); }).catch(() => {});
  await phone.waitForFunction(() => got.some((m) => m.t === 'toast' && /still watching/.test(m.text)), null, { timeout: 4000 })
    .then(() => ok(true, 'phone told about the pop-up'), () => ok(false, 'phone told about pop-up'));
  await phone.evaluate(() => link.send({ t: 'tap' }));
  await sleep(500);
  ok(await tvPage.evaluate(() => window.alerted).catch(() => 0) === 1, 'tap on the phone pressed OK on the pop-up');
  // Home from phone (the page has a "Leave site?" handler)
  await phone.evaluate(() => link.send({ t: 'home' }));
  for (let i = 0; i < 40 && !tvPage.url().includes('/tv/'); i++) await sleep(250);
  ok(tvPage.url().includes('/tv/'), 'Home returned to TV page');
  await tvPage.waitForFunction(() => window.link && link.status === 'open', null, { timeout: 8000 });
  ok(!/SMART-TV/.test(await tvPage.evaluate(() => navigator.userAgent)), 'normal user agent back on home');

  // Apps grid: from home, the phone's Apps button opens it; swipes move; back closes.
  await phone.click('#appsBtn').catch(() => phone.evaluate(() => link.send({ t: 'apps' })));
  await tvPage.waitForFunction(() => document.getElementById('screen').className.includes('m-apps'), null, { timeout: 4000 })
    .then(() => ok(true, 'Apps button opens the grid on the TV'), () => ok(false, 'apps grid opens'));
  const g0 = await tvPage.textContent('.gname.on').catch(() => '');
  await phone.evaluate(() => link.send({ t: 'swipe', phase: 'end', dxTotal: -80, dyTotal: 0, vx: -1 }));
  await sleep(400);
  const g1 = await tvPage.textContent('.gname.on').catch(() => '');
  ok(g0 && g1 && g0 !== g1, `swipe moves the selection in the grid (${g0} > ${g1})`);
  await phone.waitForFunction(() => got.some((m) => m.t === 'state' && m.mode === 'apps'), null, { timeout: 3000 }).then(() => ok(true, 'phone told the grid is showing'), () => ok(false, 'apps state'));
  await phone.evaluate(() => link.send({ t: 'back' }));
  await tvPage.waitForFunction(() => !document.getElementById('screen').className.includes('m-apps'), null, { timeout: 3000 })
    .then(() => ok(true, 'Back closes the grid'), () => ok(false, 'back closes grid'));
  // The phone shows the same grid; tapping a tile opens that app on the TV.
  await phone.click('#appsBtn').catch(() => phone.evaluate(() => link.send({ t: 'apps' })));
  await phone.waitForSelector('#agrid .at[data-k="spotify"]', { state: 'visible', timeout: 4000 })
    .then(() => ok(true, 'phone shows the apps grid'), () => ok(false, 'phone apps grid visible'));
  await phone.click('#agrid .at[data-k="spotify"]').catch(() => {});
  for (let i = 0; i < 40 && !/spotify/.test(tvPage.url()); i++) await sleep(250);
  ok(/spotify/.test(tvPage.url()), 'tapping Spotify on the phone grid opened it on the TV');
  await sleep(800);
  await phone.evaluate(() => link.send({ t: 'home' }));
  for (let i = 0; i < 40 && !tvPage.url().includes('/tv/'); i++) await sleep(250);
  await sleep(1500);
  // Chrome: open from the phone grid, type an address, back/forward, then a search.
  await phone.evaluate(() => link.send({ t: 'apps.pick', k: 'chrome' }));
  for (let i = 0; i < 40 && !/google/.test(tvPage.url()); i++) await sleep(250);
  ok(/www\.google\.com/.test(tvPage.url()), 'Chrome card opens Google');
  await phone.waitForSelector('#addr', { state: 'visible', timeout: 4000 }).then(() => ok(true, 'phone shows the browser bar'), () => ok(false, 'browser bar'));
  await phone.evaluate(() => link.send({ t: 'nav', a: 'go', q: 'example.org' }));
  for (let i = 0; i < 40 && !/example\.org/.test(tvPage.url()); i++) await sleep(250);
  ok(/^https:\/\/example\.org/.test(tvPage.url()), 'address bar goes to a site: ' + tvPage.url());
  await phone.waitForFunction(() => got.some((m) => m.t === 'state' && m.k === 'chrome' && /example\.org/.test(m.url || '')), null, { timeout: 4000 }).then(() => ok(true, 'phone gets the current address'), () => ok(false, 'state url'));
  await phone.evaluate(() => link.send({ t: 'nav', a: 'back' }));
  for (let i = 0; i < 40 && !/google/.test(tvPage.url()); i++) await sleep(250);
  ok(/google/.test(tvPage.url()), 'Back goes to the previous page');
  await phone.evaluate(() => link.send({ t: 'nav', a: 'forward' }));
  for (let i = 0; i < 40 && !/example/.test(tvPage.url()); i++) await sleep(250);
  ok(/example/.test(tvPage.url()), 'Forward works');
  // Two-finger scroll on the touchpad: drag up reads further down, keeps coasting, never clicks.
  const twoFinger = (y0, y1) => phone.evaluate(async ([y0, y1]) => {
    const pad = document.getElementById('pad'); pad.setPointerCapture = () => {};
    const ev = (type, id, x, y) => pad.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: id === 11 }));
    window.sentClicks = 0; const send = link.send.bind(link); link.send = (m) => { if (m.t === 'click' || m.t === 'pad') sentClicks++; return send(m); };
    ev('pointerdown', 11, 150, y0); ev('pointerdown', 12, 220, y0 + 5);
    for (let i = 1; i <= 12; i++) { const y = y0 + (y1 - y0) * i / 12; ev('pointermove', 11, 150, y); ev('pointermove', 12, 220, y + 5); await new Promise((r) => setTimeout(r, 16)); }
    ev('pointerup', 11, 150, y1); ev('pointerup', 12, 220, y1 + 5);
    await new Promise((r) => setTimeout(r, 1200));
    link.send = send;
    return sentClicks;
  }, [y0, y1]);
  await tvPage.evaluate(() => window.scrollTo(0, 0));
  const stray = await twoFinger(600, 300);
  const sy1 = await tvPage.evaluate(() => scrollY);
  ok(sy1 > 900, 'two fingers dragged up scroll the page down, with a coast: ' + sy1 + 'px');
  ok(stray === 0, 'two-finger scroll sends no pointer moves or clicks');
  await twoFinger(300, 450);
  const sy2 = await tvPage.evaluate(() => scrollY);
  ok(sy2 < sy1, 'dragging down scrolls back up: ' + sy2 + 'px');
  await phone.evaluate(() => link.send({ t: 'nav', a: 'go', q: 'best pizza' }));
  for (let i = 0; i < 40 && !/search\?q=best/.test(tvPage.url()); i++) await sleep(250);
  ok(/google\.com\/search\?q=best%20pizza/.test(tvPage.url()), 'words become a Google search');
  // A site opens a pop-up window (like "Sign in with Google"): the remote drives it, Home closes it.
  const popP = ctx.waitForEvent('page', { timeout: 5000 });
  await tvPage.evaluate(() => { window.__pop = window.open('https://www.google.com/signin', '_blank', 'popup'); });
  const pop = await popP.catch(() => null);
  ok(!!pop, 'the page opened a pop-up window');
  if (pop) {
    await pop.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(2500); // the agent notices within a second
    await pop.evaluate(() => document.getElementById('q').focus());
    await phone.evaluate(() => link.send({ t: 'text', s: 'jared' }));
    await sleep(800);
    ok(await pop.evaluate(() => document.getElementById('q').value) === 'jared', 'phone typing goes into the pop-up window');
    ok(await tvPage.evaluate(() => !window.__pop.closed), 'pop-up still open while in use');
    await phone.evaluate(() => link.send({ t: 'home' }));
    for (let i = 0; i < 40 && !tvPage.url().includes('/tv/'); i++) await sleep(250);
    ok(pop.isClosed(), 'Home closes the pop-up window');
    ok(tvPage.url().includes('/tv/'), 'and goes Home on the TV');
    await sleep(1500);
  }
  // Claude card
  await phone.evaluate(() => link.send({ t: 'apps.pick', k: 'claude' }));
  for (let i = 0; i < 40 && !/claude\.ai/.test(tvPage.url()); i++) await sleep(250);
  ok(/claude\.ai/.test(tvPage.url()), 'Claude card opens claude.ai');
  await phone.evaluate(() => link.send({ t: 'home' }));
  for (let i = 0; i < 40 && !tvPage.url().includes('/tv/'); i++) await sleep(250);
  await sleep(1500);

  // Claude Code card: a terminal on the TV, typed into from the phone.
  const screenText = () => tvPage.evaluate(() => document.querySelector('.xterm-rows')?.textContent || '');
  const waitScreen = async (re, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(await screenText().catch(() => ''))) return true; await sleep(200); } return false; };
  await phone.evaluate(() => link.send({ t: 'apps.pick', k: 'claudecode' }));
  for (let i = 0; i < 40 && !/\/term\//.test(tvPage.url()); i++) await sleep(250);
  ok(/\/term\/\?tv=/.test(tvPage.url()), 'Claude Code card opens the terminal page');
  await phone.waitForFunction(() => got.some((m) => m.t === 'state' && m.k === 'claudecode' && m.term), null, { timeout: 4000 }).then(() => ok(true, 'phone is told it is in Claude Code'), () => ok(false, 'claudecode state'));
  ok(await waitScreen(/tv\$/), 'terminal shows the shell prompt');
  await phone.waitForFunction(() => got.some((m) => m.t === 'kbd.show'), null, { timeout: 4000 }).then(() => ok(true, 'phone keyboard opens for the terminal'), () => ok(false, 'kbd.show in terminal'));
  await phone.evaluate(() => { link.send({ t: 'text', s: 'echo hi-$((2+3))' }); link.send({ t: 'key', key: 'Enter' }); });
  ok(await waitScreen(/hi-5/), 'phone typing runs a command in the terminal');
  await phone.evaluate(() => { link.send({ t: 'text', s: 'sleep 30' }); link.send({ t: 'key', key: 'Enter' }); });
  await sleep(500);
  await phone.evaluate(() => link.send({ t: 'key', key: 'c', ctrl: true }));
  await sleep(500); // (the terminal drops anything typed in the same instant as Ctrl+C)
  await phone.evaluate(() => { link.send({ t: 'text', s: 'echo after-$((1+1))' }); link.send({ t: 'key', key: 'Enter' }); });
  ok(await waitScreen(/after-2/), 'Ctrl+C from the phone stops a command');
  await phone.evaluate(() => link.send({ t: 'home' }));
  for (let i = 0; i < 40 && !tvPage.url().includes('/tv/'); i++) await sleep(250);
  await sleep(1200);
  await phone.evaluate(() => link.send({ t: 'apps.pick', k: 'claudecode' }));
  for (let i = 0; i < 40 && !/\/term\//.test(tvPage.url()); i++) await sleep(250);
  ok(await waitScreen(/hi-5/), 'going Home and back keeps the terminal session');
  await tvPage.screenshot({ path: S + '/shot-term.png' });
  // (Who may open the terminal is covered by tests/term.mjs: here the phone runs on the box itself.)
  await phone.evaluate(() => link.send({ t: 'home' }));
  for (let i = 0; i < 40 && !tvPage.url().includes('/tv/'); i++) await sleep(250);
  await sleep(1500);

  // Themes: picked on the phone, shown on the TV, remembered by the box.
  const theme = () => tvPage.evaluate(() => window.TVTheme && TVTheme.current);
  await phone.evaluate(() => { got.length = 0; link.send({ t: 'theme', name: 'dark' }); });
  await tvPage.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 4000 }).then(() => ok(true, 'phone switches the TV to the Dark theme'), () => ok(false, 'dark theme'));
  await phone.waitForFunction(() => got.some((m) => m.t === 'state' && m.theme === 'dark'), null, { timeout: 4000 }).then(() => ok(true, 'phone is told the theme'), () => ok(false, 'theme in state'));
  await phone.evaluate(() => link.send({ t: 'theme', name: 'nope' }));
  await sleep(500);
  ok(await theme() === 'dark', 'an unknown theme name is ignored');
  await tvPage.evaluate(() => { try { localStorage.removeItem('tv-theme'); } catch {} });
  await tvPage.reload();
  await tvPage.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 6000 }).then(() => ok(true, 'the box remembers the theme across a reload'), () => ok(false, 'theme remembered'));
  const errs = []; tvPage.on('pageerror', (e) => errs.push(e.message));
  for (const t of ['nature', 'tech', 'rain', 'jungle', 'aurora']) {
    await phone.evaluate((n) => link.send({ t: 'theme', name: n }), t);
    await tvPage.waitForFunction((n) => document.documentElement.dataset.theme === n, t, { timeout: 4000 }).then(() => ok(true, t + ' theme shows'), () => ok(false, t + ' theme'));
    await sleep(1500);
    await tvPage.screenshot({ path: S + '/shot-theme-' + t + '.png' });
  }
  // Ambient sound: Rain and Jungle have it, it follows the TV sounds switch, and other themes are silent.
  const playing = () => tvPage.evaluate(() => window.TVAmbience && TVAmbience.playing);
  await phone.evaluate(() => link.send({ t: 'theme', name: 'rain' }));
  await tvPage.waitForFunction(() => TVAmbience.playing === 'rain', null, { timeout: 4000 }).then(() => ok(true, 'Rain plays its rainfall'), () => ok(false, 'rain ambience'));
  await phone.evaluate(() => link.send({ t: 'sounds', on: false }));
  await tvPage.waitForFunction(() => TVAmbience.playing === null, null, { timeout: 4000 }).then(() => ok(true, 'turning TV sounds off silences it'), () => ok(false, 'ambience follows the sounds switch'));
  await phone.evaluate(() => link.send({ t: 'sounds', on: true }));
  await phone.evaluate(() => link.send({ t: 'theme', name: 'jungle' }));
  await tvPage.waitForFunction(() => TVAmbience.playing === 'jungle', null, { timeout: 4000 }).then(() => ok(true, 'Jungle plays its own sound'), () => ok(false, 'jungle ambience'));
  await tvPage.evaluate(() => TVTheme.setBusy(true));
  ok(await playing() === null && await tvPage.evaluate(() => { const c = document.querySelector('canvas.fx'), g = c.getContext('2d'); let n = 0; const o = g.clearRect.bind(g); g.clearRect = (...a) => { n++; o(...a); }; return new Promise((r) => setTimeout(() => { g.clearRect = o; r(n === 0); }, 500)); }), 'sound and animation both stop while a service takes over');
  await tvPage.evaluate(() => TVTheme.setBusy(false));
  ok(await playing() === 'jungle', 'and come back afterwards');
  for (const k of ['rain', 'jungle']) {
    const a = await tvPage.evaluate(async (k) => { const b = await TVAmbience.render(k, 6), d = b.getChannelData(0); let peak = 0, sq = 0; for (let i = 0; i < d.length; i++) { peak = Math.max(peak, Math.abs(d[i])); sq += d[i] * d[i]; } return { peak, rms: Math.sqrt(sq / d.length) }; }, k);
    ok(a.rms > 0.004 && a.peak < 0.9, k + ' sound is audible and never clips (rms ' + a.rms.toFixed(3) + ', peak ' + a.peak.toFixed(2) + ')');
  }
  await phone.evaluate(() => link.send({ t: 'theme', name: 'aurora' }));
  await tvPage.waitForFunction(() => TVAmbience.playing === null, null, { timeout: 4000 }).then(() => ok(true, 'silent themes stay silent'), () => ok(false, 'aurora is silent'));
  ok(!errs.length, 'no page errors in the themes ' + errs.join('; '));
  await phone.evaluate(() => link.send({ t: 'theme', name: 'light' }));
  await tvPage.waitForFunction(() => !document.documentElement.dataset.theme, null, { timeout: 4000 }).then(() => ok(true, 'back to Light'), () => ok(false, 'light'));
  await sleep(800);

  // TV sounds: on by default, switched from the phone, remembered by the box.
  ok(await tvPage.evaluate(() => window.TVSound && TVSound.on === true), 'TV sounds are on by default');
  const sndErrs = []; tvPage.on('pageerror', (e) => sndErrs.push(e.message));
  await phone.evaluate(() => { got.length = 0; link.send({ t: 'sounds', on: false }); });
  await tvPage.waitForFunction(() => TVSound.on === false, null, { timeout: 4000 }).then(() => ok(true, 'phone turns TV sounds off'), () => ok(false, 'sounds off'));
  await phone.waitForFunction(() => got.some((m) => m.t === 'sounds' && m.on === false), null, { timeout: 4000 }).then(() => ok(true, 'phone hears the new setting'), () => ok(false, 'sounds echo'));
  await tvPage.evaluate(() => { try { localStorage.removeItem('tv-sounds'); } catch {} });
  await tvPage.reload();
  await tvPage.waitForFunction(() => window.TVSound && TVSound.on === false, null, { timeout: 6000 }).then(() => ok(true, 'the box remembers sounds off across a reload'), () => ok(false, 'sounds remembered'));
  await phone.evaluate(() => link.send({ t: 'sounds', on: true }));
  await tvPage.waitForFunction(() => TVSound.on === true, null, { timeout: 4000 }).then(() => ok(true, 'and back on'), () => ok(false, 'sounds on'));
  for (let i = 0; i < 6; i++) { await phone.evaluate(() => link.send({ t: 'swipe', phase: 'move', dx: -60, dy: 0 })); await sleep(40); }
  await phone.evaluate(() => link.send({ t: 'swipe', phase: 'end', dx: -60, dxTotal: -360, dyTotal: 0 }));
  await sleep(800);
  ok(!sndErrs.length, 'swiping with sounds on has no page errors ' + sndErrs.join('; '));

  // Spaces: Living room / School / Games. Switched from the phone, by voice, or on the TV; remembered by the box.
  const tvSpace = (n) => tvPage.waitForFunction((x) => { try { return localStorage.getItem('tv-space') === x && document.querySelector('.card, #screen') && window.link && link.status === 'open'; } catch { return false; } }, n, { timeout: 8000 });
  await phone.evaluate(() => { got.length = 0; link.send({ t: 'space', name: 'school' }); });
  await tvSpace('school').then(() => ok(true, 'phone switches the TV to School'), () => ok(false, 'space to tv'));
  await phone.waitForFunction(() => got.some((m) => m.t === 'space' && m.name === 'school'), null, { timeout: 4000 }).then(() => ok(true, 'phones hear the new space'), () => ok(false, 'space echo'));
  await phone.evaluate(() => link.send({ t: 'space', name: 'nope' }));
  await phone.evaluate(() => { got.length = 0; link.send({ t: 'voice', phase: 'final', text: 'go to games' }); });
  await tvSpace('games').then(() => ok(true, '"go to games" switches by voice'), () => ok(false, 'space by voice'));
  await sleep(1500);
  ok(!(await tvPage.evaluate(() => /m-pairing/.test(document.getElementById('screen')?.className || ''))), 'the TV comes back after a space switch without the pair screen');
  await phone.evaluate(() => { got.length = 0; });
  await tvPage.evaluate(() => link.send({ t: 'space', name: 'school' }));
  await phone.waitForFunction(() => got.some((m) => m.t === 'space' && m.name === 'school'), null, { timeout: 4000 }).then(() => ok(true, 'a space picked on the TV reaches the phone'), () => ok(false, 'space from tv'));
  const svcs = await tvPage.evaluate(() => (window.SERVICES || []).map((x) => x.k));
  ok(['gdocs', 'gsheets', 'learningsuite'].every((k) => svcs.includes(k)), 'School apps are in the service list: ' + svcs.filter((k) => /^(gdocs|gsheets|learningsuite)$/.test(k)).join(','));
  await phone.evaluate(() => link.send({ t: 'voice', phase: 'final', text: 'open learning suite' }));
  for (let i = 0; i < 40 && !/learningsuite/.test(tvPage.url()); i++) await sleep(250);
  ok(/learningsuite\.byu\.edu/.test(tvPage.url()), '"open learning suite" opens BYU Learning Suite: ' + tvPage.url().slice(0, 60));
  await phone.evaluate(() => link.send({ t: 'home' }));
  for (let i = 0; i < 40 && !tvPage.url().includes('/tv/'); i++) await sleep(250);
  await sleep(1200);
  await tvSpace('school').then(() => ok(true, 'the TV stays in School after going Home'), () => ok(false, 'school after home'));
  await phone.evaluate(() => link.send({ t: 'space', name: 'living' }));
  await tvSpace('living').catch(() => {});
  await sleep(1500);

  // From inside a service, Apps goes Home straight into the grid.
  await phone.evaluate(() => link.send({ t: 'voice', phase: 'final', text: 'open youtube' }));
  for (let i = 0; i < 40 && !/youtube/.test(tvPage.url()); i++) await sleep(250);
  await sleep(800);
  await phone.evaluate(() => link.send({ t: 'apps' }));
  for (let i = 0; i < 40 && !tvPage.url().includes('/tv/'); i++) await sleep(250);
  await tvPage.waitForFunction(() => document.getElementById('screen')?.className.includes('m-apps'), null, { timeout: 6000 })
    .then(() => ok(true, 'Apps from inside a service lands in the grid'), () => ok(false, 'apps from service'));
  await phone.evaluate(() => link.send({ t: 'home' }));
  await sleep(800);

  // Voice while in service: search intent -> home -> results on TV
  await phone.evaluate(() => link.send({ t: 'voice', phase: 'final', text: 'open spotify' }));
  for (let i = 0; i < 40 && !/spotify/.test(tvPage.url()); i++) await sleep(250);
  ok(/spotify/.test(tvPage.url()), 'opened Spotify');
  await sleep(1500);
  await phone.evaluate(() => link.send({ t: 'voice', phase: 'final', text: 'search for the office' }));
  for (let i = 0; i < 40 && !tvPage.url().includes('/tv/'); i++) await sleep(250);
  await tvPage.waitForFunction(() => document.querySelector('.screen, body').className.includes('results') || document.querySelectorAll('#rrow .r').length > 0, null, { timeout: 8000 }).then(() => ok(true, 'search from a service came Home and showed results'), () => ok(false, 'results after search from service'));
  await sleep(1500);
  const mode = await tvPage.evaluate(() => document.getElementById('screen').className);
  ok(/results/.test(mode), 'TV still showing results 1.5s later (' + mode + ')');
  await tvPage.screenshot({ path: S + '/shot-results.png' });

  // A fresh TV page (no memory of pairing) in pair mode must show the server's real code.
  const fresh = await (await box.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await fresh.goto(tvPage.url().replace(/#.*$/, ''));
  await fresh.waitForFunction(() => /^[A-Z0-9]{3}·[A-Z0-9]{3}$/.test(document.getElementById('code')?.textContent || '') && !/K7Q/.test(document.getElementById('code').textContent), null, { timeout: 8000 })
    .then(() => ok(true, 'fresh TV page in pair mode shows a real code from the server'), () => ok(false, 'fresh TV page shows real code (got ' + 'see screen' + ')'));
  const freshCode = (await fresh.textContent('#code').catch(() => '')).replace('·', '');
  const look = await fetch(SERVER + '/api/pair/lookup', { method: 'POST', body: JSON.stringify({ code: freshCode }) });
  ok(look.ok, 'that code is valid on the server: ' + freshCode);
  await fresh.context().close();
  // With no phone connected, the TV gets a small pairing code after ~10s.
  const hint = tvPage.evaluate(() => new Promise((r) => { link.on((m) => { if (m.t === 'pair.hint' && m.code) r(m.code); }); setTimeout(() => r(null), 15000); }));
  await phoneB.close(); phoneB = null;
  ok(/^[A-Z0-9]{6}$/.test(await hint || ''), 'TV gets a pairing hint when no phone is connected');
  // Unpair

  const r = await fetch(SERVER + '/api/remote/check', { method: 'POST', body: JSON.stringify({ tv: 'x', key: 'y' }) }).then((r) => r.json());
  ok(r.paired === false, 'check endpoint says unknown key is not paired');
} catch (e) {
  ok(false, 'exception: ' + e.message);
  await tvPage.screenshot({ path: S + '/shot-fail.png' }).catch(() => {});
} finally {
  agent.kill();
  termd.kill();
  if (phoneB) await phoneB.close().catch(() => {});
  await box.close();
}
