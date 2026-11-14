// Claude Code on the TV: a full-screen xterm attached to the box's `claude` session.
// The server keeps the session alive; on connect it replays recent output, so leaving and coming back is seamless.
// Wire: page → server JSON {t:'in', d} and {t:'resize', cols, rows}; server → page raw text frames.
// The phone's typing arrives as real key presses (the agent drives Chrome), so xterm simply sees a keyboard.
// ?demo runs without a server, echoing locally (for design checks).
(() => {
  const el = document.getElementById('term');
  const stateEl = document.getElementById('ccState');
  const demo = /[?&]demo\b/.test(location.search);

  const term = new Terminal({
    fontFamily: 'ui-monospace, "JetBrains Mono", "DejaVu Sans Mono", Menlo, monospace',
    fontSize: 24,
    lineHeight: 1.0,   // box-drawing characters need to touch line to line (Claude Code draws boxes)
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 3,
    scrollback: 4000,
    allowTransparency: true,
    macOptionIsMeta: true,
    theme: {
      background: 'rgba(0,0,0,0)',
      foreground: '#ECE9E2',
      cursor: '#D97757',
      cursorAccent: '#1A1918',
      selectionBackground: 'rgba(217,119,87,.35)',
      black: '#1A1918', brightBlack: '#6E6A63',
      red: '#E5786D', brightRed: '#F0948A',
      green: '#8CC49A', brightGreen: '#A6D6B1',
      yellow: '#E6C07B', brightYellow: '#F0D196',
      blue: '#8AB4F0', brightBlue: '#A8C8F5',
      magenta: '#D9A0D6', brightMagenta: '#E6B8E3',
      cyan: '#7FC8CF', brightCyan: '#9AD7DD',
      white: '#D9D5CC', brightWhite: '#FAF9F5',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);

  // Keys go to the terminal, always: nothing else on this page takes focus.
  const focus = () => term.focus();
  focus();
  addEventListener('focus', focus);
  addEventListener('pointerdown', () => setTimeout(focus, 0));
  term.textarea && term.textarea.addEventListener('blur', () => setTimeout(focus, 50));

  function setState(text, live) {
    stateEl.textContent = text;
    stateEl.classList.toggle('live', !!live);
  }

  // ---------- Demo (no server) ----------
  if (demo) {
    setState('Demo', true);
    el.classList.add('on');
    fit.fit();
    const o = '\x1b[38;2;217;119;87m', r = '\x1b[0m', d = '\x1b[38;2;140;135;126m';
    term.write(`${o}╭───────────────────────────────────────────╮${r}\r\n${o}│${r} ${o}✻${r} Welcome to ${'\x1b[1m'}Claude Code${r}!                  ${o}│${r}\r\n${o}│${r}                                           ${o}│${r}\r\n${o}│${r}   ${d}/help for help, /status for setup${r}       ${o}│${r}\r\n${o}│${r}   ${d}cwd: /home/jaredmackay${r}                  ${o}│${r}\r\n${o}╰───────────────────────────────────────────╯${r}\r\n\r\n${d}> ${r}`);
    term.onData((s) => term.write(s === '\r' ? `\r\n${d}> ${r}` : s === '\x7f' ? '\b \b' : s));
    addEventListener('resize', () => fit.fit());
    return;
  }

  // ---------- Live session ----------
  let ws = null, tries = 0, opened = false;
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  function sendSize() { send({ t: 'resize', cols: term.cols, rows: term.rows }); }
  function refit() { try { fit.fit(); } catch (e) {} sendSize(); }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/term/ws${location.search}`);
    ws.binaryType = 'arraybuffer';
    const dec = new TextDecoder();
    ws.onopen = () => {
      tries = 0;
      setState('Connected', true);
      if (opened) term.reset();          // the server replays recent output on every connect
      opened = true;
      refit();
      el.classList.add('on');
      focus();
    };
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : dec.decode(e.data, { stream: true }));
    ws.onclose = () => {
      setState('Reconnecting…', false);
      const wait = Math.min(8000, 400 * 2 ** tries++);
      setTimeout(connect, wait);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  term.onData((d) => send({ t: 'in', d }));
  term.onBinary((d) => send({ t: 'in', d }));
  term.onTitleChange((t) => { if (t) document.title = t; });
  let rt = 0;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(refit, 120); });
  // Fonts can land after the first fit; fit again once they're in.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
  connect();
})();
