// DS games: TV page shows the top screen, the phone pad gets the bottom screen and sends input,
// save slots work, and leaving the game keeps an auto save. Starts its own server. Run:
//   GAME_ROM=/path/to/game.nds PW=/path/to/playwright node tests/games.mjs
// Without GAME_ROM it checks only the parts that need no game.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PW || 'playwright');

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvgames-'));
const HP = 8483, SERVER = `http://127.0.0.1:${HP}`;
const ROM = process.env.GAME_ROM || '';
const SHOTS = process.env.SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };

fs.mkdirSync(TMP + '/state/games/roms', { recursive: true });
let g = '';
if (ROM) { fs.symlinkSync(path.resolve(ROM), TMP + '/state/games/roms/' + path.basename(ROM)); }
const srvLog = [];
const srv = spawn('node', [path.join(APP, 'server/server.mjs')], { env: { ...process.env, TV_STATE_DIR: TMP + '/state', HTTP_PORT: HP, NO_HTTPS: '1', TV_HOST: 'localhost', ROKU_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', (d) => srvLog.push(String(d)));
srv.stderr.on('data', (d) => srvLog.push(String(d)));
await sleep(900);
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const reg = await (await fetch(SERVER + '/api/tv/register', { method: 'POST' })).json();
  // Pair a phone through the normal remote page.
  const home = await (await b.newContext()).newPage();
  await home.goto(`${SERVER}/tv/?tv=${reg.tv}&k=${reg.secret}`);
  await home.waitForFunction(() => /[A-Z0-9]{3}·[A-Z0-9]{3}/.test(document.getElementById('code')?.textContent || ''), null, { timeout: 8000 });
  const code = (await home.textContent('#code')).replace('·', '');
  const pctx = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: SHOTS ? 2 : 1 });
  const remote = await pctx.newPage();
  await remote.goto(SERVER + '/remote/');
  await remote.evaluate((c) => link.pairCode(c), code);
  await remote.waitForFunction(() => link.status === 'open', null, { timeout: 5000 });
  const key = await remote.evaluate(() => JSON.parse(localStorage.getItem('tv-remote')).key);

  const lib = await (await fetch(`${SERVER}/api/games?tv=${reg.tv}&k=${key}`)).json();
  ok(Array.isArray(lib.games) && lib.running === false, 'library lists games for a paired phone: ' + JSON.stringify(lib.games));
  const badWs = await remote.evaluate((tv) => new Promise((r) => { const s = new WebSocket(`ws://${location.host}/games/ws?role=pad&tv=${tv}&k=wrong`); s.onopen = () => r('open'); s.onerror = () => r('refused'); }), reg.tv);
  ok(badWs === 'refused', 'game socket refuses an unpaired phone');
  const up = await fetch(`${SERVER}/api/games/upload?name=notes.txt`, { method: 'PUT', body: 'x' });
  ok(up.status === 400, 'upload only takes .nds files');

  if (!ROM) { console.log('(no GAME_ROM: skipping play checks)'); }
  else {
    g = lib.games[0].g;
    ok(!!g && lib.games[0].title.length > 0, 'the game shows with a title: ' + lib.games[0].title);
    // The TV opens the game page (the box agent does this when the card is picked).
    const tv = await (await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage();
    await tv.goto(`${SERVER}/games/tv.html?g=${g}&tv=${reg.tv}&k=${reg.secret}`);
    await tv.waitForFunction(() => document.getElementById('hello').classList.contains('off'), null, { timeout: 15000 })
      .then(() => ok(true, 'TV shows the top screen'), () => ok(false, 'TV top screen'));
    // The phone remote turns into the controller by itself.
    await remote.waitForURL(/\/games\/pad\.html/, { timeout: 5000 }).then(() => ok(true, 'phone remote switches to the game controller'), () => ok(false, 'phone switch'));
    await remote.waitForFunction(() => document.getElementById('wait').style.display === 'none', null, { timeout: 8000 })
      .then(() => ok(true, 'phone shows the bottom screen'), () => ok(false, 'phone bottom screen'));
    const lit = await remote.evaluate(() => { const d = document.getElementById('screen').getContext('2d').getImageData(0, 0, 256, 192).data; let n = 0; for (let i = 0; i < d.length; i += 4) n += d[i] + d[i + 1] + d[i + 2]; return n; });
    ok(lit > 0, 'bottom screen has picture');
    // Get to a point where the title takes input, then press A twice (the first press after boot is eaten).
    await sleep(Number(process.env.TITLE_WAIT || 30000));
    const press = async (sel) => { const bb = await remote.locator(sel).boundingBox(); await remote.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(400); };
    const before = await tv.evaluate(() => document.getElementById('top').toDataURL());
    await press('[data-b=a]'); await sleep(800); await press('[data-b=a]'); await sleep(3000);
    const after = await tv.evaluate(() => document.getElementById('top').toDataURL());
    ok(before !== after, 'A on the phone moves the game on (title -> menu)');
    if (SHOTS) { await tv.screenshot({ path: SHOTS + '/tv.png' }); await remote.screenshot({ path: SHOTS + '/pad.png' }); }
    // Fit / Fill / Stretch: the top screen is centered and sized for each; the box remembers it per game.
    const rect = () => tv.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(','); });
    const settle = () => sleep(700);
    ok(await rect() === '160,0,960,720', 'Fit: 4:3, centered, full height (' + await rect() + ')');
    await remote.locator('#viewBtn').tap(); await settle();
    ok(await rect() === '0,-120,1280,960' && await tv.evaluate(() => document.body.classList.contains('v-fill')), 'Fill: covers the TV, centered (' + await rect() + ')');
    if (SHOTS) await tv.screenshot({ path: SHOTS + '/tv-fill.png' });
    await remote.locator('#viewBtn').tap(); await settle();
    ok(await rect() === '0,0,1280,720', 'Stretch: the whole TV (' + await rect() + ')');
    if (SHOTS) await tv.screenshot({ path: SHOTS + '/tv-stretch.png' });
    ok(JSON.parse(fs.readFileSync(TMP + '/state/games/view.json', 'utf8'))[g] === 'stretch', 'the choice is remembered for this game');
    await remote.locator('#viewBtn').tap(); await settle();
    ok(await rect() === '160,0,960,720', 'back to Fit');
    ok(await tv.evaluate(() => getComputedStyle(document.getElementById('hello')).display === 'none'), 'the start card is gone, not just see-through');
    // A second phone joins: it gets a whole frame, and both phones must show the same picture
    // (the first one has been building its picture from changes all along).
    const pad2 = await pctx.newPage();
    await pad2.goto(SERVER + '/games/pad.html');
    await pad2.waitForFunction(() => document.getElementById('wait').style.display === 'none', null, { timeout: 8000 }).catch(() => {});
    await remote.evaluate(() => fetch('/api/games/status'));
    const grab = (pg) => pg.evaluate(() => { const d = document.getElementById('screen').getContext('2d').getImageData(0, 0, 256, 192).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0; return h; });
    let same = false;
    for (let i = 0; i < 20 && !same; i++) { same = (await grab(remote)) === (await grab(pad2)); if (!same) await sleep(150); }
    ok(same, 'phone picture built from changes matches a fresh one');
    await pad2.close();
    // Save to slot 2 from the menu, then load it.
    await remote.locator('#menuBtn').tap();
    await remote.waitForFunction(() => document.querySelectorAll('#slots .slot').length === 7, null, { timeout: 4000 }).then(() => ok(true, 'menu lists auto + 6 slots'), () => ok(false, 'slots list'));
    if (SHOTS) await remote.screenshot({ path: SHOTS + '/menu.png' });
    await remote.locator('#slots .slot').nth(2).locator('[data-a=save]').click();
    await remote.waitForFunction(() => /Saved to slot 2/.test(document.getElementById('toast').textContent), null, { timeout: 8000 }).then(() => ok(true, 'save to slot 2'), () => ok(false, 'save slot 2'));
    ok(fs.existsSync(`${TMP}/state/games/states/${g}/2.state`) && fs.existsSync(`${TMP}/state/games/states/${g}/2.png`), 'slot 2 state + picture on disk (outside the app folder)');
    await remote.locator('#menuBtn').tap();
    await remote.waitForFunction(() => document.querySelectorAll('#slots .slot')[2]?.querySelector('[data-a=load]') && !document.querySelectorAll('#slots .slot')[2].querySelector('[data-a=load]').disabled, null, { timeout: 4000 });
    await remote.locator('#slots .slot').nth(2).locator('[data-a=load]').click();
    await remote.waitForFunction(() => /Loaded slot 2/.test(document.getElementById('toast').textContent), null, { timeout: 8000 }).then(() => ok(true, 'load slot 2'), () => ok(false, 'load slot 2'));
    // Touch on the phone screen reaches the game (the server forwards it).
    const cv = await remote.locator('#screen').boundingBox();
    await remote.touchscreen.tap(cv.x + cv.width / 2, cv.y + cv.height / 2);
    ok(srvLog.join('').indexOf('dshost') === -1 || !/error/i.test(srvLog.join('')), 'no player errors in the server log');
    // Leave the game: Home from the menu. The TV page closes (the agent would go Home), the game writes its auto save.
    await remote.locator('#menuBtn').tap();
    await remote.locator('#leave').click();
    await tv.goto('about:blank');
    await remote.waitForURL(/\/remote\//, { timeout: 12000 }).then(() => ok(true, 'leaving brings the phone back to the remote'), () => ok(false, 'back to remote'));
    for (let i = 0; i < 40 && !fs.existsSync(`${TMP}/state/games/states/${g}/auto.state`); i++) await sleep(250);
    ok(fs.existsSync(`${TMP}/state/games/states/${g}/auto.state`), 'leaving keeps an auto save');
    ok(fs.readdirSync(`${TMP}/state/games/saves`).some((f) => f.endsWith('.dsv')), 'in-game save file kept in the saves folder');
    const st = await (await fetch(`${SERVER}/api/games/status`)).json();
    ok(st.running === false, 'the player stopped');
  }
} catch (e) {
  ok(false, 'crashed: ' + e.message);
} finally {
  await b.close();
  srv.kill('SIGTERM');
  await sleep(500);
  if (fail) console.log(srvLog.join('').split('\n').slice(-30).join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
