import Foundation
import Network
import UIKit

// The one channel between this phone and the TV box. Same protocol as shared/link.js:
//   ws(s)://tv.local/ws?tv=…&role=remote&k=…   JSON text messages both ways.
// Heartbeat every 10 s (the box answers "ping" with "pong"); 25 s of silence means the
// connection died quietly, so start over with backoff (0.4 s doubling to 8 s).

enum LinkStatus: Equatable {
    case connecting, open, reconnecting, needPair
}

struct ResultItem: Equatable {
    var service: String
    var title: String
    var on: Bool
}

/// What the TV says is on screen (sent by the TV page, or by the box inside a service).
struct TVState: Equatable {
    var mode = "home"            // home, apps, results, countdown, voice, service, pair
    var k: String?               // the service on screen (mode service)
    var focusK: String?
    var focusName: String?
    var results: [ResultItem] = []
    var countdownSay: String?
    var music = false
    var url = ""
    var title = ""
    var countdownID = 0
}

/// A text box on the TV has focus (or the phone opened the keyboard itself).
struct KbdRequest: Equatable {
    var type = "text"
    var label = ""
    var value = ""
    var manual = false
    var id = UUID()
}

/// "Claude is on it" progress from the hands-free voice agent.
struct AgentStatus: Equatable {
    var phase: String           // start, step, done, fail, stopped
    var text: String
    var id = UUID()
    var ended: Bool { phase == "done" || phase == "fail" || phase == "stopped" }
}

/// The TV set itself (not the box): found on the network, power, HDMI input.
struct TVPower: Equatable {
    var found = false
    var name: String? = nil
    var on: Bool? = nil
    var hdmi: Int? = nil
    var busy = false
    var hint: String? = nil
}

/// A DS game running on the TV: the app turns into the game controller (DSPad.swift).
struct GameInfo: Equatable {
    let g: String
    let title: String
}

final class TVLink: ObservableObject {
    @Published private(set) var status: LinkStatus = .connecting
    /// The TV's power and input, from tv.status.
    @Published var tvPower = TVPower()
    @Published private(set) var state = TVState()
    @Published var kbd: KbdRequest?
    @Published var agent: AgentStatus? {
        didSet { armAgentWatchdog() }
    }
    /// The TV's theme (light, dark, nature, tech) and whether the TV makes UI sounds. The box remembers both.
    @Published private(set) var theme = "light"
    @Published private(set) var sounds = true
    /// The current space: living, school or games.
    @Published private(set) var space = "living"
    /// A space the phone has switched to while the TV is still bringing it up (the pad shows a curtain).
    @Published private(set) var spaceLoading: String?
    private var heldState: [String: Any]?
    private var spaceArrived = false
    private var spaceTimer: DispatchWorkItem?
    @Published private(set) var game: GameInfo?
    @Published private(set) var toast: String?
    @Published private(set) var pairing: Pairing?
    @Published private(set) var address: BoxAddress?
    /// Unpaired and the box can't be found on this Wi-Fi.
    @Published private(set) var boxMissing = false
    @Published var manualHost: String = UserDefaults.standard.string(forKey: "manualHost") ?? "" {
        didSet { UserDefaults.standard.set(manualHost, forKey: "manualHost") }
    }

    private var ws: URLSessionWebSocketTask?
    private var isOpen = false
    private var connecting = false
    private var locating = false
    private var stopped = false
    private var tries = 0
    private var queue: [[String: Any]] = []
    private var lastRx = Date()
    private var pingTimer: Timer?
    private var openTimer: Timer?
    private var retryTimer: Timer?
    private var wakeTimer: Timer?
    private var toastTimer: Timer?
    private var countdowns = 0
    private var agentDog: Timer?
    private let finder = BoxFinder()
    private let monitor = NWPathMonitor()

    var phoneName: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }

    init() {
        pairing = PairingStore.load()
        let s = BoxSession.shared
        s.onOpen = { [weak self] t in self?.opened(t) }
        s.onClose = { [weak self] t, code in self?.closed(t, code: code) }
        s.onFail = { [weak self] t, _ in self?.lost(t as? URLSessionWebSocketTask) }
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            DispatchQueue.main.async { self?.wake() }
        }
    }

    func start() {
        finder.start()
        monitor.start(queue: .main)
        if pairing != nil { connect() } else { status = .needPair; findBoxForPairing() }
    }

    // MARK: Connection

    private func connect() {
        guard pairing != nil, !stopped, ws == nil, !connecting else { return }
        retryTimer?.invalidate()
        connecting = true
        if status != .open { status = tries > 0 ? .reconnecting : .connecting }
        Task { @MainActor in
            // Find the box: the saved address first, then tv.local and Bonjour.
            // After a few failures, look again in case it moved to a new address.
            if self.address == nil || self.tries % 3 == 2 {
                let preferred = self.pairing?.host
                if let a = await self.finder.locate(preferred: preferred) { self.address = a; self.remember(a) }
            }
            self.connecting = false
            guard let a = self.address, let p = self.pairing, !self.stopped, self.ws == nil else { return self.retry() }
            var c = URLComponents(url: a.ws, resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "tv", value: p.tv),
                            URLQueryItem(name: "role", value: "remote"),
                            URLQueryItem(name: "k", value: p.key)]
            var req = URLRequest(url: c.url!)
            req.timeoutInterval = 6
            let t = BoxSession.shared.session.webSocketTask(with: req)
            t.maximumMessageSize = 1 << 20
            self.ws = t
            self.isOpen = false
            t.resume()
            self.receive(t)
            // Phones can sit on a dead "connecting" socket for a long time: give up after 6 seconds.
            self.openTimer?.invalidate()
            self.openTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
                guard let self, self.ws === t, !self.isOpen else { return }
                self.lost(t)
            }
        }
    }

    private func opened(_ t: URLSessionWebSocketTask) {
        guard ws === t else { return }
        openTimer?.invalidate()
        isOpen = true
        tries = 0
        lastRx = Date()
        status = .open
        boxMissing = false
        let q = queue
        queue = []
        q.forEach { send($0) }
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            guard let self, self.ws === t, self.isOpen else { return }
            if Date().timeIntervalSince(self.lastRx) > 25 { return self.lost(t) }
            self.send(["t": "ping"])
        }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.ws === t else { return }
                switch result {
                case .success(let m):
                    self.lastRx = Date()
                    switch m {
                    case .string(let s): self.handle(s)
                    case .data(let d): self.handle(String(decoding: d, as: UTF8.self))
                    @unknown default: break
                    }
                    self.receive(t)
                case .failure:
                    self.lost(t)
                }
            }
        }
    }

    private func closed(_ t: URLSessionWebSocketTask, code: Int) {
        guard ws === t else { return }
        if code == 4001 { ws = nil; return forget() }   // the box removed this phone
        lost(t)
    }

    /// The connection is gone (closed, timed out or silent): retry with backoff.
    private func lost(_ t: URLSessionWebSocketTask?) {
        guard let t, ws === t else { return }
        let http = (t.response as? HTTPURLResponse)?.statusCode
        ws = nil
        isOpen = false
        t.cancel(with: .goingAway, reason: nil)
        pingTimer?.invalidate()
        openTimer?.invalidate()
        if stopped || pairing == nil { return }
        status = .reconnecting
        // A phone whose key was removed is turned away at connect (403), and a reinstalled box has a new id (404).
        if http == 403 || http == 404 || tries == 2 { checkPaired() }
        retry()
    }

    private func retry() {
        guard !stopped, pairing != nil, ws == nil else { return }
        let wait = min(8.0, 0.4 * pow(2, Double(tries)))
        tries += 1
        if status == .open || status == .connecting { status = .reconnecting }
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: wait + Double.random(in: 0...0.3), repeats: false) { [weak self] _ in
            self?.connect()
        }
    }

    /// Back from the lock screen or another app (or the Wi-Fi came back): check the connection now.
    func wake() {
        guard pairing != nil else {
            if status == .needPair && address == nil { findBoxForPairing() }
            return
        }
        guard !stopped else { return }
        guard let t = ws else { tries = 0; retryTimer?.invalidate(); return connect() }
        guard isOpen else { return }
        let sent = Date()
        send(["t": "ping"])
        wakeTimer?.invalidate()
        wakeTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
            guard let self, self.ws === t, self.lastRx < sent else { return }
            self.tries = 0
            self.lost(t)
        }
    }

    private func checkPaired() {
        guard let p = pairing, let a = address else { return }
        Task { @MainActor in
            if let j = try? await BoxAPI.post(a, "api/remote/check", ["tv": p.tv, "key": p.key]),
               j["paired"] as? Bool == false, self.pairing == p {
                self.forget()
            }
        }
    }

    private func remember(_ a: BoxAddress) {
        guard var p = pairing, p.host != a.host else { return }
        p.host = a.host
        pairing = p
        PairingStore.save(p)
    }

    // MARK: Messages

    func send(_ msg: [String: Any]) {
        guard let t = ws, isOpen else {
            let type = msg["t"] as? String ?? ""
            if queue.count < 20, !["swipe", "pad", "scroll", "ping"].contains(type) { queue.append(msg) }
            return
        }
        guard let d = try? JSONSerialization.data(withJSONObject: msg), let s = String(data: d, encoding: .utf8) else { return }
        t.send(.string(s)) { _ in }
    }

    private func handle(_ raw: String) {
        guard let d = raw.data(using: .utf8),
              let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let type = m["t"] as? String else { return }
        if type != "tv.status", let tv = (m["tvStatus"] ?? m["tv"]) as? [String: Any] { applyTVStatus(tv) }
        switch type {
        case "pong", "welcome", "presence":
            break
        case "tv.status":
            applyTVStatus(m)
        case "unpaired":
            forget()
        case "state":
            // While the TV is still reloading into a new space, its updates describe the old one:
            // hold the newest until the TV reports the new space, so the phone never flips back.
            if spaceLoading != nil {
                heldState = m
                if ((m["tvSpace"] ?? m["space"]) as? String) == space { tvReachedSpace() }
                return
            }
            applyState(m)
        case "toast":
            if let text = m["text"] as? String { showToast(text) }
        case "intent":
            let kind = m["kind"] as? String
            let say = (m["say"] as? String) ?? (m["heard"] as? String) ?? ""
            if kind == "do" { agent = AgentStatus(phase: "start", text: say) }
            else if kind == "none", !say.isEmpty { showToast(say) }
        case "agent":
            agent = AgentStatus(phase: m["phase"] as? String ?? "step", text: m["text"] as? String ?? "")
        case "space":
            // Switched on the TV or by voice: show the same curtain while the TV switches.
            if let n = m["name"] as? String, n != space, Services.spaces.contains(where: { $0.k == n }) {
                space = n
                startSpaceLoading(n)
            }
        case "sounds":
            sounds = m["on"] as? Bool ?? true
        case "theme":
            if let n = m["name"] as? String { theme = n }
        case "kbd.show":
            kbd = KbdRequest(type: m["type"] as? String ?? "text", label: m["label"] as? String ?? "",
                             value: m["value"] as? String ?? "", manual: false)
        case "kbd.hide":
            if kbd?.manual != true { kbd = nil }
        case "game":
            let running = m["running"] as? Bool ?? false
            game = running ? GameInfo(g: m["g"] as? String ?? "", title: m["title"] as? String ?? "Game") : nil
        case "paired":
            if let name = m["name"] as? String, m["self"] == nil { showToast("\(name) paired with the TV") }
        default:
            break
        }
    }

    private func applyTVStatus(_ m: [String: Any]) {
        var p = TVPower()
        p.found = m["found"] as? Bool ?? false
        p.name = (m["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        p.on = m["on"] as? Bool          // NSNull → nil (unknown)
        p.hdmi = (m["hdmi"] as? NSNumber)?.intValue
        p.busy = m["busy"] as? Bool ?? false
        p.hint = (m["hint"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if p != tvPower { tvPower = p }
    }

    // MARK: TV power and input

    /// Turn the TV on or off. When the state is unknown, the box toggles.
    func togglePower() {
        var msg: [String: Any] = ["t": "tv.power"]
        if let on = tvPower.on { msg["on"] = !on }
        tvPower.busy = true
        send(msg)
    }

    func setHDMI(_ n: Int) {
        guard (1...4).contains(n) else { return }
        tvPower.hdmi = n
        tvPower.busy = true
        send(["t": "tv.setup", "hdmi": n])
    }

    /// The TV's IP address. An empty string means find it again.
    func setTVIP(_ ip: String) {
        tvPower.busy = true
        send(["t": "tv.setup", "ip": ip.trimmingCharacters(in: .whitespaces)])
    }

    private func applyState(_ m: [String: Any]) {
        var s = TVState()
        s.mode = m["mode"] as? String ?? "home"
        s.k = m["k"] as? String
        if let f = m["focus"] as? [String: Any] {
            s.focusK = f["k"] as? String
            s.focusName = f["name"] as? String
        }
        if let rs = m["results"] as? [[String: Any]] {
            s.results = rs.map { ResultItem(service: $0["service"] as? String ?? "", title: $0["title"] as? String ?? "", on: $0["on"] as? Bool ?? false) }
        }
        if let c = m["countdown"] as? [String: Any] { s.countdownSay = c["say"] as? String }
        if s.mode == "countdown" && state.mode != "countdown" { countdowns += 1 }
        s.countdownID = countdowns
        s.music = m["music"] as? Bool ?? false
        s.url = m["url"] as? String ?? ""
        s.title = m["title"] as? String ?? ""
        if let t = m["theme"] as? String, t != theme { theme = t }
        if let sp = m["space"] as? String, sp != space, Services.spaces.contains(where: { $0.k == sp }) { space = sp }
        if s != state { state = s }
    }

    // MARK: Hands-free agent, theme, sounds

    /// Claude is working on a voice request right now.
    var agentRunning: Bool { agent.map { !$0.ended } ?? false }

    /// Stop the hands-free agent (the mic's Stop square, or any tap or swipe on the pad).
    func stopAgent() {
        guard agentRunning else { return }
        send(["t": "cancel"])
        agent = AgentStatus(phase: "stopped", text: "Stopped")
    }

    /// A run that goes quiet for a minute is treated as over.
    private func armAgentWatchdog() {
        agentDog?.invalidate()
        guard agentRunning else { return }
        let id = agent?.id
        agentDog = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            guard let self, self.agent?.id == id else { return }
            self.agent = nil
        }
    }

    func setTheme(_ name: String) {
        theme = name
        send(["t": "theme", "name": name])
    }

    func setSpace(_ name: String) {
        guard name != space else { return }
        space = name
        startSpaceLoading(name)
        send(["t": "space", "name": name])
    }

    /// The phone switches right away and shows the TV's curtain, then lifts it together with the TV's.
    private func startSpaceLoading(_ name: String) {
        spaceLoading = name
        spaceArrived = false
        scheduleSpaceDone(after: 5)   // the TV is off or slow: don't keep the phone waiting
    }

    private func tvReachedSpace() {
        guard !spaceArrived else { return }
        spaceArrived = true
        scheduleSpaceDone(after: 0.55)   // the TV's curtain lifts a moment after it reports in
    }

    private func scheduleSpaceDone(after seconds: Double) {
        spaceTimer?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.finishSpaceLoading() }
        spaceTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func finishSpaceLoading() {
        spaceTimer?.cancel(); spaceTimer = nil
        spaceLoading = nil
        if let m = heldState { heldState = nil; applyState(m) }
    }

    func setSounds(_ on: Bool) {
        sounds = on
        send(["t": "sounds", "on": on])
    }

    func showToast(_ text: String) {
        toast = text
        toastTimer?.invalidate()
        toastTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in self?.toast = nil }
    }

    // MARK: Pairing

    /// Unpaired: find the box and ask the TV to show a code to type.
    func findBoxForPairing() {
        guard !locating else { return }
        locating = true
        Task { @MainActor in
            let a = await self.finder.locate(preferred: self.manualHost.isEmpty ? self.address?.host : self.manualHost)
            self.locating = false
            guard self.pairing == nil else { return }
            if let a {
                self.address = a
                self.boxMissing = false
                _ = try? await BoxAPI.post(a, "api/pair/show", [:], timeout: 4)
            } else {
                self.boxMissing = true
            }
        }
    }

    /// Pair with the 6-character code on the TV. Returns the name the TV gave this phone.
    @MainActor
    func pair(code: String) async throws -> String {
        let a = try await boxForPairing()
        let j = try await BoxAPI.post(a, "api/pair/lookup", ["code": code])
        guard let tv = j["tv"] as? String, let token = j["token"] as? String else {
            throw BoxError(message: "That code didn’t work. Check the TV and try again.")
        }
        return try await claim(a, tv: tv, token: token)
    }

    /// Pair from the TV's QR code: http://tv.local/remote/#pair=<tv>.<token>
    @MainActor
    func pair(qr: String) async throws -> String {
        guard let url = URL(string: qr), let frag = url.fragment,
              let r = frag.range(of: #"pair=([0-9a-f]+)\.([0-9a-f]+)"#, options: .regularExpression) else {
            throw BoxError(message: "That isn’t the TV’s pairing code.")
        }
        let parts = frag[r].dropFirst("pair=".count).split(separator: ".")
        var a = address
        if let host = url.host, LocalHost.isLocal(host), let found = await BoxAPI.probe(host) { a = found }
        if a == nil { a = try await boxForPairing() }
        return try await claim(a!, tv: String(parts[0]), token: String(parts[1]))
    }

    @MainActor
    private func boxForPairing() async throws -> BoxAddress {
        if let a = address { return a }
        if let a = await finder.locate(preferred: manualHost.isEmpty ? nil : manualHost) { address = a; boxMissing = false; return a }
        boxMissing = true
        throw BoxError(message: "Couldn’t find the TV box. Make sure your phone is on the same Wi-Fi as the TV.")
    }

    @MainActor
    private func claim(_ a: BoxAddress, tv: String, token: String) async throws -> String {
        let j = try await BoxAPI.post(a, "api/pair/claim", ["tv": tv, "token": token, "name": phoneName])
        guard let tv = j["tv"] as? String, let key = j["key"] as? String else {
            throw BoxError(message: "Something went wrong. Try again.")
        }
        let name = j["name"] as? String ?? phoneName
        let p = Pairing(tv: tv, key: key, name: name, host: a.host)
        PairingStore.save(p)
        if let old = ws { ws = nil; old.cancel(with: .normalClosure, reason: nil) }
        pairing = p
        address = a
        stopped = false
        tries = 0
        status = .connecting
        connect()
        return name
    }

    /// Ask the TV to show a new code, for another phone.
    func pairAnother() {
        send(["t": "pair.request"])
        showToast("The TV is showing a new code")
    }

    /// Forget this TV (the box removes this phone too).
    func unpair() {
        if isOpen { send(["t": "unpair"]) }
        let p = pairing
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            if let self, self.pairing == p { self.forget() }
        }
    }

    func forget() {
        PairingStore.clear()
        pairing = nil
        if let t = ws { ws = nil; t.cancel(with: .normalClosure, reason: nil) }
        isOpen = false
        connecting = false
        [pingTimer, openTimer, retryTimer, wakeTimer].forEach { $0?.invalidate() }
        queue = []
        state = TVState()
        kbd = nil
        agent = nil
        status = .needPair
        findBoxForPairing()
    }

    /// Try a different address for the box (typed in by hand).
    func useHost(_ host: String) {
        manualHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        address = nil
        if pairing == nil { findBoxForPairing() } else {
            if var p = pairing, !manualHost.isEmpty { p.host = manualHost; pairing = p; PairingStore.save(p) }
            if let t = ws { ws = nil; t.cancel(with: .goingAway, reason: nil) }
            isOpen = false
            tries = 0
            connect()
        }
    }

    // MARK: Hands-free voice key (kept on the box)

    /// Read or change the Claude API key on the box. Only over the box's secure address.
    @MainActor
    func claudeKey(_ body: [String: Any]) async throws -> [String: Any] {
        guard let p = pairing else { throw BoxError(message: "Pair this phone with the TV first.") }
        var a = address
        if a?.secure != true, let host = a?.host {
            a = BoxAddress(host: host, secure: true)
            if await BoxAPI.probe(host)?.secure != true { a = nil }
        }
        guard let addr = a else {
            throw BoxError(message: "The TV box’s secure connection isn’t on, so the key can’t be sent safely.")
        }
        var b = body
        b["tv"] = p.tv
        b["key"] = p.key
        return try await BoxAPI.post(addr, "api/settings/claude", b, timeout: 15)
    }
}
