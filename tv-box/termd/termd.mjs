#!/usr/bin/env node
// Claude Code terminal for the TV. Runs as the box's owner (not root, not the "tv" user).
// Listens on 127.0.0.1 only. The TV server (server.mjs) is the only client: it accepts the
// kiosk page's WebSocket at /term/ws and opens one plain connection here per page.
//
// Connection: the client's first line is the TV secret (from the server's local-only
// /api/tv/register). After that, one JSON message per line:
//   {t:'in', d:'text'}             keys for the terminal
//   {t:'resize', cols, rows}       terminal size
// Everything sent back is the terminal's raw output (recent output is replayed on connect).
// The terminal keeps running between connections, so going Home and back keeps the session.
// No npm packages.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TERM_PORT || 8090);
const SERVER = (process.env.TV_SERVER || 'http://127.0.0.1').replace(/\/+$/, '');
const WORKDIR = process.env.TERM_DIR || path.join(os.homedir(), 'tv-box');
const CMD = process.env.TERM_CMD ||
  `cd ${JSON.stringify(WORKDIR)} 2>/dev/null || cd ~; clear; while true; do claude; echo; read -r -p "Claude Code closed. Press Enter to start it again. " _; clear; done`;
const KEEP = 256 * 1024; // bytes of output replayed to a new connection
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let secret = null;
async function getSecret() {
  for (;;) {
    try {
      const r = await fetch(SERVER + '/api/tv/register', { method: 'POST' });
      if (r.ok) return (await r.json()).secret;
      log('register: HTTP', r.status);
    } catch (e) { log('waiting for the TV server:', e.message); }
    await sleep(3000);
  }
}
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---- The terminal -------------------------------------------------------------------------
const hasPython = spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;
let term = null; // { proc, ctrl }
let out = Buffer.alloc(0);
let size = { cols: 100, rows: 30 };
const clients = new Set();

function start() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', COLS: String(size.cols), ROWS: String(size.rows), LANG: process.env.LANG || 'C.UTF-8' };
  delete env.TERM_CMD; delete env.TERM_PORT; delete env.TV_SERVER;
  let proc;
  if (hasPython) proc = spawn('python3', ['-I', path.join(HERE, 'ptyrun.py'), 'bash', '-lc', CMD], { cwd: os.homedir(), env, stdio: ['pipe', 'pipe', 'inherit', 'pipe'] });
  // No python: `script` gives a terminal too, just without resizing.
  else proc = spawn('script', ['-qfc', `stty cols ${size.cols} rows ${size.rows}; ${CMD}`, '/dev/null'], { cwd: os.homedir(), env, stdio: ['pipe', 'pipe', 'inherit'] });
  const t = { proc, ctrl: proc.stdio[3] || null };
  term = t;
  log('terminal started', hasPython ? '(pty)' : '(script)');
  proc.stdout.on('data', (d) => {
    out = Buffer.concat([out, d]);
    if (out.length > KEEP * 2) out = out.subarray(out.length - KEEP);
    for (const c of clients) c.write(d);
  });
  proc.stdin.on('error', () => {});
  if (t.ctrl) t.ctrl.on('error', () => {});
  proc.on('exit', (code) => {
    log('terminal ended', code);
    if (term === t) term = null;
    out = Buffer.alloc(0);
    for (const c of clients) c.end('\r\n[The terminal closed. Open Claude Code again to start over.]\r\n');
  });
}

function resize(cols, rows, force) {
  cols = Math.max(10, Math.min(500, cols | 0)); rows = Math.max(5, Math.min(200, rows | 0));
  const changed = cols !== size.cols || rows !== size.rows;
  size = { cols, rows };
  if (!term || !term.ctrl) return;
  // A new screen asks for a redraw: wiggle the size so the program repaints itself.
  if (!changed && force) term.ctrl.write(`${cols - 1} ${rows}\n`);
  if (changed || force) term.ctrl.write(`${cols} ${rows}\n`);
}

// ---- Connections from the TV server ---------------------------------------------------------
const srv = net.createServer((c) => {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(c.remoteAddress)) return c.destroy();
  c.setNoDelay(true);
  let buf = '', authed = false, first = true;
  const timer = setTimeout(() => { if (!authed) c.destroy(); }, 3000);
  c.on('data', (d) => {
    buf += d.toString('utf8');
    if (buf.length > 1 << 20) return c.destroy();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!authed) {
        if (!secret || !same(line.trim(), secret)) { log('refused a connection'); return c.destroy(); }
        authed = true; clearTimeout(timer);
        if (!term) start();
        if (out.length) c.write(out.subarray(-KEEP));
        clients.add(c);
        continue;
      }
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.t === 'in' && typeof m.d === 'string' && term) term.proc.stdin.write(m.d);
      else if (m.t === 'resize') { resize(m.cols, m.rows, first); first = false; }
    }
  });
  const gone = () => { clearTimeout(timer); clients.delete(c); };
  c.on('close', gone);
  c.on('error', gone);
});

secret = await getSecret();
srv.listen(PORT, '127.0.0.1', () => log(`Claude Code terminal on 127.0.0.1:${PORT}, folder ${WORKDIR}`));
// A new TV secret (server state reset) is picked up without a restart.
setInterval(async () => { const s = await getSecret().catch(() => null); if (s) secret = s; }, 10 * 60_000).unref();
