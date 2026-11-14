import Foundation
import Compression
import UIKit

/// A DS game running on the TV box: the phone shows the bottom screen and sends buttons and
/// touches over /games/ws (the same protocol as the web pad page, app/games/pad.js).
final class DSLink: ObservableObject {
    struct Slot: Identifiable, Equatable {
        let slot: String          // "auto" or "1"..."6"
        let time: Date?
        let image: UIImage?
        var id: String { slot }
        var name: String { slot == "auto" ? "Auto" : "Slot \(slot)" }
    }

    @Published private(set) var connected = false
    @Published private(set) var slots: [Slot] = []
    @Published private(set) var toast: String?
    /// How the top screen fills the TV: "fit" (4:3), "fill" (crop to cover) or "stretch". The box remembers it per game.
    @Published private(set) var view = "fit"
    static let views = ["fit", "fill", "stretch"]
    static func viewName(_ v: String) -> String { ["fit": "Fit", "fill": "Fill", "stretch": "Stretch"][v] ?? "Fit" }

    /// The view that shows the bottom screen (frames go straight to it, not through SwiftUI).
    weak var screen: UIImageView?

    // libretro joypad bits, as the box expects them.
    static let bits: [String: Int] = ["b": 0, "y": 1, "select": 2, "start": 3, "up": 4, "down": 5,
                                      "left": 6, "right": 7, "a": 8, "x": 9, "l": 10, "r": 11]

    private var ws: URLSessionWebSocketTask?
    private var address: BoxAddress?
    private var pairing: Pairing?
    private var stopped = true
    private var lastRx = Date()
    private var pingTimer: Timer?
    private var toastTimer: Timer?
    private let decodeQueue = DispatchQueue(label: "ds.decode", qos: .userInteractive)
    private var frame = [UInt16](repeating: 0, count: 256 * 192)
    private var haveFrame = false
    private static let lut: [UInt32] = (0..<65536).map { c in
        let r = UInt32(((c >> 11) << 3) | (c >> 13)), g = UInt32((((c >> 5) & 63) << 2) | ((c >> 9) & 3)), b = UInt32(((c & 31) << 3) | ((c >> 2) & 7))
        return 0xFF00_0000 | (b << 16) | (g << 8) | r
    }

    func start(address: BoxAddress?, pairing: Pairing?) {
        guard let address, let pairing else { return }
        self.address = address
        self.pairing = pairing
        stopped = false
        connect()
    }

    func stop() {
        stopped = true
        pingTimer?.invalidate()
        ws?.cancel(with: .goingAway, reason: nil)
        ws = nil
        connected = false
    }

    private func connect() {
        guard !stopped, ws == nil, let a = address, let p = pairing else { return }
        var c = URLComponents(url: a.ws, resolvingAgainstBaseURL: false)!
        c.path = "/games/ws"
        c.queryItems = [URLQueryItem(name: "role", value: "pad"), URLQueryItem(name: "tv", value: p.tv), URLQueryItem(name: "k", value: p.key)]
        var req = URLRequest(url: c.url!)
        req.timeoutInterval = 6
        let t = BoxSession.shared.session.webSocketTask(with: req)
        t.maximumMessageSize = 1 << 20
        ws = t
        haveFrame = false
        t.resume()
        receive(t)
        lastRx = Date()
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self, self.ws === t else { return }
            if Date().timeIntervalSince(self.lastRx) > 9 { return self.lost(t) }   // went quiet (phone slept)
            self.send(["t": "ping"])
        }
    }

    private func lost(_ t: URLSessionWebSocketTask) {
        guard ws === t else { return }
        t.cancel(with: .goingAway, reason: nil)
        ws = nil
        connected = false
        guard !stopped else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.connect() }
    }

    /// Back from the lock screen: check the connection now.
    func wake() {
        if ws == nil { connect() } else { send(["t": "key"]) }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let m):
                switch m {
                case .data(let d): self.decodeQueue.async { self.bottom(d) }
                case .string(let s): DispatchQueue.main.async { self.handle(s) }
                @unknown default: break
                }
                DispatchQueue.main.async { if self.ws === t { self.lastRx = Date(); if !self.connected { self.connected = true } } }
                self.receive(t)
            case .failure:
                DispatchQueue.main.async { self.lost(t) }
            }
        }
    }

    func send(_ msg: [String: Any]) {
        guard let t = ws, let d = try? JSONSerialization.data(withJSONObject: msg), let s = String(data: d, encoding: .utf8) else { return }
        t.send(.string(s)) { _ in }
    }

    // MARK: Bottom screen

    /// [4][keyframe][0][0] + raw deflate of the frame (or of its XOR with the last one).
    private func bottom(_ d: Data) {
        guard d.count > 4, d[d.startIndex] == 4 else { return }
        let key = d[d.startIndex + 1] == 1
        let n = 256 * 192
        var out = [UInt16](repeating: 0, count: n)
        let got = d.withUnsafeBytes { (src: UnsafeRawBufferPointer) -> Int in
            out.withUnsafeMutableBytes { dst in
                compression_decode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, n * 2,
                                          src.bindMemory(to: UInt8.self).baseAddress! + 4, d.count - 4, nil, COMPRESSION_ZLIB)
            }
        }
        guard got == n * 2 else { return }
        if key { frame = out; haveFrame = true }
        else {
            guard haveFrame else { DispatchQueue.main.async { self.send(["t": "key"]) }; return }
            for i in 0..<n { frame[i] ^= out[i] }
        }
        var px = [UInt32](repeating: 0, count: n)
        let lut = DSLink.lut
        for i in 0..<n { px[i] = lut[Int(frame[i])] }
        let img: CGImage? = px.withUnsafeBytes { buf in
            guard let ctx = CGContext(data: UnsafeMutableRawPointer(mutating: buf.baseAddress), width: 256, height: 192, bitsPerComponent: 8,
                                      bytesPerRow: 256 * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
            return ctx.makeImage()
        }
        guard let img else { return }
        DispatchQueue.main.async { self.screen?.layer.contents = img; self.screen?.subviews.forEach { $0.isHidden = true } }
    }

    // MARK: Messages

    private func handle(_ raw: String) {
        guard let d = raw.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let type = m["t"] as? String else { return }
        switch type {
        case "slots":
            let list = (m["slots"] as? [[String: Any]]) ?? []
            slots = list.map { s in
                let name = (s["slot"] as? String) ?? "\(s["slot"] as? Int ?? 1)"
                let t = (s["time"] as? Double) ?? 0
                var img: UIImage?
                if let u = s["img"] as? String, let comma = u.firstIndex(of: ","), let data = Data(base64Encoded: String(u[u.index(after: comma)...])) { img = UIImage(data: data) }
                return Slot(slot: name, time: t > 0 ? Date(timeIntervalSince1970: t / 1000) : nil, image: img)
            }
        case "toast":
            if let text = m["text"] as? String { show(text) }
        case "view":
            if let v = m["mode"] as? String, DSLink.views.contains(v) { view = v }
        default: break
        }
    }

    func show(_ text: String) {
        toast = text
        toastTimer?.invalidate()
        toastTimer = Timer.scheduledTimer(withTimeInterval: 2.2, repeats: false) { [weak self] _ in self?.toast = nil }
    }

    // MARK: Controls

    func buttons(_ mask: Int) { send(["t": "btn", "mask": mask]) }
    func touch(x: Double, y: Double) { send(["t": "touch", "x": x, "y": y]) }
    func release() { send(["t": "touch", "up": 1]) }
    func pause(_ on: Bool) { send(["t": "pause", "on": on]) }
    func askSlots() { send(["t": "slots"]) }
    func save(_ slot: String) { send(["t": "save", "slot": slot == "auto" ? "auto" : (Int(slot) ?? 1)]) }
    func load(_ slot: String) { send(["t": "load", "slot": slot == "auto" ? "auto" : (Int(slot) ?? 1)]) }
    func reset() { send(["t": "reset"]) }
    func setView(_ v: String) { guard DSLink.views.contains(v) else { return }; view = v; send(["t": "view", "mode": v]) }
    func nextView() {
        let i = DSLink.views.firstIndex(of: view) ?? 0
        setView(DSLink.views[(i + 1) % DSLink.views.count])
        show("TV: \(DSLink.viewName(view))")
    }
    func leave() { send(["t": "pause", "on": false]); send(["t": "leave"]) }
}
