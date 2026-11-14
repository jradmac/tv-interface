import SwiftUI
import VisionKit

/// The white pad: what's on screen, the voice transcript, the countdown, pairing, the touchpad,
/// the Apps grid and the "Claude is on it" strip, all in one card.
struct PadArea: View {
    @EnvironmentObject var link: TVLink
    @EnvironmentObject var listener: Listener
    let talking: Bool
    @Binding var showKey: Bool
    @Binding var showScan: Bool
    @State private var controls = false

    private var st: TVState { link.state }
    private var canSwap: Bool { !pairing && !voice && st.mode != "apps" && st.mode != "countdown" }
    private var pairing: Bool { link.status == .needPair }
    private var voice: Bool { !pairing && (talking || st.mode == "voice") }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 32, style: .continuous).fill(.white).rest()
            TouchPad(mode: st.mode, enabled: !pairing && st.mode != "apps") { m in
                // Any tap or swipe while Claude is working stops it (and still does what it does).
                if link.agentRunning { link.stopAgent(); Haptics.press() }
                link.send(m)
            }
                .clipShape(RoundedRectangle(cornerRadius: 32, style: .continuous))

            Group {
                if pairing {
                    PairView(showScan: $showScan)
                } else if voice {
                    VoiceView(text: listener.text.isEmpty ? "" : listener.text, live: talking)
                        .allowsHitTesting(false)
                } else if st.mode == "countdown" {
                    CountdownView(say: st.countdownSay ?? "Playing", id: st.countdownID)
                } else if st.mode == "service" {
                    ServiceLabel(name: st.k == "chrome" ? (st.title.isEmpty ? "Chrome" : st.title) : Services.by(st.k).name)
                        .allowsHitTesting(false)
                } else {
                    OnScreen()
                        .allowsHitTesting(false)
                }
            }
            .padding(24)
            .transition(.opacity)

            if !pairing && !voice && !hint.isEmpty {
                VStack {
                    Spacer()
                    Text(hint).font(.system(size: 13)).foregroundStyle(Color.mute).padding(.bottom, 22)
                }
                .allowsHitTesting(false)
            }

            if controls && canSwap {
                ZStack {
                    RoundedRectangle(cornerRadius: 32, style: .continuous).fill(.white)
                    VStack(spacing: 14) {
                        Text("ARROWS").font(.system(size: 12, weight: .medium)).tracking(1.7).foregroundStyle(Color.mute)
                        DPad()
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.97)))
            }

            if st.mode == "apps" && !pairing {
                AppsGrid(selected: st.focusK)
                    .transition(.opacity)
            }

            if let sp = link.spaceLoading, !pairing {
                SpaceCurtain(space: Services.space(sp))
                    .transition(.opacity)
                    .zIndex(5)
            }

            if canSwap {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button {
                            controls.toggle()
                            Haptics.tap()
                        } label: {
                            Image(systemName: controls ? "hand.point.up.left" : "circle.grid.cross")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Color.ink2)
                                .frame(width: 38, height: 38)
                                .background(Circle().fill(Color.room))
                                .contentTransition(.symbolEffect(.replace))
                        }
                        .buttonStyle(PressStyle(scale: 0.9))
                        .accessibilityLabel(controls ? "Use the touchpad" : "Use arrow buttons")
                    }
                }
                .padding(14)
            }
        }
        .animation(.tv, value: st.mode)
        .animation(.tv, value: pairing)
        .animation(.tv, value: controls)
        .animation(.easeOut(duration: 0.2), value: voice)
        .animation(.easeOut(duration: 0.35), value: link.spaceLoading)
    }

    private var hint: String {
        switch st.mode {
        case "service": return "Drag to move · Tap to click · Two fingers to scroll"
        case "results": return "Swipe to choose · Tap to play"
        case "pair": return "Connecting to the TV…"
        case "countdown", "apps": return ""
        default: return "Swipe to move · Tap to open"
        }
    }
}

/// Switching spaces: the same curtain as the TV (the space's name rising in), over the pad,
/// until the TV has the new space up.
struct SpaceCurtain: View {
    let space: Services.Space
    @State private var shown = false
    @State private var pulse = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 32, style: .continuous).fill(.white)
            VStack(spacing: 8) {
                Text(space.name)
                    .font(.system(size: 34, weight: .semibold))
                    .tracking(-1.2)
                    .foregroundStyle(Color.ink)
                    .opacity(shown ? 1 : 0)
                    .offset(y: shown ? 0 : 14)
                Text(space.sub)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.mute)
                    .opacity(shown ? 1 : 0)
                HStack(spacing: 7) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle().fill(Color.mute).frame(width: 7, height: 7)
                            .opacity(pulse ? 1 : 0.25)
                            .scaleEffect(pulse ? 1 : 0.8)
                            .animation(.easeInOut(duration: 0.55).repeatForever().delay(Double(i) * 0.15), value: pulse)
                    }
                }
                .padding(.top, 18)
                .opacity(shown ? 1 : 0)
            }
        }
        .allowsHitTesting(true)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Switching to \(space.name)")
        .onAppear {
            withAnimation(.spring(response: 0.55, dampingFraction: 0.7).delay(0.06)) { shown = true }
            pulse = true
        }
    }
}

/// "On screen" with the focused app's mark and name (or the selected search result).
struct OnScreen: View {
    @EnvironmentObject var link: TVLink
    private var st: TVState { link.state }

    var body: some View {
        let picked = st.mode == "results" ? st.results.first(where: { $0.on }) : nil
        let svc = Services.by(picked?.service ?? st.focusK)
        let label = picked?.title ?? st.focusName ?? svc.name
        VStack(spacing: 12) {
            Text(st.mode == "results" ? "RESULTS" : "ON SCREEN")
                .font(.system(size: 12, weight: .medium))
                .tracking(1.7)
                .foregroundStyle(Color.mute)
            ZStack {
                ServiceMark(service: svc, color: svc.padMarkColor, size: 64)
                    .id(svc.k)
                    .transition(.opacity)
            }
            .frame(height: 64)
            Text(label)
                .font(.system(size: 26, weight: .semibold))
                .tracking(-0.8)
                .foregroundStyle(Color.ink)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .id(label)
                .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 6)), removal: .opacity))
        }
        .animation(.tv, value: label)
    }
}

struct ServiceLabel: View {
    let name: String
    var body: some View {
        VStack(spacing: 12) {
            Text("TOUCHPAD").font(.system(size: 12, weight: .medium)).tracking(1.7).foregroundStyle(Color.mute)
            Text(name).font(.system(size: 20, weight: .semibold)).tracking(-0.6).foregroundStyle(Color.ink)
                .multilineTextAlignment(.center).lineLimit(2)
        }
    }
}

/// What you're saying, word by word. The last two words stay soft until you finish.
struct VoiceView: View {
    let text: String
    let live: Bool
    var body: some View {
        VStack(spacing: 12) {
            Text("LISTENING").font(.system(size: 12, weight: .medium)).tracking(1.7).foregroundStyle(Color.mute)
            said
                .font(.system(size: 26, weight: .medium))
                .tracking(-0.5)
                .lineSpacing(4)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)
                .animation(.easeOut(duration: 0.15), value: text)
        }
    }
    private var said: Text {
        let w = text.split(separator: " ").map(String.init)
        let soft = live ? max(0, w.count - 2) : w.count
        var t = Text("")
        for (i, word) in w.enumerated() {
            t = t + Text((i > 0 ? " " : "") + word).foregroundColor(i >= soft ? .mute : .ink)
        }
        return t
    }
}

/// "Playing …" with a 3-second ring and Cancel.
struct CountdownView: View {
    @EnvironmentObject var link: TVLink
    let say: String
    let id: Int
    @State private var progress: CGFloat = 0

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle().stroke(Color.line, lineWidth: 4)
                Circle()
                    .trim(from: progress, to: 1)
                    .stroke(Color.ink, style: StrokeStyle(lineWidth: 4, lineCap: .butt))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 40, height: 40)
            Text(say).font(.system(size: 20, weight: .semibold)).tracking(-0.6).foregroundStyle(Color.ink)
                .multilineTextAlignment(.center)
            Button {
                link.send(["t": "back"]); Haptics.press()
            } label: {
                Text("Cancel").font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                    .padding(.vertical, 18).padding(.horizontal, 44)
                    .background(Capsule().fill(Color.ink))
            }
            .buttonStyle(PressStyle(scale: 0.96))
        }
        .onAppear(perform: run)
        .onChange(of: id) { _, _ in run() }
    }
    private func run() {
        progress = 0
        withAnimation(.linear(duration: 3)) { progress = 1 }
    }
}

/// Pairing: type the code the TV shows, or scan its QR code.
struct PairView: View {
    @EnvironmentObject var link: TVLink
    @Binding var showScan: Bool
    @State private var code = ""
    @State private var error = ""
    @State private var busy = false
    @State private var showAddress = false
    @State private var host = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 12) {
            Text("PAIR WITH YOUR TV").font(.system(size: 12, weight: .medium)).tracking(1.7).foregroundStyle(Color.mute)
            Text(link.boxMissing ? "Looking for the TV box…" : "Enter the code on the TV")
                .font(.system(size: 20, weight: .semibold)).tracking(-0.6).foregroundStyle(Color.ink)
            TextField("K7Q4ZP", text: $code)
                .font(.system(size: 30, weight: .medium, design: .monospaced))
                .tracking(4)
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .textContentType(.oneTimeCode)
                .submitLabel(.go)
                .focused($focused)
                .frame(width: 220)
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) { Rectangle().fill(focused ? Color.ink : Color.line).frame(height: 2) }
                .onChange(of: code) { _, v in
                    let clean = String(v.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(6))
                    if clean != v { code = clean }
                    if clean.count == 6 && !busy { submit() }
                }
                .onSubmit(submit)
            Button(action: submit) {
                Text(busy ? "Connecting…" : "Connect").font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                    .padding(.vertical, 16).padding(.horizontal, 44)
                    .background(Capsule().fill(Color.ink))
            }
            .buttonStyle(PressStyle(scale: 0.96))
            .disabled(busy)
            Text(error).font(.system(size: 14)).foregroundStyle(Color.danger).multilineTextAlignment(.center).frame(minHeight: 18)
            HStack(spacing: 18) {
                if DataScannerViewController.isSupported {
                    Button("Scan the QR code") { showScan = true }
                }
                Button("TV address") { host = link.manualHost; showAddress = true }
            }
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Color.ink2)
        }
        .onAppear { if link.address == nil { link.findBoxForPairing() } }
        .alert("TV box address", isPresented: $showAddress) {
            TextField("tv.local", text: $host)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            Button("Use") { link.useHost(host) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Normally the app finds the TV box by itself. If it can’t, type its name or number (for example 192.168.0.50).")
        }
    }

    private func submit() {
        guard code.count == 6 else { error = "The code has 6 letters and numbers."; return }
        error = ""
        busy = true
        Task {
            do {
                _ = try await link.pair(code: code)
                Haptics.success()
                code = ""
            } catch {
                self.error = error.localizedDescription
                Haptics.warn()
            }
            busy = false
        }
    }
}

/// All apps: the same tiles as the TV, in the same order. Tiles spring in; the picked one launches.
struct AppsGrid: View {
    @EnvironmentObject var link: TVLink
    let selected: String?
    @State private var shown = false
    @State private var picked: String?

    private var list: [Service] { Services.inSpace(link.space) }
    private var cols: [GridItem] { Array(repeating: GridItem(.flexible(), spacing: 12), count: list.count > 8 ? 5 : 4) }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 32, style: .continuous).fill(.white)
            VStack(spacing: 22) {
                Text("ALL APPS").font(.system(size: 12, weight: .medium)).tracking(1.7).foregroundStyle(Color.mute)
                    .opacity(picked == nil ? 1 : 0)
                LazyVGrid(columns: cols, spacing: 18) {
                    ForEach(Array(list.enumerated()), id: \.element.k) { i, s in
                        tile(s)
                            .opacity(shown && (picked == nil || picked == s.k) ? 1 : 0)
                            .scaleEffect(picked == s.k ? 1.5 : (shown ? 1 : 0.55))
                            .offset(y: shown ? 0 : 14)
                            .animation(.spring(response: 0.5, dampingFraction: 0.62).delay(picked == nil ? Double(i) * 0.035 : 0), value: shown)
                            .animation(.spring(response: 0.45, dampingFraction: 0.7), value: picked)
                            .zIndex(picked == s.k ? 1 : 0)
                    }
                }
                .frame(maxWidth: 330)
                Text(list.first?.placeholder == true ? "Nothing here yet" : "Tap an app to open it").font(.system(size: 13)).foregroundStyle(Color.mute)
                    .opacity(picked == nil ? 1 : 0)
            }
            .padding(.horizontal, 16)
        }
        .onAppear { shown = true }
    }

    private func tile(_ s: Service) -> some View {
        let on = s.k == selected
        return Button {
            guard picked == nil, !s.placeholder else { return }
            picked = s.k
            Haptics.press()
            link.send(["t": "apps.pick", "k": s.k])
        } label: {
            VStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(LinearGradient(colors: s.bg, startPoint: .topLeading, endPoint: .bottomTrailing))
                    .aspectRatio(1, contentMode: .fit)
                    .overlay(GeometryReader { g in
                        ServiceMark(service: s, color: s.tileMarkColor, size: g.size.width * 0.52, onTile: true)
                            .frame(width: g.size.width, height: g.size.height)
                    })
                    .rest()
                    .overlay(
                        RoundedRectangle(cornerRadius: 21, style: .continuous)
                            .stroke(Color.ink, lineWidth: on ? 2 : 0)
                            .padding(-4)
                    )
                    .offset(y: on ? -3 : 0)
                    .scaleEffect(on ? 1.07 : 1)
                    .animation(.tv, value: on)
                Text(s.name)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(on ? Color.ink : Color.mute)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(s.name)
    }
}

/// The TV's look: Light, Dark, Nature, Tech, Rain, Jungle, Aurora. The TV (and box) remember the choice.
struct ThemeRow: View {
    @EnvironmentObject var link: TVLink
    var compact = false

    struct Choice: Identifiable {
        let k: String
        let name: String
        let swatch: [Color]
        var id: String { k }
    }
    static let themes: [Choice] = [
        Choice(k: "light", name: "Light", swatch: [Color(hex: 0xFBFAF7), Color(hex: 0xE9E5DC)]),
        Choice(k: "dark", name: "Dark", swatch: [Color(hex: 0x2A2927), Color(hex: 0x121211)]),
        Choice(k: "nature", name: "Nature", swatch: [Color(hex: 0x9CC3D9), Color(hex: 0xE7C9A0), Color(hex: 0x4E7A5A), Color(hex: 0x22402F)]),
        Choice(k: "tech", name: "Tech", swatch: [Color(hex: 0x3B7BFF), Color(hex: 0x0D1424), Color(hex: 0x06080D)]),
        Choice(k: "rain", name: "Rain", swatch: [Color(hex: 0x3A4C5E), Color(hex: 0x18222C), Color(hex: 0x0A0F15)]),
        Choice(k: "jungle", name: "Jungle", swatch: [Color(hex: 0xBFE8A8), Color(hex: 0x2F7A4A), Color(hex: 0x12301F), Color(hex: 0x06110A)]),
        Choice(k: "aurora", name: "Aurora", swatch: [Color(hex: 0x7A5AE0), Color(hex: 0x2BD9A8), Color(hex: 0x0B1C24), Color(hex: 0x050B12)]),
    ]

    /// Seven themes don't fit on one line of a phone, so they sit on two.
    private static let rows: [[Choice]] = [Array(themes.prefix(4)), Array(themes.dropFirst(4))]

    var body: some View {
        VStack(alignment: compact ? .center : .leading, spacing: compact ? 6 : 8) {
            ForEach(Self.rows.indices, id: \.self) { r in
                HStack(spacing: compact ? 6 : 8) {
                    ForEach(Self.rows[r]) { t in chip(t) }
                }
            }
        }
        .animation(.tv, value: link.theme)
    }

    @ViewBuilder
    private func chip(_ t: Choice) -> some View {
        let on = link.theme == t.k
        Button {
            link.setTheme(t.k)
            Haptics.tap()
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(LinearGradient(colors: t.swatch, startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay(Circle().stroke(Color.black.opacity(0.1), lineWidth: 1))
                    .frame(width: compact ? 16 : 20, height: compact ? 16 : 20)
                Text(t.name)
                    .font(.system(size: compact ? 12.5 : 13, weight: .medium))
                    .lineLimit(1)
                    .fixedSize()
            }
            .foregroundStyle(on ? Color.white : Color.ink2)
            .padding(.leading, 5).padding(.trailing, compact ? 10 : 12).padding(.vertical, 5)
            .background(Capsule().fill(on ? Color.ink : Color.room))
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel("\(t.name) theme")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// The three spaces as big cards, full screen. Picking one switches the TV and the Apps grid.
struct SpacesPicker: View {
    @EnvironmentObject var link: TVLink
    @Binding var open: Bool
    @State private var shown = false

    var body: some View {
        ZStack {
            Color.room.ignoresSafeArea()
            VStack(spacing: 14) {
                HStack {
                    Text("Spaces").font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.ink)
                    Spacer()
                    Button("Done") { open = false }
                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.ink)
                }
                .padding(.bottom, 6)
                ForEach(Array(Services.spaces.enumerated()), id: \.element.k) { i, sp in
                    card(sp)
                        .opacity(shown ? 1 : 0)
                        .offset(y: shown ? 0 : 18)
                        .animation(.spring(response: 0.5, dampingFraction: 0.75).delay(0.06 + Double(i) * 0.05), value: shown)
                }
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
        }
        .onAppear { shown = true }
    }

    private func card(_ sp: Services.Space) -> some View {
        let apps = Services.inSpace(sp.k)
        let count = apps.filter { !$0.placeholder }.count
        let on = link.space == sp.k
        return Button {
            if !on { link.setSpace(sp.k); Haptics.press() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { open = false }
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(sp.name).font(.system(size: 22, weight: .semibold)).tracking(-0.6).foregroundStyle(Color.ink)
                    Spacer()
                    Text(count > 0 ? "\(count) apps" : "Empty").font(.system(size: 13, weight: .medium)).foregroundStyle(Color.mute)
                }
                Text(sp.sub).font(.system(size: 14)).foregroundStyle(Color.ink2)
                HStack(spacing: 6) {
                    ForEach(apps.prefix(7)) { s in
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(LinearGradient(colors: s.bg, startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 30, height: 30)
                            .overlay(ServiceMark(service: s, color: s.tileMarkColor, size: 16, onTile: true))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Color.black.opacity(0.06), lineWidth: 1))
                    }
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.white))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Color.ink, lineWidth: on ? 2 : 0))
            .rest()
        }
        .buttonStyle(PressStyle(scale: 0.98))
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
