import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)(process.env.PW);
import { spawn } from 'node:child_process';
const S = process.env.S, SERVER = 'http://127.0.0.1:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
let srv;
const start = () => { srv = spawn('node', [S + '/x/server/server.mjs'], { env: { ...process.env, TV_STATE_DIR: S + '/state', HTTP_PORT: '8080', HTTPS_PORT: '8443', TV_HOST: 'localhost' }, stdio: 'ignore' }); return sleep(1500); };
await start();
const reg = await (await fetch(SERVER + '/api/tv/register', { method: 'POST' })).json();
let tvMsgs = [];
const tvSock = () => new Promise((res) => { const w = new WebSocket(`ws://127.0.0.1:8080/ws?tv=${reg.tv}&role=tv&k=${reg.secret}`); w.onmessage = (e) => tvMsgs.push(JSON.parse(e.data)); w.onopen = () => { w.send('{"t":"pair.request"}'); res(w); }; });
let tv = await tvSock();
await sleep(500);
const code = tvMsgs.find((m) => m.t === 'pair').code;
const b = await chromium.launch();
const phone = await (await b.newContext({ userAgent: 'iPhone' })).newPage();
await phone.goto(SERVER + '/remote/');
await phone.evaluate((c) => link.pairCode(c), code);
await phone.waitForFunction(() => link.status === 'open', null, { timeout: 5000 });
ok(true, 'phone paired and connected');
await phone.evaluate(() => { window.st = []; link.on((m) => m.t === 'link' && st.push(m.status)); });

// 1. Box server restarts (like an update).
srv.kill(); const t0 = Date.now();
await sleep(1000);
ok((await phone.evaluate(() => link.status)) !== 'open', 'phone notices the box went away: ' + await phone.evaluate(() => link.status));
await start();
tv = await tvSock();
await phone.waitForFunction(() => link.status === 'open', null, { timeout: 15000 }).then(() => ok(true, `phone reconnected by itself in ${((Date.now() - t0) / 1000).toFixed(1)}s`), () => ok(false, 'phone reconnect after restart'));
tvMsgs = [];
await phone.evaluate(() => link.send({ t: 'tap' }));
await sleep(400);
ok(tvMsgs.some((m) => m.t === 'tap'), 'phone controls work again after the restart');

// 2. Box frozen (connection dies silently, like a phone waking from sleep): heartbeat must notice.
srv.kill('SIGSTOP'); const t1 = Date.now();
await phone.waitForFunction(() => link.status !== 'open', null, { timeout: 45000 }).then(() => ok(true, `silent drop noticed in ${((Date.now() - t1) / 1000).toFixed(0)}s`), () => ok(false, 'silent drop noticed'));
srv.kill('SIGCONT');
await phone.waitForFunction(() => link.status === 'open', null, { timeout: 15000 }).then(() => ok(true, 'reconnected after the freeze'), () => ok(false, 'reconnect after freeze'));

// 3. Waking the page (visibility/pageshow) checks the connection at once.
srv.kill('SIGSTOP'); const t2 = Date.now();
await phone.evaluate(() => dispatchEvent(new Event('pageshow')));
await phone.waitForFunction(() => link.status !== 'open', null, { timeout: 6000 }).then(() => ok(true, `wake check noticed a dead connection in ${((Date.now() - t2) / 1000).toFixed(1)}s`), () => ok(false, 'wake check'));
srv.kill('SIGCONT');
await phone.waitForFunction(() => link.status === 'open', null, { timeout: 15000 }).then(() => ok(true, 'reconnected after wake'), () => ok(false, 'reconnect after wake'));
ok(await phone.evaluate(() => document.getElementById('stText')?.textContent) === 'Connected', 'remote shows Connected');
console.log('statuses seen:', (await phone.evaluate(() => st)).join(' > '));
await b.close(); srv.kill();
process.exit();
