#!/usr/bin/env python3
"""Adds the Rain, Jungle and Aurora themes to the iPhone app's Theme row (PadArea.swift) and
lays the row out on two lines. Safe to run twice. Usage: python3 add-themes.py <path to TVRemote folder>"""
import sys, pathlib
p = pathlib.Path(sys.argv[1]) / "TVRemote" / "PadArea.swift"
s = p.read_text()
if '"jungle"' in s:
    print("already done"); sys.exit(0)
tech = '        Choice(k: "tech", name: "Tech", swatch: [Color(hex: 0x3B7BFF), Color(hex: 0x0D1424), Color(hex: 0x06080D)]),\n'
assert tech in s
s = s.replace(tech, tech
    + '        Choice(k: "rain", name: "Rain", swatch: [Color(hex: 0x3A4C5E), Color(hex: 0x18222C), Color(hex: 0x0A0F15)]),\n'
    + '        Choice(k: "jungle", name: "Jungle", swatch: [Color(hex: 0xBFE8A8), Color(hex: 0x2F7A4A), Color(hex: 0x12301F), Color(hex: 0x06110A)]),\n'
    + '        Choice(k: "aurora", name: "Aurora", swatch: [Color(hex: 0x7A5AE0), Color(hex: 0x2BD9A8), Color(hex: 0x0B1C24), Color(hex: 0x050B12)]),\n')
s = s.replace("/// The TV's look: Light, Dark, Nature, Tech.", "/// The TV's look: Light, Dark, Nature, Tech, Rain, Jungle, Aurora.")
head = "    var body: some View {\n        HStack(spacing: compact ? 6 : 8) {\n            ForEach(Self.themes) { t in\n"
tail = "            }\n        }\n        .animation(.tv, value: link.theme)\n    }\n"
a = s.index(head); b = s.index(tail, a)
inner = s[a + len(head):b]
chip = "".join((l[8:] if l.startswith("        ") else l) for l in inner.splitlines(True))
new = '''    /// Seven themes don't fit on one line of a phone, so they sit on two.
    private static let rows: [[Choice]] = [Array(themes.prefix(4)), Array(themes.dropFirst(4))]

    var body: some View {
        VStack(alignment: compact ? .center : .leading, spacing: compact ? 6 : 8) {
            ForEach(Self.rows.indices, id: \\.self) { r in
                HStack(spacing: compact ? 6 : 8) {
                    ForEach(Self.rows[r]) { t in chip(t) }
                }
            }
        }
        .animation(.tv, value: link.theme)
    }

    @ViewBuilder
    private func chip(_ t: Choice) -> some View {
''' + chip + "    }\n"
s = s[:a] + new + s[b + len(tail):]
p.write_text(s)
print("updated", p)
