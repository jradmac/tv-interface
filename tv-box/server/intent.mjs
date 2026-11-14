// Turns what someone said into one action for the TV.
// With ANTHROPIC_API_KEY set (a Worker secret), Claude reads the words and answers in a fixed
// JSON shape. Without a key, or if the call fails, simple word rules handle the common asks.
//
// Result: { kind: 'play'|'do'|'open'|'search'|'control'|'none', say, service?, query?, results?, control? }
//   control: { a: 'playpause'|'pause'|'play'|'back10'|'fwd10'|'vol'|'mute'|'next'|'home', v? }

export const SERVICES = {
  netflix: 'Netflix',
  youtube: 'YouTube',
  prime: 'Prime Video',
  disney: 'Disney+',
  max: 'Max',
  applemusic: 'Apple Music',
  spotify: 'Spotify',
  claudecode: 'Claude Code',
  claude: 'Claude',
  gdocs: 'Google Docs',
  gsheets: 'Google Sheets',
  learningsuite: 'Learning Suite',
  chrome: 'Chrome',
  soulsilver: 'Pokémon SoulSilver',
};
const KEYS = Object.keys(SERVICES);
const CONTROLS = ['playpause', 'pause', 'play', 'back10', 'fwd10', 'vol', 'mute', 'next', 'home'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'say', 'service', 'query', 'control', 'volume', 'results'],
  properties: {
    kind: { type: 'string', enum: ['play', 'do', 'open', 'search', 'control', 'none'] },
    say: { type: 'string', description: 'Short line shown on the TV, e.g. "Playing Severance on Apple TV+".' },
    service: { type: 'string', enum: [...KEYS, ''], description: 'Service for play/open, or empty.' },
    query: { type: 'string', description: 'What to search for inside the service (a title, artist, song), or empty.' },
    control: { type: 'string', enum: [...CONTROLS, ''], description: 'For kind=control, the action; otherwise empty.' },
    volume: { type: 'integer', description: 'For control=vol: change in percent, e.g. 10 or -10. Otherwise 0.' },
    results: {
      type: 'array',
      description: 'For kind=search: up to 3 likely matches, best first. Otherwise empty.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'service', 'sub'],
        properties: {
          title: { type: 'string' },
          service: { type: 'string', enum: KEYS },
          sub: { type: 'string', description: 'One short detail, e.g. "Series · 2 seasons" or "Movie · 2019".' },
        },
      },
    },
  },
};

const SYSTEM = `You turn one spoken request into one action for a living-room TV.
Services on this TV: ${KEYS.map((k) => `${k} (${SERVICES[k]})`).join(', ')}.
Kinds:
- play: a specific title, song, artist or playlist, and you are confident which service has it (or the person named one). Fill service and query (the clean title only).
- open: open a service with nothing specific ("open Netflix", "go to YouTube").
- search: they want something but the service is unclear, or it's a vague ask ("something funny", "that new show with Adam Scott"). Give up to 3 results, each on a service that most likely streams it in the US; use YouTube for clips, trailers, recaps, music videos.
- do: anything that takes several steps on screen, or needs looking around: "play me a jazz playlist on YouTube", "play season 2 episode 3 of The Office", "turn on subtitles", "skip the intro", "go to my list on Netflix", "put on the latest episode of …". Fill service if one is named or obvious, else empty; query empty.
- control: playback or volume ("pause", "skip ahead", "louder", "go home", "next episode").
- none: not a TV request.
Music asks go to spotify unless they say Apple Music. chrome is the web browser. Websites and web searches ("search the web for…", "go to wikipedia") are open on chrome with the query. claudecode is a coding terminal on the TV. Never put claude, claudecode or chrome in search results. Keep say under 60 characters, friendly, no emoji.`;

export async function parseIntent(text, env = {}) {
  const words = String(text || '').trim();
  if (!words) return null;
  if (env.ANTHROPIC_API_KEY) {
    try {
      const ai = await askClaude(words, env);
      if (ai) return ai;
    } catch (e) {
      console.log('intent: Claude call failed, using rules', String(e));
    }
  }
  return parseRules(words);
}

async function askClaude(words, env) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.INTENT_MODEL || 'claude-haiku-5-5',
        max_tokens: 1024,
        system: SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: words }],
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') return null;
    const block = (data.content || []).find((b) => b.type === 'text');
    if (!block) return null;
    return clean(JSON.parse(block.text));
  } finally {
    clearTimeout(timer);
  }
}

// Keep only what the TV understands, whatever came back.
function clean(o) {
  if (!o || !['play', 'do', 'open', 'search', 'control', 'none'].includes(o.kind)) return null;
  const out = { kind: o.kind, say: String(o.say || '').slice(0, 80) };
  if (KEYS.includes(o.service)) out.service = o.service;
  if (o.query) out.query = String(o.query).slice(0, 120);
  if ((o.kind === 'play' || o.kind === 'open') && !out.service) return o.query ? { kind: 'search', say: out.say, query: out.query, results: [] } : null;
  if (o.kind === 'control') {
    if (!CONTROLS.includes(o.control)) return null;
    out.control = { a: o.control };
    if (o.control === 'vol') out.control.v = Math.max(-50, Math.min(50, Number(o.volume) || 10));
  }
  if (o.kind === 'search') {
    out.results = (Array.isArray(o.results) ? o.results : [])
      .filter((x) => x && x.title && KEYS.includes(x.service))
      .slice(0, 3)
      .map((x) => ({ title: String(x.title).slice(0, 80), service: x.service, sub: String(x.sub || '').slice(0, 60) }));
    if (!out.query) out.query = out.say;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Word rules, for no key or a failed call.

const ALIASES = [
  ['netflix', /\bnetflix\b/],
  ['youtube', /\byou ?tube\b/],
  ['prime', /\b(prime( video)?|amazon( prime)?)\b/],
  ['disney', /\bdisney( ?(\+|plus))?\b/],
  ['max', /\b(hbo( max)?|max)\b/],
  ['applemusic', /\bapple music\b/],
  ['spotify', /\bspotify\b/],
  ['claudecode', /\bclaude code\b/],
  ['claude', /\bclaude\b(?! code)/],
  ['gdocs', /\b(google )?docs\b/],
  ['gsheets', /\b(google )?sheets\b/],
  ['learningsuite', /\blearning ?suite\b/],
  ['soulsilver', /\b(pok[eé]mon( soul ?silver)?|soul ?silver)\b/],
  ['chrome', /\b(chrome|google chrome|(the )?(web )?browser|the web|the internet)\b/],
];
function findService(s) {
  for (const [k, re] of ALIASES) if (re.test(s)) return k;
  return null;
}
const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// Spoken requests come with padding: "Hey, can you open up a jazz playlist on YouTube for me?"
// Strip it down to "open jazz playlist on YouTube" before matching.
export function tidy(text) {
  let s = String(text || '').trim().replace(/[.!?,]+$/g, '').replace(/,/g, ' ').replace(/\s+/g, ' ');
  const lead = /^(hey|hi|hello|ok|okay|so|um|uh|yo|please|tv|claude|hey tv|hey claude|can you|could you|would you|will you|can we|could we|i want you to|i'd like you to|i would like you to|i want to|i'd like to|i would like to|let's|lets|go ahead and|just|maybe)\b\s*/i;
  for (let i = 0; i < 6 && lead.test(s); i++) s = s.replace(lead, '');
  s = s.replace(/\s+(please|for me|thanks|thank you|now|real quick)$/i, '').replace(/\s+(please|for me)$/i, '');
  s = s.replace(/^(open|pull|bring|put|turn|throw|fire) up\b/i, (m, v) => (/^(turn|put)$/i.test(v) ? v + ' on' : 'open'));
  // "open a jazz playlist on YouTube" means play it there.
  s = s.replace(/^(open|play|put on|watch|find|show me|start|listen to|search for|search)\s+(a|an|some|me a|me an|me some|me the|me)\s+/i, '$1 ');
  return s.trim();
}

export function parseRules(text) {
  const raw = tidy(text);
  const low = raw.toLowerCase();
  let m;

  // Controls.
  const c = (a, say, v) => ({ kind: 'control', say, control: v === undefined ? { a } : { a, v } });
  if (/^(go )?(back )?home$|^(go to|show) (the )?home( screen)?$|^exit$/.test(low)) return c('home', 'Going home');
  if (/^(pause|stop)( it| this| the (show|movie|music|song))?$/.test(low)) return c('pause', 'Paused');
  if (/^(resume|unpause|keep (going|playing)|play|continue)$/.test(low)) return c('play', 'Playing');
  if (/^(unmute|mute)( it| the tv)?$/.test(low)) return c('mute', low.startsWith('un') ? 'Sound on' : 'Muted');
  if (/(turn it up|louder|volume up|raise the volume)/.test(low)) return c('vol', 'Volume up', 10);
  if (/(turn it down|quieter|volume down|lower the volume)/.test(low)) return c('vol', 'Volume down', -10);
  if (/^(next episode|next song|next track|skip (this )?(song|track|episode))$/.test(low)) return c('next', 'Next');
  if ((m = low.match(/^(skip|go|jump|fast forward)( ahead| forward)?( (\d+) (seconds|secs))?$/)) && !/back/.test(low)) return c('fwd10', 'Skipped ahead');
  if (/^(go |skip |jump )?back( (\d+) (seconds|secs))?$|^rewind/.test(low)) return c('back10', 'Back 10 seconds');

  // Open a service.
  if ((m = low.match(/^(open|go to|launch|start|switch to|put on)\s+(.+)$/))) {
    const k = findService(m[2]);
    if (k && m[2].replace(ALIASES.find((a) => a[0] === k)[1], '').trim() === '') return { kind: 'open', service: k, say: `Opening ${SERVICES[k]}` };
  }
  // "open X on YouTube": X isn't a service, so play it there.
  if ((m = raw.match(/^(?:open|find|show me|get)\s+(.+?)\s+on\s+([a-z +]+)$/i))) {
    const k = findService(m[2].toLowerCase());
    if (k && k !== 'chrome' && k !== 'claudecode' && k !== 'claude') return { kind: 'play', service: k, query: m[1], say: `Playing ${cap(m[1])} on ${SERVICES[k]}` };
  }
  { const k = findService(low); if (k && low.replace(ALIASES.find((a) => a[0] === k)[1], '').trim() === '') return { kind: 'open', service: k, say: `Opening ${SERVICES[k]}` }; }

  // "Play SoulSilver", "let's play Pokémon": a game on the box, not a show.
  { const GAME_KEYS = ['soulsilver'];
    if ((m = low.match(/^(?:play|let'?s play|start|launch)\s+(.+)$/))) { const k = findService(m[1]); if (GAME_KEYS.includes(k) && m[1].replace(ALIASES.find((a) => a[0] === k)[1], '').trim() === '') return { kind: 'open', service: k, say: `Opening ${SERVICES[k]}` }; } }
  // Play X (on Y).
  if ((m = raw.match(/^(?:play|put on|watch|listen to|start|i want to watch)\s+(.+?)(?:\s+on\s+([a-z +]+))?$/i))) {
    let title = m[1].replace(/^(the (new|next|latest) episode of|some|a bit of)\s+/i, '').trim();
    const k = m[2] ? findService(m[2].toLowerCase()) : null;
    if (k) return { kind: 'play', service: k, query: title, say: `Playing ${cap(title)} on ${SERVICES[k]}` };
    if (/^listen to/i.test(m[0])) return { kind: 'play', service: 'spotify', query: title, say: `Playing ${cap(title)} on Spotify` };
    return searchFor(title);
  }

  // The web: "search the web for X", "google X", "go to wikipedia.org".
  if ((m = raw.match(/^(?:search (?:the web|the internet|google|online) for|google|look up online)\s+(.+)$/i))) {
    return { kind: 'open', service: 'chrome', query: m[1], say: `Searching the web for ${m[1]}` };
  }
  if ((m = raw.match(/^(?:go to|open)\s+((?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?)$/i))) {
    return { kind: 'open', service: 'chrome', query: m[1], say: `Opening ${m[1]}` };
  }

  // Search / find X.
  if ((m = raw.match(/^(?:search( for)?|find|look for|look up|show me)\s+(.+?)(?:\s+on\s+([a-z +]+))?$/i))) {
    const k = m[3] ? findService(m[3].toLowerCase()) : null;
    if (k) return { kind: 'open', service: k, query: m[2], say: `Searching ${SERVICES[k]} for ${m[2]}` };
    return searchFor(m[2]);
  }

  // Anything else that names a service at the end: "jazz playlist on YouTube".
  if ((m = raw.match(/^(.+?)\s+on\s+([a-z +]+)$/i))) {
    const k = findService(m[2].toLowerCase());
    if (k && k !== 'chrome' && k !== 'claudecode' && k !== 'claude') return { kind: 'play', service: k, query: m[1], say: `Playing ${cap(m[1])} on ${SERVICES[k]}` };
  }
  return searchFor(raw);
}

// Without the AI step we can't know where a title streams, so offer to search each video service.
function searchFor(q) {
  const t = cap(q);
  return {
    kind: 'search',
    query: q,
    say: `Where to look for ${t}?`,
    results: [
      { title: t, service: 'netflix', sub: 'Search Netflix' },
      { title: t, service: 'prime', sub: 'Search Prime Video' },
      { title: t, service: 'youtube', sub: 'Search YouTube' },
    ],
  };
}
