// Voice driver end to end, with a stand-in for the Claude API (no real key, no network).
// Starts its own TV server, box agent and Chrome. Run:
//   PW=/path/to/playwright/index.js node tests/voice-agent.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PW || 'playwright');

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvvoice-'));
const HP = 8380, API = 8399, SERVER = `http://127.0.0.1:${HP}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200); } return false; };

// ---- The stand-in Claude API ------------------------------------------------------------
const calls = []; // { kind: 'intent'|'driver', model, body }
let script = null; // (body, n) => content blocks, for driver calls
let nDriver = 0;
const toolUse = (name, input) => ({ type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2), name, input });
const api = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (req.url.startsWith('/v1/models')) {
      const good = req.headers['x-api-key'] === 'sk-ant-test-' + 'x'.repeat(30);
      res.writeHead(good ? 200 : 401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(good ? { data: [] } : { error: { type: 'authentication_error' } }));
    }
    const body = JSON.parse(b || '{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (body.output_config && body.output_config.format) {
      // The one-shot intent step.
      const words = body.messages[0].content.toLowerCase();
      calls.push({ kind: 'intent', model: body.model, words });
      const kind = /jazz|subtitles|episode/.test(words) ? (/subtitles/.test(words) ? 'do' : 'play') : 'none';
      const out = { kind, say: kind === 'none' ? 'Hmm' : 'On it', service: /youtube/.test(words) ? 'youtube' : '', query: '', control: '', volume: 0, results: [] };
      return res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] }));
    }
    calls.push({ kind: 'driver', model: body.model, body, beta: req.headers['anthropic-beta'] || '' });
    const content = script(body, nDriver++);
    setTimeout(() => res.end(JSON.stringify({ stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn', content })), 150);
  });
});
await new Promise((r) => api.listen(API, '127.0.0.1', r));

// ---- Box: server, Chrome, agent -------------------------------------------------------------
const env = { ...process.env, ANTHROPIC_API_URL: `http://127.0.0.1:${API}/v1/messages` };
const procs = [];
procs.push(spawn('node', [path.join(APP, 'server/server.mjs')], { env: { ...env, TV_STATE_DIR: TMP + '/state', HTTP_PORT: HP, NO_HTTPS: '1', TV_HOST: 'localhost' }, stdio: 'ignore' }));
await sleep(800);
const box = await chromium.launch({ args: ['--remote-debugging-port=9222', '--window-size=1920,1080'] });
const ctx = await box.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.route(/^https:\/\/(www\.youtube\.com|www\.netflix\.com|www\.google\.com)\//, (route) => route.fulfill({ contentType: 'text/html',
  body: '<html><body style="background:#222;color:#fff;font:30px sans-serif"><h1>' + new URL(route.request().url()).host + '</h1><button aria-label="Jazz Lofi Playlist" onclick="document.querySelector(\'video\').dataset.go=1;document.title=\'Jazz Lofi Playlist\'">Jazz Lofi Playlist</button><video></video></body></html>' }));
const tvPage = await ctx.newPage();
let alog = '';
const agent = spawn('node', [path.join(APP, 'agent/agent.mjs')], { env: { ...env, TV_SERVER: SERVER, TV_AGENT_DIR: TMP + '/agent' } });
agent.stdout.on('data', (d) => { alog += d; if (process.env.V) process.stdout.write('  [agent] ' + d); });
agent.stderr.on('data', (d) => { alog += d; process.stdout.write('  [agent!] ' + d); });
procs.push(agent);
const done = async () => { procs.forEach((p) => p.kill()); await box.close().catch(() => {}); api.close(); };

try {
  await until(() => tvPage.url().includes('/tv/'), 10000);
  await tvPage.waitForFunction(() => /[A-Z0-9]{3}·[A-Z0-9]{3}/.test(document.getElementById('code')?.textContent || ''), null, { timeout: 8000 });
  const code = (await tvPage.textContent('#code')).replace('·', '');
  const phoneB = await chromium.launch();
  const phone = await (await phoneB.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await phone.goto(SERVER + '/remote/');
  await phone.evaluate((c) => link.pairCode(c), code);
  await phone.waitForFunction(() => link.status === 'open', null, { timeout: 5000 });
  await phone.evaluate(() => { window.got = []; link.on((m) => got.push(m)); });
  const creds = await phone.evaluate(() => JSON.parse(localStorage.getItem('tv-remote')));
  const setKey = (k, extra = {}) => fetch(SERVER + '/api/settings/claude', { method: 'POST', body: JSON.stringify({ tv: creds.tv, key: creds.key, anthropicKey: k, ...extra }) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  // Key setup
  ok((await fetch(SERVER + '/api/settings/claude', { method: 'POST', body: JSON.stringify({ tv: creds.tv, key: 'nope', anthropicKey: 'x' }) })).status === 403, 'an unpaired caller cannot set the key');
  ok((await setKey('hello')).status === 400, 'a malformed key is turned away');
  ok((await setKey('sk-ant-wrong-' + 'y'.repeat(30))).status === 400, 'a key Anthropic refuses is turned away');
  const good = 'sk-ant-test-' + 'x'.repeat(30);
  const set = await setKey(good);
  ok(set.status === 200 && set.set && set.hint === '…' + good.slice(-4), 'a good key is saved; the phone only sees ' + set.hint);
  const read = await setKey('', { read: true });
  ok(read.set && !JSON.stringify(read).includes('sk-ant'), 'reading back never returns the key');
  ok(!fs.readFileSync(path.join(APP, 'server/server.mjs'), 'utf8').includes(good), 'key is not in the app files');
  await sleep(300);

  // 1. "play me a jazz playlist on YouTube": play(), look, finish, all on the fast model.
  script = (body, n) => {
    if (n === 0) return [{ type: 'text', text: 'Playing it.' }, toolUse('play', { service: 'youtube', query: 'jazz playlist' })];
    if (n === 1) return [toolUse('look', {})];
    const last = JSON.stringify(body.messages[body.messages.length - 1]);
    const m = last.match(/(\d+) button \\"Jazz Lofi Playlist/);
    if (n === 2 && m) return [toolUse('click', { id: Number(m[1]) })];
    return [toolUse('finish', { success: true, say: 'Playing a jazz playlist on YouTube' })];
  };
  nDriver = 0; calls.length = 0;
  await phone.evaluate(() => link.send({ t: 'voice', phase: 'final', text: 'play me a jazz playlist on YouTube' }));
  ok(await until(() => /youtube\.com/.test(tvPage.url()), 15000), 'the TV went to YouTube by itself');
  ok(await until(() => phone.evaluate(() => got.some((m) => m.t === 'agent' && m.phase === 'done'))), 'phone is told it is done');
  const msgs = await phone.evaluate(() => got.filter((m) => m.t === 'agent' || (m.t === 'intent' && m.kind === 'do')).map((m) => m.phase || m.kind));
  ok(msgs.includes('do') && msgs.includes('start') && msgs.includes('step'), 'phone saw the request, the start and the steps: ' + msgs.join(','));
  ok(await tvPage.evaluate(() => document.querySelector('video')?.dataset.go === '1'), 'the driver clicked the right thing on screen');
  const d1 = calls.filter((c) => c.kind === 'driver');
  ok(d1.length >= 3 && d1.every((c) => c.model === 'claude-haiku-5-5'), `fast model did it in ${d1.length} calls (${[...new Set(d1.map((c) => c.model))]})`);
  ok(d1[0].body.tools.some((t) => t.name === 'play') && !JSON.stringify(d1[0].body.tools).includes('claudecode'), 'tools offered; Claude Code is not one of its services');
  const sec = JSON.parse(fs.readFileSync(TMP + '/state/server.json', 'utf8')).secret;
  ok(!JSON.stringify(d1.map((c) => c.body)).includes(sec), 'the TV secret never goes to Claude');

  // 2. The fast model gives up: Sonnet takes over, with the fallback setting.
  await phone.evaluate(() => { got.length = 0; link.send({ t: 'home' }); });
  await until(() => tvPage.url().includes('/tv/'));
  await sleep(1200);
  script = (body, n) => {
    if (body.model === 'claude-haiku-5-5') return [toolUse('finish', { success: false, say: 'Could not find it' })];
    return [toolUse('finish', { success: true, say: 'Subtitles are on' })];
  };
  nDriver = 0; calls.length = 0;
  await phone.evaluate(() => link.send({ t: 'voice', phase: 'final', text: 'turn on subtitles' }));
  ok(await until(() => phone.evaluate(() => got.some((m) => m.t === 'agent' && m.phase === 'done' && /Subtitles/.test(m.text)))), 'after the fast model gave up, the stronger one finished it');
  const d2 = calls.filter((c) => c.kind === 'driver');
  ok(d2.some((c) => c.model === 'claude-sonnet-5-5' && /server-side-fallback/.test(c.beta) && c.body.fallbacks === 'default'), 'Sonnet calls carry the refusal fallback');

  // 3. The person takes over: tapping the remote stops it.
  script = () => [toolUse('wait', { seconds: 3 })];
  nDriver = 0; calls.length = 0;
  await phone.evaluate(() => { got.length = 0; link.send({ t: 'voice', phase: 'final', text: 'play an episode of something on youtube' }); });
  await until(() => phone.evaluate(() => got.some((m) => m.t === 'agent' && m.phase === 'start')));
  await sleep(600);
  ok(await phone.evaluate(() => document.getElementById('mic').classList.contains('stop') && getComputedStyle(document.getElementById('abar')).display === 'none'), 'while running, the mic is a Stop button and no bar covers the touchpad');
  ok(/./.test(await phone.textContent('#tip')) && !/Hold to speak/.test(await phone.textContent('#tip')), 'the line under the mic shows the step: ' + await phone.textContent('#tip'));
  await phone.dispatchEvent('#mic', 'pointerdown');
  ok(await until(() => phone.evaluate(() => got.some((m) => m.t === 'agent' && m.phase === 'stopped'))), 'tapping the Stop (mic) button stops the driver');
  ok(await phone.evaluate(() => !document.getElementById('mic').classList.contains('stop')), 'the mic is a mic again');
  const n3 = calls.length; await sleep(4000);
  ok(calls.length <= n3 + 1, 'no more Claude calls after stopping');

  // 4. No key: a clear message, nothing runs.
  await setKey('');
  await sleep(300);
  calls.length = 0;
  await phone.evaluate(() => { got.length = 0; link.send({ t: 'voice', phase: 'final', text: 'play me a jazz playlist on YouTube' }); });
  await sleep(1500);
  ok(!calls.some((c) => c.kind === 'driver'), 'without a key, the driver does not run');
  await phoneB.close();
} catch (e) {
  ok(false, 'exception: ' + e.message);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(alog.split('\n').slice(-30).join('\n'));
  await done();
  process.exit(fail ? 1 : 0);
}
