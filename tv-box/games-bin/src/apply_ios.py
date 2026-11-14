#!/usr/bin/env python3
"""DS pad hooks for the iPhone app (idempotent). Usage: apply_ios.py <ios dir>"""
import sys, os
D = sys.argv[1]
def edit(rel, fn):
    p = os.path.join(D, rel); s = open(p, encoding='utf-8').read(); n = fn(s)
    if n != s: open(p, 'w', encoding='utf-8').write(n); print('changed', rel)
def once(s, marker, anchor, new, after=True):
    if marker in s: return s
    assert s.count(anchor) == 1, f'anchor {anchor!r} count {s.count(anchor)}'
    return s.replace(anchor, anchor + new if after else new + anchor)
def tvlink(s):
    s = once(s, 'struct GameInfo', 'final class TVLink: ObservableObject {',
             '/// A DS game running on the TV: the app turns into the game controller (DSPad.swift).\nstruct GameInfo: Equatable {\n    let g: String\n    let title: String\n}\n\n', after=False)
    s = once(s, 'var game: GameInfo?', '    @Published private(set) var space = "living"\n',
             '    @Published private(set) var game: GameInfo?\n')
    s = once(s, 'case "game":', '        case "paired":\n',
             '        case "game":\n            let running = m["running"] as? Bool ?? false\n            game = running ? GameInfo(g: m["g"] as? String ?? "", title: m["title"] as? String ?? "Game") : nil\n', after=False)
    return s
def root(s):
    s = once(s, 'DSPadScreen()', '            HiddenVolumeView(buttons: volume)',
             '            if link.game != nil {\n                DSPadScreen()\n                    .transition(.opacity)\n                    .zIndex(20)\n            }\n', after=False)
    s = once(s, 'value: link.game)', '        .animation(.tv, value: showSpaces)\n', '        .animation(.tv, value: link.game)\n')
    return s
edit('TVRemote/TVLink.swift', tvlink)
edit('TVRemote/RootView.swift', root)
