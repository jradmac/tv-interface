// Local stand-in for the relay and the box agent, so the TV and the remote can be tried in one browser.
// The Mechanic's relay replaces this; it sends the same message shapes.
(function () {
  if (!('BroadcastChannel' in window)) return;
  const ch = new BroadcastChannel('tv-room');
  const send = (m) => ch.postMessage(m);
  const S = window.SERVICES;
  const find = (txt) => {
    const t = (txt || '').toLowerCase().replace(/\+/g, ' plus');
    return S.find((s) => t.includes(s.name.toLowerCase().replace(/\+/g, ' plus')) || t.includes(s.k));
  };
  const remoteUrl = new URL('../remote/index.html', location.href).href;
  let inService = null;

  ch.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'tv-ready') send({ t: 'pair', code: 'K7Q4ZP', url: remoteUrl + '?local' });
    if (m.t === 'hello') send({ t: 'paired', name: m.name || 'Phone' });
    if (m.t === 'open') { inService = m.k; setTimeout(() => send({ t: 'state', mode: 'service', k: m.k }), 300); }
    if (m.t === 'state' && m.mode !== 'service') inService = null;
    if (m.t === 'voice' && m.phase === 'final') setTimeout(() => send(intent(m.text)), 500);
  };

  // A tiny stand-in for the AI step: four actions, a few canned answers.
  function intent(text) {
    const t = (text || '').trim();
    const low = t.toLowerCase();
    let x;
    if ((x = low.match(/^(open|go to|launch)\s+(.+)/))) {
      const s = find(x[2]);
      if (s) return { t: 'intent', kind: 'open', service: s.k, say: `Opening ${s.name}` };
    }
    if (/^(pause|resume|play$|stop|turn|volume|louder|quieter|skip|next)/.test(low)) {
      const say = /pause|stop/.test(low) ? 'Paused' : /resume|^play$/.test(low) ? 'Playing' : /turn it down|quieter/.test(low) ? 'Volume down'
        : /up|louder/.test(low) ? 'Volume up' : /skip|next/.test(low) ? 'Skipped ahead' : 'Done';
      return { t: 'intent', kind: 'control', say };
    }
    if ((x = low.match(/^(play|put on|watch|listen to)\s+(.+?)(?:\s+on\s+(.+))?$/))) {
      const s = x[3] && find(x[3]);
      const title = t.split(/\s+/).slice(x[1].split(' ').length).join(' ').replace(/\s+on\s+.+$/i, '');
      if (s) return { t: 'intent', kind: 'play', service: s.k, query: title, say: `Playing ${cap(title)} on ${s.name}` };
      return { t: 'intent', kind: 'search', query: t, say: t, results: [
        { title: cap(title.replace(/^the new episode of\s+/i, '')), service: 'max', sub: 'Season 2, Episode 7 · New' },
        { title: 'From the start', service: 'max', sub: 'Season 1, Episode 1' },
        { title: 'Recap', service: 'youtube', sub: '12 min' },
      ] };
    }
    return { t: 'intent', kind: 'search', query: t, say: t, results: [
      { title: cap(t), service: 'netflix', sub: 'Series · 3 seasons' },
      { title: cap(t), service: 'prime', sub: 'Movie · 2h 4m' },
      { title: cap(t) + ' explained', service: 'youtube', sub: '18 min' },
    ] };
  }
  const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
})();
