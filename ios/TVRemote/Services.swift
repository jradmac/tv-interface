import SwiftUI

/// The apps on the TV, in the same order as shared/services.js.
struct Service: Identifiable, Equatable {
    let k: String
    let name: String
    let bg: [Color]          // tile background, top-left to bottom-right
    let accent: Color
    let solid: Color         // the mark's color on the white pad
    var music = false
    var spaces: [String] = ["living"]
    var placeholder = false
    var symbol: String? = nil   // an SF Symbol instead of a brand mark
    var art: String? = nil      // a picture (game box art) instead of a mark
    var id: String { k }

    /// Color of the mark on the dark/colored tile in the Apps grid.
    var tileMarkColor: Color {
        switch k {
        case "youtube": return Color(hex: 0xFF0033)
        case "netflix", "prime", "spotify", "claudecode", "gdocs", "gsheets": return accent
        case _ where placeholder: return accent
        default: return .white
        }
    }
    /// Color of the mark on the white pad ("On screen").
    var padMarkColor: Color {
        switch k {
        case "youtube", "netflix", "spotify": return accent
        case "chrome": return .white
        default: return solid
        }
    }
}

enum Services {
    static let all: [Service] = [
        Service(k: "netflix", name: "Netflix", bg: [Color(hex: 0x2A0A0C), .black, .black], accent: Color(hex: 0xE50914), solid: .black),
        Service(k: "youtube", name: "YouTube", bg: [.white, .white], accent: Color(hex: 0xFF0033), solid: .white),
        Service(k: "prime", name: "Prime Video", bg: [Color(hex: 0x0F171E), Color(hex: 0x1B2A38)], accent: Color(hex: 0x1A98FF), solid: Color(hex: 0x0F171E)),
        Service(k: "disney", name: "Disney+", bg: [Color(hex: 0x0B1437), Color(hex: 0x0E3A5B), Color(hex: 0x1A6A86)], accent: Color(hex: 0x7FD6F5), solid: Color(hex: 0x0B1437)),
        Service(k: "max", name: "Max", bg: [Color(hex: 0x0029D6), Color(hex: 0x002BE7), Color(hex: 0x001E9E)], accent: .white, solid: Color(hex: 0x002BE7)),
        Service(k: "applemusic", name: "Apple Music", bg: [Color(hex: 0xFA243C), Color(hex: 0xFB5C74)], accent: .white, solid: Color(hex: 0xFA243C), music: true),
        Service(k: "spotify", name: "Spotify", bg: [Color(hex: 0x121212), Color(hex: 0x1A1A1A), Color(hex: 0x0E2A18)], accent: Color(hex: 0x1ED760), solid: Color(hex: 0x121212), music: true),
        Service(k: "chrome", name: "Chrome", bg: [.white, Color(hex: 0xEEF1F6)], accent: Color(hex: 0x4285F4), solid: .white, spaces: ["living", "school"]),
        Service(k: "claude", name: "Claude", bg: [Color(hex: 0xDE8565), Color(hex: 0xC96442), Color(hex: 0xB9573A)], accent: Color(hex: 0xFAF9F5), solid: Color(hex: 0xD97757), spaces: ["living", "school"]),
        Service(k: "claudecode", name: "Claude Code", bg: [Color(hex: 0x2B2926), Color(hex: 0x171615)], accent: Color(hex: 0xD97757), solid: Color(hex: 0x1F1E1D)),
        // School
        Service(k: "gdocs", name: "Google Docs", bg: [.white, Color(hex: 0xEEF3FE)], accent: Color(hex: 0x4285F4), solid: Color(hex: 0x4285F4), spaces: ["school"]),
        Service(k: "gsheets", name: "Google Sheets", bg: [.white, Color(hex: 0xECF7EF)], accent: Color(hex: 0x34A853), solid: Color(hex: 0x34A853), spaces: ["school"]),
        Service(k: "learningsuite", name: "Learning Suite", bg: [Color(hex: 0x0B4A8B), Color(hex: 0x002E5D)], accent: .white, solid: Color(hex: 0x002E5D), spaces: ["school"], symbol: "book"),
        // Games (the box runs them; the phone becomes the controller)
        Service(k: "soulsilver", name: "Pokémon SoulSilver", bg: [Color(hex: 0x3A4C7E), Color(hex: 0x23345F)], accent: Color(hex: 0xE8EEF8), solid: Color(hex: 0x23345F), spaces: ["games"], art: "art-soulsilver"),
    ]

    /// Living room, School, Games. A space is a filter over the apps; the TV and box remember which is on.
    struct Space: Identifiable {
        let k: String
        let name: String
        let sub: String
        var id: String { k }
    }
    static let spaces: [Space] = [
        Space(k: "living", name: "Living room", sub: "Shows, music and more"),
        Space(k: "school", name: "School", sub: "Docs, Sheets and Learning Suite"),
        Space(k: "games", name: "Games", sub: "Pokémon SoulSilver"),
    ]
    static func space(_ k: String) -> Space { spaces.first { $0.k == k } ?? spaces[0] }

    /// An empty space shows one placeholder card instead of nothing.
    static func placeholder(_ name: String) -> Service {
        Service(k: "placeholder", name: name, bg: [Color(hex: 0x2D2742), Color(hex: 0x16132A)], accent: Color(hex: 0xB9A8FF),
                solid: Color(hex: 0x2D2742), spaces: [], placeholder: true, symbol: "gamecontroller")
    }

    /// The apps in a space, in the TV's order: the space's own apps first, then shared ones (Chrome, Claude).
    static func inSpace(_ space: String) -> [Service] {
        let list = all.filter { $0.spaces.contains(space) }
        let own = list.filter { $0.spaces.first == space }, shared = list.filter { $0.spaces.first != space }
        return list.isEmpty ? [placeholder(Services.space(space).name)] : own + shared
    }

    static func by(_ k: String?) -> Service {
        if k == "placeholder" { return placeholder("Games") }
        guard let k else { return all[0] }
        if let s = all.first(where: { $0.k == k }) { return s }
        // Something the app doesn't know yet (a new game or app on the TV): a plain mark, never another app's logo.
        return Service(k: k, name: "App", bg: [Color(hex: 0x2D2742), Color(hex: 0x16132A)], accent: Color(hex: 0xB9A8FF),
                       solid: Color(hex: 0x2D2742), spaces: [], symbol: "app")
    }
}

/// A brand mark. Vector PDFs in the asset catalog; Disney+ is set in type and Claude Code is drawn.
struct ServiceMark: View {
    let service: Service
    let color: Color
    let size: CGFloat
    var onTile = false

    var body: some View {
        if let art = service.art {
            Image(art)
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        } else if let symbol = service.symbol {
            Image(systemName: symbol)
                .resizable()
                .scaledToFit()
                .fontWeight(.medium)
                .foregroundStyle(color)
                .frame(width: size * 0.9, height: size * 0.9)
        } else {
            mark
        }
    }

    @ViewBuilder private var mark: some View {
        switch service.k {
        case "disney":
            (Text("Disney").foregroundColor(onTile ? .white : Color(hex: 0x0B1437))
             + Text("+").foregroundColor(onTile ? Color(hex: 0x7FD6F5) : Color(hex: 0x1A6A86)))
                .font(.system(size: onTile ? size * 0.42 : size * 0.62, weight: .semibold))
                .tracking(-0.6)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        case "claudecode":
            PromptShape()
                .stroke(color, style: StrokeStyle(lineWidth: size * 0.108, lineCap: .round, lineJoin: .round))
                .frame(width: size, height: size)
        case "chrome":
            Image("mark-chrome").resizable().scaledToFit().frame(width: size, height: size)
        default:
            Image("mark-\(service.k)")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(color)
                .frame(width: size, height: size)
        }
    }
}

/// The terminal prompt ">_" from services.js (M4.5 6.5 l6 5.5 -6 5.5 M13 18 h7 on a 24 grid).
struct PromptShape: Shape {
    func path(in r: CGRect) -> Path {
        let s = min(r.width, r.height) / 24
        var p = Path()
        p.move(to: CGPoint(x: r.minX + 4.5 * s, y: r.minY + 6.5 * s))
        p.addLine(to: CGPoint(x: r.minX + 10.5 * s, y: r.minY + 12 * s))
        p.addLine(to: CGPoint(x: r.minX + 4.5 * s, y: r.minY + 17.5 * s))
        p.move(to: CGPoint(x: r.minX + 13 * s, y: r.minY + 18 * s))
        p.addLine(to: CGPoint(x: r.minX + 20 * s, y: r.minY + 18 * s))
        return p
    }
}
