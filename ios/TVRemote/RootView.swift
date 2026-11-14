import SwiftUI

/// One screen, like the web remote: a top bar, the big pad, then Back · hold-to-talk · Home.
struct RootView: View {
    @EnvironmentObject var link: TVLink
    @EnvironmentObject var listener: Listener
    @EnvironmentObject var volume: VolumeButtons
    @Environment(\.scenePhase) private var phase

    @State private var talking = false
    @State private var showMore = false
    @State private var showKey = false
    @State private var showScan = false
    @State private var showSpaces = false
    @State private var showPower = false

    private var st: TVState { link.state }
    private var inService: Bool { st.mode == "service" && link.status != .needPair }
    private var web: Bool { inService && st.k == "chrome" }

    var body: some View {
        ZStack(alignment: .top) {
            Color.room.ignoresSafeArea()
            VStack(spacing: 18) {
                TopBar(showMore: $showMore, showSpaces: $showSpaces, showPower: $showPower)
                if web {
                    BrowserBar(url: st.url)
                        .transition(.move(edge: .top).combined(with: .opacity))
                } else if inService {
                    MediaStrip(music: st.music)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                PadArea(talking: talking, showKey: $showKey, showScan: $showScan)
                BottomRow(talking: talking, agentRunning: link.agentRunning,
                          startTalk: { startTalk(handsFree: false) }, stopTalk: { listener.stop() },
                          stopAgent: { link.stopAgent(); Haptics.press() })
                Text(tip)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.mute)
                    .frame(minHeight: 16)
                    .animation(.easeInOut(duration: 0.2), value: tip)
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 12)
            .animation(.tv, value: inService)
            .animation(.tv, value: web)

            if let k = link.kbd {
                KeyboardPanel(request: k)
                    .padding(.horizontal, 12)
                    .padding(.top, 6)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .zIndex(5)
            }
            if showSpaces {
                SpacesPicker(open: $showSpaces)
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
                    .zIndex(6)
            }
            if link.game != nil {
                DSPadScreen()
                    .transition(.opacity)
                    .zIndex(20)
            }
            HiddenVolumeView(buttons: volume).frame(width: 1, height: 1).allowsHitTesting(false)
        }
        .animation(.tv, value: link.kbd)
        .animation(.tv, value: showSpaces)
        .animation(.tv, value: link.game)
        .sheet(isPresented: $showMore) { MoreSheet(showKey: $showKey, showPower: $showPower) }
        .sheet(isPresented: $showPower) { TVPowerSheet() }
        .sheet(isPresented: $showKey) { KeySheet() }
        .sheet(isPresented: $showScan) { ScanSheet() }
        .sheet(item: $link.quickDraft) { QuickAddSheet(draft: $0) }
        .alert(problemTitle, isPresented: Binding(get: { listener.problem != nil }, set: { if !$0 { listener.problem = nil } })) {
            if listener.problem != .unavailable {
                Button("Open Settings") { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(problemText)
        }
        .onChange(of: phase) { _, p in if p == .active { checkTalkRequest() } }
        .onChange(of: link.status) { _, s in if s == .open { checkTalkRequest() } }
        .onReceive(NotificationCenter.default.publisher(for: .talkRequested)) { _ in checkTalkRequest() }
        .onChange(of: st.focusK) { old, new in if old != nil && new != old { Haptics.tick() } }
        .onChange(of: link.status) { old, new in if new == .open && old != .open { Haptics.land() } }
        .onChange(of: link.agent) { old, new in agentChanged(old, new) }
    }

    // MARK: Voice

    private func startTalk(handsFree: Bool) {
        guard !talking else { return }
        guard link.status == .open else { link.showToast("Not connected to the TV yet"); Haptics.warn(); return }
        talking = true
        volume.pause()
        Haptics.press()
        link.send(["t": "voice", "phase": "start"])
        listener.start(handsFree: handsFree, partial: { text in
            link.send(["t": "voice", "phase": "partial", "text": text])
        }, finish: { text in
            talking = false
            volume.resume()
            if text.isEmpty {
                link.send(["t": "voice", "phase": "cancel"])
            } else {
                link.send(["t": "voice", "phase": "final", "text": text])
                Haptics.tap()
            }
        })
    }

    /// "Talk to TV" from Control Center, the Lock Screen, Siri or the Action button opens the app
    /// and listens right away, stopping by itself after a pause.
    private func checkTalkRequest() {
        let d = AppGroup.defaults
        let at = d.double(forKey: TalkRequest.key)
        guard at > 0, Date().timeIntervalSince1970 - at < 20 else { return }
        guard link.status == .open else { return }   // tried again when the link opens
        d.removeObject(forKey: TalkRequest.key)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { startTalk(handsFree: true) }
    }

    /// No bar over the pad: while Claude works the mic is a Stop square and the line under it shows
    /// the current step. When it ends, the result shows there briefly.
    private func agentChanged(_ old: AgentStatus?, _ new: AgentStatus?) {
        guard let a = new else { return }
        if a.phase == "start" && old.map({ !$0.ended }) != true { Haptics.tap() }
        guard a.ended, old.map({ !$0.ended }) ?? false else { return }
        if a.phase == "done" { Haptics.success() } else if a.phase == "fail" { Haptics.warn() }
        let text = a.text.trimmingCharacters(in: .whitespaces)
        link.showToast(text.isEmpty ? (a.phase == "fail" ? "Couldn’t finish that" : a.phase == "stopped" ? "Stopped" : "Done") : text)
    }

    // MARK: Text

    private var tip: String {
        if let t = link.toast { return t }
        if talking { return "Let go when you’re done" }
        if link.agentRunning, let a = link.agent { return a.text.isEmpty ? "On it…" : a.text }
        if link.status == .needPair { return "" }
        switch st.mode {
        case "service": return "Hold to speak · “Pause” or “Turn it down”"
        case "countdown", "voice": return ""
        default: return "Hold to speak · “Open Spotify”"
        }
    }

    private var problemTitle: String {
        switch listener.problem {
        case .micDenied: return "Microphone is off"
        case .speechDenied: return "Speech recognition is off"
        default: return "Voice isn’t available"
        }
    }
    private var problemText: String {
        switch listener.problem {
        case .micDenied: return "To talk to the TV, turn on Microphone for TV Remote in Settings."
        case .speechDenied: return "To talk to the TV, turn on Speech Recognition for TV Remote in Settings."
        default: return "Speech recognition isn’t available right now. Check your internet connection and try again."
        }
    }
}

// MARK: - Top bar

struct TopBar: View {
    @EnvironmentObject var link: TVLink
    @Binding var showMore: Bool
    @Binding var showSpaces: Bool
    @Binding var showPower: Bool

    var body: some View {
        HStack(spacing: 8) {
            Button {
                showSpaces = true
                Haptics.tap()
            } label: {
                HStack(spacing: 4) {
                    Text(Services.space(link.space).name)
                        .font(.system(size: 17, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color.mute)
                }
                .foregroundStyle(Color.ink)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressStyle(scale: 0.97))
            .accessibilityLabel("Space: \(Services.space(link.space).name)")
            .accessibilityHint("Choose Living room, School or Games")
            Spacer(minLength: 4)
            Chip(on: link.state.mode == "apps") {
                link.send(["t": "apps"]); Haptics.tap()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "square.grid.2x2.fill").font(.system(size: 11))
                    Text("Apps").font(.system(size: 13, weight: .medium))
                }
                .fixedSize()
            }
            .layoutPriority(2)
            .accessibilityLabel("All apps")
            StatusDot(status: link.status)
            Chip {
                link.kbd = KbdRequest(type: "text", manual: true); Haptics.tap()
            } label: {
                Image(systemName: "keyboard").font(.system(size: 13, weight: .medium))
            }
            .accessibilityLabel("Keyboard")
            Chip { showMore = true } label: {
                Text("•••").tracking(1.3)
            }
            .accessibilityLabel("More controls")
        }
        .frame(height: 32)
    }
}

/// The TV's power. Lights up green while the TV is on. Tap toggles, hold opens power and input.
struct PowerButton: View {
    let power: TVPower
    let toggle: () -> Void
    let openSheet: () -> Void
    @State private var pressed = false
    @State private var held: DispatchWorkItem?
    @State private var fired = false
    @State private var pulse = false

    private var lit: Bool { power.on == true }

    var body: some View {
        Image(systemName: "power")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(lit ? Color.white : power.found ? Color.ink : Color.mute)
            .frame(width: 32, height: 32)
            .background(Circle().fill(lit ? Color.ok : Color.white))
            .rest()
            .shadow(color: Color.ok.opacity(lit ? 0.55 : 0), radius: 8)
            .opacity(power.busy ? (pulse ? 0.45 : 1) : 1)
            .scaleEffect(pressed ? 0.94 : 1)
            .animation(.easeOut(duration: 0.12), value: pressed)
            .animation(.easeInOut(duration: 0.3), value: lit)
            .onChange(of: power.busy, initial: true) { _, busy in
                if busy {
                    withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { pulse = true }
                } else {
                    withAnimation(.easeOut(duration: 0.2)) { pulse = false }
                }
            }
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !pressed else { return }
                        pressed = true
                        fired = false
                        let w = DispatchWorkItem {
                            fired = true
                            Haptics.press()
                            openSheet()
                        }
                        held = w
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: w)
                    }
                    .onEnded { _ in
                        pressed = false
                        held?.cancel()
                        if !fired { Haptics.tap(); toggle() }
                    }
            )
            .accessibilityElement()
            .accessibilityLabel("TV power")
            .accessibilityValue(power.on == true ? "On" : power.on == false ? "Off" : "Unknown")
            .accessibilityHint("Hold for input and TV settings")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { toggle() }
            .accessibilityAction(named: "TV power and input") { openSheet() }
    }
}

struct StatusDot: View {
    let status: LinkStatus
    var body: some View {
        // Just a dot: green when connected. VoiceOver still reads the words.
        Circle()
            .fill(status == .open ? Color.ok : Color.mute)
            .frame(width: 8, height: 8)
            .padding(.horizontal, 4)
            .animation(.easeInOut(duration: 0.3), value: status)
            .accessibilityElement()
            .accessibilityLabel(text)
    }
    private var text: String {
        switch status {
        case .open: return "Connected"
        case .connecting: return "Connecting…"
        case .reconnecting: return "Reconnecting…"
        case .needPair: return "Not paired"
        }
    }
}

// MARK: - Media strip and browser bar (inside a service)

struct MediaStrip: View {
    @EnvironmentObject var link: TVLink
    let music: Bool
    var body: some View {
        HStack(spacing: 10) {
            btn("Play / Pause", "playpause")
            // Save what the TV is showing (a video, a playlist, any page) as a Quick Add.
            Button {
                Haptics.tap()
                link.quickDraft = link.savablePage ?? QuickDraft()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(Color.ink)
                    .frame(width: 56, height: 56)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.white))
                    .rest()
            }
            .buttonStyle(PressStyle(scale: 0.94))
            .accessibilityLabel("Quick Add")
            .accessibilityHint("Save what's on the TV as a tile under Apps")
        }
        .frame(height: 56)
    }
    private func btn(_ title: String, _ a: String, grow: CGFloat = 1) -> some View {
        Button {
            if a.hasPrefix("vol") { link.send(["t": "media", "a": "vol", "v": a == "volup" ? 10 : -10]) }
            else { link.send(["t": "media", "a": a]) }
            Haptics.tap()
        } label: {
            Text(title)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.white))
                .rest()
        }
        .buttonStyle(PressStyle(scale: 0.96))
        .layoutPriority(grow)
    }
}

struct BrowserBar: View {
    @EnvironmentObject var link: TVLink
    let url: String
    @State private var text = ""
    @FocusState private var focused: Bool

    private var pretty: String {
        url.replacingOccurrences(of: #"^https?://(www\.)?"#, with: "", options: .regularExpression)
           .replacingOccurrences(of: #"/$"#, with: "", options: .regularExpression)
    }

    var body: some View {
        HStack(spacing: 8) {
            round("chevron.left", "Back a page") { link.send(["t": "nav", "a": "back"]) }
            round("chevron.right", "Forward a page") { link.send(["t": "nav", "a": "forward"]) }
            TextField("Search or type a web address", text: $text)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.webSearch)
                .submitLabel(.go)
                .focused($focused)
                .padding(.horizontal, 16)
                .frame(height: 44)
                .background(Capsule().fill(.white))
                .overlay(Capsule().stroke(Color.ink, lineWidth: focused ? 2 : 0))
                .rest()
                .onSubmit {
                    let q = text.trimmingCharacters(in: .whitespaces)
                    if !q.isEmpty && q != url { link.send(["t": "nav", "a": "go", "q": q]) }
                    Haptics.tap()
                    focused = false
                }
            round("arrow.clockwise", "Reload") { link.send(["t": "nav", "a": "reload"]) }
        }
        .frame(height: 52)
        .onAppear { text = pretty }
        .onChange(of: url) { _, _ in if !focused { text = pretty } }
        .onChange(of: focused) { _, f in text = f ? url : pretty }
    }

    private func round(_ icon: String, _ label: String, _ action: @escaping () -> Void) -> some View {
        Button { action(); Haptics.tap() } label: {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.ink)
                .frame(width: 44, height: 44)
                .background(Circle().fill(.white))
                .rest()
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(label)
    }
}

// MARK: - Back · Mic · Home

struct BottomRow: View {
    @EnvironmentObject var link: TVLink
    let talking: Bool
    let agentRunning: Bool
    let startTalk: () -> Void
    let stopTalk: () -> Void
    let stopAgent: () -> Void

    var body: some View {
        HStack {
            BackButton()
            Spacer()
            MicButton(talking: talking, agentRunning: agentRunning, start: startTalk, stop: stopTalk, stopAgent: stopAgent)
            Spacer()
            RoundButton(icon: "house", label: "Home") { link.send(["t": "home"]); Haptics.tap() }
        }
        .padding(.horizontal, 6)
    }
}

struct RoundButton: View {
    let icon: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 21, weight: .medium))
                .foregroundStyle(Color.ink)
                .frame(width: 60, height: 60)
                .background(Circle().fill(.white))
                .rest()
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(label)
    }
}

/// Back. A long press goes Home (handy inside a service).
struct BackButton: View {
    @EnvironmentObject var link: TVLink
    @State private var pressed = false
    @State private var held: DispatchWorkItem?
    @State private var fired = false

    var body: some View {
        Image(systemName: "chevron.left")
            .font(.system(size: 21, weight: .semibold))
            .foregroundStyle(Color.ink)
            .frame(width: 60, height: 60)
            .background(Circle().fill(.white))
            .rest()
            .scaleEffect(pressed ? 0.94 : 1)
            .animation(.easeOut(duration: 0.12), value: pressed)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !pressed else { return }
                        pressed = true
                        fired = false
                        let w = DispatchWorkItem {
                            fired = true
                            link.send(["t": "home"])
                            Haptics.press()
                        }
                        held = w
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: w)
                    }
                    .onEnded { _ in
                        pressed = false
                        held?.cancel()
                        if !fired { link.send(["t": "back"]); Haptics.tap() }
                    }
            )
            .accessibilityElement()
            .accessibilityLabel("Back")
            .accessibilityHint("Hold to go Home")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { link.send(["t": "back"]) }
    }
}

/// Hold to talk: press and speak, let go to send.
/// While Claude is working on a request, it turns into a Stop square.
struct MicButton: View {
    let talking: Bool
    var agentRunning = false
    let start: () -> Void
    let stop: () -> Void
    var stopAgent: () -> Void = {}
    @State private var down = false
    @State private var pulse = false
    @State private var stoppedAgent = false

    var body: some View {
        ZStack {
            if talking {
                Circle()
                    .stroke(Color.ink, lineWidth: 2)
                    .frame(width: 112, height: 112)
                    .scaleEffect(pulse ? 1.25 : 0.9)
                    .opacity(pulse ? 0 : 0.5)
                    .onAppear {
                        pulse = false
                        withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { pulse = true }
                    }
            }
            Circle()
                .fill(Color.ink)
                .frame(width: 92, height: 92)
                .shadow(color: Color.ink.opacity(0.5), radius: 18, y: 18)
                .overlay {
                    if agentRunning {
                        RoundedRectangle(cornerRadius: 6, style: .continuous).fill(.white).frame(width: 26, height: 26)
                            .transition(.scale.combined(with: .opacity))
                    } else {
                        Image(systemName: "mic.fill").font(.system(size: 30)).foregroundStyle(.white)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .animation(.spring(response: 0.35, dampingFraction: 0.7), value: agentRunning)
                .scaleEffect(talking ? 1.12 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.6), value: talking)
        }
        .frame(width: 112, height: 112)
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !down else { return }
                    down = true
                    if agentRunning { stoppedAgent = true; stopAgent() } else { start() }
                }
                .onEnded { _ in
                    down = false
                    if stoppedAgent { stoppedAgent = false } else { stop() }
                }
        )
        .accessibilityElement()
        .accessibilityLabel(agentRunning ? "Stop Claude" : talking ? "Listening. Double-tap to send." : "Talk to the TV")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { agentRunning ? stopAgent() : talking ? stop() : start() }
    }
}
