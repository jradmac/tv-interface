// The phone remote as a home-screen app: manifest, icons, self-pairing on first launch,
// and the "show a code on the TV" fallback. Starts its own server. Run:
//   PW=/path/to/playwright/index.js node tests/app.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PW || 'playwright');

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvapp-'));
const HP = 8480, SERVER = `http://127.0.0.1:${HP}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const srv = spawn('node', [path.join(APP, 'server/server.mjs')], { env: { ...process.env, TV_STATE_DIR: TMP + '/state', HTTP_PORT: HP, NO_HTTPS: '1', TV_HOST: 'localhost' }, stdio: 'ignore' });
await sleep(800);
const b = await chromium.launch();
try {
  // Static parts
  const man = await fetch(SERVER + '/remote/manifest.webmanifest');
  ok(man.ok && /manifest\+json/.test(man.headers.get('content-type')), 'manifest is served as a web app manifest');
  const mj = await man.json();
  ok(mj.display === 'standalone' && mj.scope === '/remote/', 'manifest: full screen app, scoped to the remote');
  for (const i of [180, 192, 512]) {
    const r = await fetch(`${SERVER}/remote/icons/icon-${i}.png`);
    const buf = Buffer.from(await r.arrayBuffer());
    ok(r.ok && buf.readUInt32BE(16) === i && buf.readUInt32BE(20) === i, `icon ${i}x${i} is a real ${i}px PNG`);
  }
  const html = await (await fetch(SERVER + '/remote/')).text();
  ok(/rel="manifest"/.test(html) && /apple-touch-icon/.test(html) && /apple-mobile-web-app-capable/.test(html), 'remote page links the manifest and iPhone icon');

  // A TV and a paired Safari phone
  const reg = await (await fetch(SERVER + '/api/tv/register', { method: 'POST' })).json();
  const tv = await (await b.newContext()).newPage();
  await tv.goto(`${SERVER}/tv/?tv=${reg.tv}&k=${reg.secret}`);
  await tv.waitForFunction(() => /[A-Z0-9]{3}·[A-Z0-9]{3}/.test(document.getElementById('code')?.textContent || ''), null, { timeout: 8000 });
  const code = (await tv.textContent('#code')).replace('·', '');
  const safariCtx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const safari = await safariCtx.newPage();
  await safari.goto(SERVER + '/remote/');
  await safari.evaluate((c) => link.pairCode(c), code);
  await safari.waitForFunction(() => link.status === 'open', null, { timeout: 5000 });
  ok(await safari.evaluate(() => link.standalone === false), 'in Safari, link.standalone is false');

  // Path (a): "Add to Home Screen" gives the app a manifest that pairs it.
  const prep = await safari.evaluate(() => link.prepareInstall());
  const href = await safari.evaluate(() => document.querySelector('link[rel="manifest"]').href);
  ok(prep.ok && /\/api\/app\/manifest\?t=[0-9a-f]+$/.test(href), 'prepareInstall points the page at a one-time manifest');
  const m2 = await (await fetch(href)).json();
  ok(/^\/remote\/\?app#pair=[0-9a-f]+\.[0-9a-f]+$/.test(m2.start_url) && m2.icons.every((i) => i.src.startsWith('/remote/icons/')), 'that manifest opens the app with a pairing token: ' + m2.start_url.replace(/\.[0-9a-f]+$/, '.…'));
  ok((await fetch(SERVER + '/api/pair/app', { method: 'POST', body: JSON.stringify({ tv: reg.tv, key: 'nope' }) })).status === 403, 'only a paired phone can make an app token');
  ok(!/#pair/.test((await (await fetch(SERVER + '/api/app/manifest?t=deadbeef')).json()).start_url), 'a made-up token gives the plain manifest');
  // The app's first launch: its own empty storage, opened at start_url.
  const app1 = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await app1.goto(SERVER + m2.start_url);
  await app1.waitForFunction(() => link.status === 'open', null, { timeout: 6000 }).then(() => ok(true, 'the new app paired itself on first launch'), () => ok(false, 'app self-pair'));
  ok(await app1.evaluate(() => !location.hash.includes('pair')), 'the token is wiped from the address after use');
  await app1.reload();
  await app1.waitForFunction(() => link.status === 'open', null, { timeout: 6000 }).then(() => ok(true, 'reopening the app stays paired'), () => ok(false, 'stays paired'));
  const reuse = await (await b.newContext()).newPage();
  await reuse.goto(SERVER + m2.start_url);
  await sleep(1500);
  ok(await reuse.evaluate(() => link.status !== 'open'), 'the same token cannot pair a second phone');

  // Path (b): an app that opens unpaired asks the TV to show a code.
  await tv.evaluate(() => { window.hints = []; link.on((m) => { if (m.t === 'pair.hint') hints.push(m.code); }); });
  const app2 = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await app2.goto(SERVER + '/remote/?app');
  await sleep(800);
  const hint = await tv.evaluate(() => hints.filter(Boolean).pop());
  ok(/^[A-Z0-9]{6}$/.test(hint || ''), 'an unpaired app makes the TV show a code right away, even with other phones connected: ' + hint);
  const r2 = await app2.evaluate((c) => link.pairCode(c).then((x) => x.name, (e) => e.message), hint);
  ok(r2 === 'Phone', 'typing that code pairs the app');
} catch (e) {
  ok(false, 'exception: ' + e.message);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  srv.kill();
  process.exit(fail ? 1 : 0);
}
