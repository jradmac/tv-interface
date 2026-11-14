#!/usr/bin/env python3
"""Adds the DS games hooks to a TV app folder (idempotent). Usage: apply_games.py <app dir>
Only additive edits to shared files; everything else lives in new files
(server/games.mjs, games/, games-bin/)."""
import sys, re, os

APP = sys.argv[1]
changed = []

def edit(rel, fn):
    p = os.path.join(APP, rel)
    s = open(p, encoding='utf-8').read()
    n = fn(s)
    if n != s:
        open(p, 'w', encoding='utf-8').write(n)
        changed.append(rel)

def once(s, marker, anchor, new, after=True):
    """Insert `new` next to the unique `anchor`, unless `marker` is already there."""
    if marker in s:
        return s
    if s.count(anchor) != 1:
        raise SystemExit(f'anchor not unique/found: {anchor!r} (count {s.count(anchor)})')
    return s.replace(anchor, anchor + new if after else new + anchor)

# ---- server.mjs ---------------------------------------------------------------------------
def server(s):
    s = once(s, "from './games.mjs'", "import { parseIntent } from './intent.mjs';\n",
             "import { createGames } from './games.mjs';\n")
    s = once(s, 'const games = createGames(', "const TYPES = {",
             "// DS games: the player, its sockets and /api/games (server/games.mjs).\n"
             "const games = createGames({ ROOT, DIR, state, room, Sock, acceptWs, isLocal, sha256, log });\n\n", after=False)
    s = once(s, 'games.http(req, res, url)', "      if (p === '/api/health')",
             "      if (p.startsWith('/api/games') && games.http(req, res, url)) return;\n", after=False)
    s = once(s, "'/games/ws'", "  if (url.pathname === '/term/ws'",
             "  if (url.pathname === '/games/ws' && String(req.headers.upgrade).toLowerCase() === 'websocket') return games.upgrade(req, socket, url);\n", after=False)
    if "'games'" not in s.split('const PUBLIC')[1].split('\n')[0]:
        s = re.sub(r"(const PUBLIC = \[[^\]]*)\]", r"\1, 'games']", s, count=1)
    s = once(s, 's.send(games.status())', "      s.send(roku.status());\n",
             "      s.send(games.status());   // a game is running: the phone becomes the controller\n")
    return s
edit('server/server.mjs', server)

# ---- agent.mjs: game cards open the box's own game page --------------------------------------
GAMES_JS = ("  // DS games: the box's own game page (/games/tv.html; ?tv=&k= are added once registered).\n"
            "  soulsilver: { name: 'Pokémon SoulSilver', home: 'http://127.0.0.1/games/tv.html', game: 'pokemon-soulsilver-version', hosts: [], paths: ['127.0.0.1/games/', 'localhost/games/'] },\n")
def agent(s):
    s = once(s, "soulsilver:", "  // A general web browser.", GAMES_JS, after=False)
    s = once(s, "s.game) s.home", "  SERVICES.claudecode.home = `${server}/term/?tv=${cfg.tv}&k=${cfg.secret}`;\n",
             "  for (const s of Object.values(SERVICES)) if (s.game) s.home = `${server}/games/tv.html?g=${s.game}&tv=${cfg.tv}&k=${cfg.secret}`;\n")
    s = once(s, "game: !!s.game", "term: !!s.term,", " game: !!s.game,")
    return s
edit('agent/agent.mjs', agent)

# ---- services.js: the card in the Games space ------------------------------------------------
CARD = "    // Games\n    { k: 'soulsilver', spaces: ['games'], name: 'Pokémon SoulSilver', url: '/games/',\n      bg: 'linear-gradient(180deg,rgba(14,24,58,0) 52%,rgba(14,24,58,.62)),url(/games/art/soulsilver.jpg) center 70%/cover,#DCE3EF', fg: '#fff', accent: '#E8EEF8', solid: '#23345F', art: '/games/art/soulsilver.jpg',\n      mark: () => '<span></span>',\n      tag: 'Nintendo DS · your phone is the touch screen' },\n"
def services(s):
    s = once(s, "k: 'soulsilver'", "  ];\n  // Spaces:", CARD, after=False)
    s = s.replace("{ k: 'games', name: 'Games', sub: 'Nothing here yet' }", "{ k: 'games', name: 'Games', sub: 'Pokémon SoulSilver' }")
    return s
edit('shared/services.js', services)

# ---- intent.mjs: "play SoulSilver", "open Pokémon" --------------------------------------------
def intent(s):
    s = once(s, "soulsilver:", "  chrome: 'Chrome',\n};", "", after=False) if False else s
    if "soulsilver:" not in s:
        s = s.replace("  chrome: 'Chrome',\n};", "  chrome: 'Chrome',\n  soulsilver: 'Pokémon SoulSilver',\n};", 1)
    s = once(s, "['soulsilver'", "  ['chrome', /", "  ['soulsilver', /\\b(pok[eé]mon( soul ?silver)?|soul ?silver)\\b/],\n", after=False)
    s = once(s, "GAME_KEYS", "  // Play X (on Y).\n",
             "  // \"Play SoulSilver\", \"let's play Pokémon\": a game on the box, not a show.\n"
             "  { const GAME_KEYS = ['soulsilver'];\n"
             "    if ((m = low.match(/^(?:play|let'?s play|start|launch)\\s+(.+)$/))) { const k = findService(m[1]); if (GAME_KEYS.includes(k) && m[1].replace(ALIASES.find((a) => a[0] === k)[1], '').trim() === '') return { kind: 'open', service: k, say: `Opening ${SERVICES[k]}` }; } }\n",
             after=False)
    return s
edit('server/intent.mjs', intent)

# ---- remote.js: a running game turns the phone into the controller -------------------------
def remote(s):
    return once(s, "/games/pad.html", "    if (m.t === 'sounds') paintSounds(m.on !== false);\n",
                "    if (m.t === 'game' && m.running && !/[?&]demo\\b/.test(location.search)) location.href = '/games/pad.html';\n")
edit('remote/remote.js', remote)

# ---- build.sh: pack the game pages and the player --------------------------------------------
def build(s):
    if 'games-bin' in s:
        return s
    return s.replace('for d in tv remote shared term server agent termd', 'for d in tv remote shared term server agent termd games games-bin', 1)
edit('box/build.sh', build)

print('changed:', ', '.join(changed) or 'nothing')
