// Claude Code terminal: server.mjs /term/ws  <->  termd.mjs  <->  a shell in a pty.
// Starts its own server and termd (a plain bash stands in for claude). Run: node tests/term.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvterm-'));
const HP = 8280, TP = 8291;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, name) => { console.log((c ? 'PASS ' : 'FAIL ') + name); c ? pass++ : fail++; };

const procs = [];
function run(file, env) {
  const p = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.V && process.stdout.write('[' + path.basename(file) + '] ' + d));
  p.stderr.on('data', (d) => process.stdout.write('[' + path.basename(file) + ' err] ' + d));
  procs.push(p);
  return p;
}
const cleanup = () => procs.forEach((p) => p.kill());
process.on('exit', cleanup);

// A tiny WebSocket client that can set Origin.
function wsConnect(pathq, origin = `http://127.0.0.1:${HP}`) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: HP, path: pathq, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), Origin: origin } });
    req.on('response', (res) => resolve({ refused: res.statusCode }));
    req.on('error', () => resolve({ refused: 'error' }));
    req.on('upgrade', (res, sock) => {
      const c = { text: '', sock, closed: false };
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const op = buf[0] & 0x0f;
          if (op === 1) c.text += buf.subarray(off, off + len).toString('utf8');
          if (op === 8) c.closed = true;
          buf = buf.subarray(off + len);
        }
      });
      sock.on('close', () => { c.closed = true; });
      c.send = (obj) => {
        const p = Buffer.from(JSON.stringify(obj)); const mask = crypto.randomBytes(4);
        const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
        const body = Buffer.from(p); for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        sock.write(Buffer.concat([head, mask, body]));
      };
      c.type = (d) => c.send({ t: 'in', d });
      c.until = async (re, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(c.text)) return true; await sleep(50); } return false; };
      c.close = () => sock.destroy();
      resolve(c);
    });
    req.end();
  });
}

run(path.join(APP, 'server/server.mjs'), { TV_STATE_DIR: path.join(TMP, 'state'), HTTP_PORT: HP, NO_HTTPS: '1', TV_HOST: 'localhost', TERM_PORT: TP });
await sleep(700);
const reg = await fetch(`http://127.0.0.1:${HP}/api/tv/register`, { method: 'POST' }).then((r) => r.json());
run(path.join(APP, 'termd/termd.mjs'), { TV_SERVER: `http://127.0.0.1:${HP}`, TERM_PORT: TP, TERM_CMD: 'PS1="tv$ " exec bash --norc --noprofile -i', HOME: TMP });
await sleep(1200);
const Q = `/term/ws?tv=${reg.tv}&k=${reg.secret}`;

// Who may connect
ok((await wsConnect(`/term/ws?tv=${reg.tv}&k=wrong`)).refused === 403, 'wrong secret is refused');
ok((await wsConnect(Q, 'https://evil.example')).refused === 403, 'a page from another site is refused');
ok((await wsConnect(Q, 'http://tv.local')).refused === 403, 'a phone page (tv.local origin) is refused');
const page = await fetch(`http://127.0.0.1:${HP}/term/`).then((r) => r.status);
ok(page === 200 || page === 404, `/term/ is served as a static page (status ${page})`);
const notPublic = await fetch(`http://127.0.0.1:${HP}/termd/termd.mjs`).then((r) => r.status);
ok(notPublic === 404, 'the terminal daemon itself is not downloadable');
{
  const s = net.connect(TP, '127.0.0.1'); let got = '', closed = false;
  s.on('data', (d) => { got += d; }); s.on('close', () => { closed = true; }); s.on('error', () => {});
  s.write('not-the-secret\n{"t":"in","d":"echo hi\\n"}\n');
  await sleep(500);
  ok(closed && !got, 'termd refuses a direct connection without the secret');
}

// Use it
const a = await wsConnect(Q);
ok(!a.refused, 'the TV screen connects');
a.send({ t: 'resize', cols: 120, rows: 40 });
ok(await a.until(/tv\$ /), 'shell prompt appears');
a.type('echo hello-$((6*7))\r');
ok(await a.until(/hello-42/), 'typed command runs (echo)');
a.type('stty size\r');
ok(await a.until(/40 120/), 'resize reaches the terminal (stty size = 40 120)');
a.type('whoami\r');
ok(await a.until(new RegExp(os.userInfo().username)), 'runs as the termd user (' + os.userInfo().username + '), not the server user');
a.type('sleep 30\r'); await sleep(300); a.type('\x03'); a.type('echo after-ctrl-c\r');
ok(await a.until(/after-ctrl-c/), 'Ctrl+C stops a running command');
a.type('export MARK=kept-$((1+1))\r'); await sleep(200);
a.close(); await sleep(400);

// Back again: same session, old output replayed
const b = await wsConnect(Q);
ok(await b.until(/hello-42/), 'reconnect replays the earlier screen');
b.send({ t: 'resize', cols: 120, rows: 40 });
b.type('echo $MARK\r');
ok(await b.until(/kept-2/), 'the session is still the same one after leaving');
b.type('exit\r');
ok(await b.until(/terminal closed/i), 'when the shell exits the screen says so');
await sleep(300);
const c = await wsConnect(Q);
c.send({ t: 'resize', cols: 80, rows: 24 });
ok(await c.until(/tv\$ /), 'opening it again starts a fresh terminal');
c.close();

// termd down: a friendly message
procs[1].kill(); await sleep(400);
const d = await wsConnect(Q);
ok(await d.until(/isn't running/), "termd stopped: the screen says Claude Code isn't running");

console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
