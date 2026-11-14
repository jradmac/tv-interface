// TV power button: the box drives a Roku TV over ECP (mocked here). Starts its own server. Run:
//   PW=/path/to/playwright/index.js node tests/roku.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PW || 'playwright');

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvroku-'));
const HP = 8481, SERVER = `http://127.0.0.1:${HP}`, RP = 18060;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };

// A pretend Roku TV.
const tvSet = { power: 'DisplayOff', input: 'tvinput.dtv', keys: [], deny: false };
const mock = http.createServer((req, res) => {
  if (tvSet.deny) { res.writeHead(403); return res.end(); }
  if (req.url === '/query/device-info') {
    res.writeHead(200, { 'content-type': 'text/xml' });
    return res.end(`<?xml version="1.0"?><device-info><user-device-name>Living Room TV</user-device-name><is-tv>true</is-tv><power-mode>${tvSet.power}</power-mode></device-info>`);
  }
  if (req.url === '/query/active-app') { res.writeHead(200); return res.end(`<active-app><app id="${tvSet.input}">x</app></active-app>`); }
  const m = req.method === 'POST' && req.url.match(/^\/keypress\/(\w+)$/);
  if (m) {
    tvSet.keys.push(m[1]);
    if (m[1] === 'PowerOff') tvSet.power = 'DisplayOff';
    if (m[1] === 'PowerOn') tvSet.power = 'PowerOn';
    const h = m[1].match(/^InputHDMI(\d)$/); if (h) tvSet.input = 'tvinput.hdmi' + h[1];
    res.writeHead(200); return res.end();
  }
  res.writeHead(404); res.end();
}).listen(RP);

const srv = spawn('node', [path.join(APP, 'server/server.mjs')], { env: { ...process.env, TV_STATE_DIR: TMP + '/state', HTTP_PORT: HP, NO_HTTPS: '1', TV_HOST: 'localhost', ROKU_URL: `http://127.0.0.1:${RP}` }, stdio: 'ignore' });
await sleep(900);
const b = await chromium.launch();
try {
  const reg = await (await fetch(SERVER + '/api/tv/register', { method: 'POST' })).json();
  const tv = await (await b.newContext()).newPage();
  await tv.goto(`${SERVER}/tv/?tv=${reg.tv}&k=${reg.secret}`);
  await tv.waitForFunction(() => /[A-Z0-9]{3}·[A-Z0-9]{3}/.test(document.getElementById('code')?.textContent || ''), null, { timeout: 8000 });
  const code = (await tv.textContent('#code')).replace('·', '');
  const phone = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await phone.goto(SERVER + '/remote/');
  await phone.evaluate(() => { window.st = []; link.on((m) => { if (m.t === 'tv.status') st.push(m); }); });
  await phone.evaluate((c) => link.pairCode(c), code);
  await phone.waitForFunction(() => link.status === 'open', null, { timeout: 5000 });
  const last = () => phone.evaluate(() => st[st.length - 1] || null);
  await phone.waitForFunction(() => st.some((m) => m.found), null, { timeout: 5000 }).catch(() => {});
  let s = await last();
  ok(s && s.found && s.name === 'Living Room TV' && s.on === false && s.hdmi === 1, 'phone gets the TV: found, its name, off, HDMI 1: ' + JSON.stringify(s));

  await phone.evaluate(() => link.send({ t: 'tv.power', on: true }));
  for (let i = 0; i < 40 && !tvSet.keys.includes('InputHDMI1'); i++) await sleep(200);
  ok(tvSet.keys[0] === 'PowerOn' && tvSet.keys.includes('InputHDMI1'), 'power on wakes the TV, then switches to HDMI 1: ' + tvSet.keys.join(','));
  await phone.waitForFunction(() => { const m = st[st.length - 1]; return m && m.on === true && !m.busy; }, null, { timeout: 8000 }).then(() => ok(true, 'phone shows the TV on'), () => ok(false, 'on status'));

  tvSet.keys = [];
  await phone.evaluate(() => link.send({ t: 'tv.power' }));
  for (let i = 0; i < 30 && !tvSet.keys.length; i++) await sleep(200);
  ok(tvSet.keys.join() === 'PowerOff', 'the button toggles: TV on -> off');
  await phone.waitForFunction(() => { const m = st[st.length - 1]; return m && m.on === false && !m.busy; }, null, { timeout: 6000 }).then(() => ok(true, 'phone shows the TV off'), () => ok(false, 'off status'));

  await phone.evaluate(() => link.send({ t: 'tv.setup', hdmi: 3 }));
  await phone.waitForFunction(() => st.some((m) => m.hdmi === 3), null, { timeout: 4000 }).then(() => ok(true, 'HDMI port can be changed'), () => ok(false, 'hdmi'));
  ok(JSON.parse(fs.readFileSync(TMP + '/state/server.json', 'utf8')).roku.hdmi === 3, 'and the box remembers it');
  await phone.evaluate(() => link.send({ t: 'tv.setup', hdmi: 1 }));

  tvSet.keys = [];
  await phone.evaluate(() => link.send({ t: 'voice', phase: 'final', text: 'Turn on the TV' }));
  for (let i = 0; i < 30 && !tvSet.keys.includes('PowerOn'); i++) await sleep(200);
  ok(tvSet.keys[0] === 'PowerOn', '"turn on the TV" by voice');
  await sleep(4500);

  tvSet.deny = true;
  await phone.evaluate(() => { st.length = 0; link.send({ t: 'tv.power', on: false }); });
  await phone.waitForFunction(() => st.some((m) => /Control by mobile apps/.test(m.hint || '')), null, { timeout: 6000 }).then(() => ok(true, 'a TV that refuses shows how to allow it'), () => ok(false, 'ecp hint'));
  tvSet.deny = false;

  await phone.evaluate(() => { st.length = 0; link.send({ t: 'tv.setup', ip: '8.8.8.8' }); });
  await phone.waitForFunction(() => st.some((m) => /address/.test(m.hint || '')), null, { timeout: 4000 }).then(() => ok(true, 'only home-network addresses are accepted for the TV'), () => ok(false, 'ip check'));
  const errs = [];
  phone.on('pageerror', (e) => errs.push(e.message));
  await phone.reload();
  await sleep(1500);
  ok(!errs.length, 'remote page has no errors with TV status ' + errs.join('; '));
} catch (e) {
  ok(false, 'exception: ' + e.message);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  srv.kill();
  mock.close();
  process.exit(fail ? 1 : 0);
}
