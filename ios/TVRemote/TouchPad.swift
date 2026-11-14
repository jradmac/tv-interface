import SwiftUI
import UIKit

/// The big surface. On Home and in results a swipe sends live deltas (the TV runs the spring)
/// and the release sends its speed. Inside a service it is a touchpad: drag moves the pointer,
/// tap clicks, two fingers scroll. At most one message per screen frame, like the web remote.
struct TouchPad: UIViewRepresentable {
    var mode: String
    var enabled: Bool
    let send: ([String: Any]) -> Void

    func makeUIView(context: Context) -> TouchPadView {
        let v = TouchPadView()
        v.send = send
        return v
    }
    func updateUIView(_ v: TouchPadView, context: Context) {
        v.mode = mode
        v.enabled = enabled
        v.send = send
    }
}

final class TouchPadView: UIView {
    var mode = "home"
    var enabled = true
    var send: ([String: Any]) -> Void = { _ in }

    private var active: [UITouch] = []
    private var start: (p: CGPoint, t: CFTimeInterval)?
    private var lastY: CGFloat = 0
    private var moved: CGFloat = 0
    private var samples: [(x: CGFloat, t: CFTimeInterval)] = []
    private var acc: CGFloat = 0, accY: CGFloat = 0, accScroll: CGFloat = 0
    private var link: CADisplayLink?
    // Two-finger scroll: once a second finger lands, the whole touch scrolls until every finger lifts.
    private var scrolling = false
    private var centroidY: CGFloat = 0
    private var scrollY: CGFloat = 0
    private var scrollSamples: [(y: CGFloat, t: CFTimeInterval)] = []
    private var coast: CADisplayLink?
    private var coastV: CGFloat = 0
    private let dot = CALayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        backgroundColor = .clear
        dot.bounds = CGRect(x: 0, y: 0, width: 72, height: 72)
        dot.cornerRadius = 36
        dot.backgroundColor = UIColor(red: 28 / 255, green: 27 / 255, blue: 25 / 255, alpha: 0.07).cgColor
        dot.opacity = 0
        layer.addSublayer(dot)
    }
    required init?(coder: NSCoder) { fatalError() }

    private var isService: Bool { mode == "service" }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard enabled else { return }
        stopCoast()
        for t in touches where !active.contains(t) { active.append(t) }
        if isService && active.count >= 2 {
            if !scrolling {
                scrolling = true
                start = nil
                acc = 0; accY = 0; accScroll = 0
                scrollY = 0
                scrollSamples = [(0, touches.first?.timestamp ?? CACurrentMediaTime())]
                showDot(at: nil, on: false)
            }
            centroidY = centroid()
            return
        }
        guard !scrolling, active.count == 1, let t = active.first else { return }
        let p = t.location(in: self)
        start = (p, t.timestamp)
        lastY = p.y
        moved = 0
        samples = [(p.x, t.timestamp)]
        showDot(at: p, on: true)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard enabled else { return }
        if scrolling {
            let c = centroid(), d = c - centroidY
            centroidY = c
            guard d != 0 else { return }
            accScroll += -d * 2.6
            scrollY += d
            let now = touches.first?.timestamp ?? CACurrentMediaTime()
            scrollSamples.append((scrollY, now))
            while scrollSamples.count > 2, now - scrollSamples[0].t > 0.12 { scrollSamples.removeFirst() }
            schedule()
            return
        }
        guard let start else { return }
        let n = CGFloat(active.count)
        for t in touches where active.contains(t) {
            let p = t.location(in: self), q = t.previousLocation(in: self)
            let dx = p.x - q.x, dy = p.y - q.y
            if active.count >= 2 { accScroll += dy / n; continue }
            lastY = p.y
            moveDot(to: p)
            moved = max(moved, hypot(p.x - start.p.x, p.y - start.p.y))
            acc += dx
            accY += dy
            samples.append((p.x, t.timestamp))
            while samples.count > 2, t.timestamp - samples[0].t > 0.1 { samples.removeFirst() }
        }
        if active.count >= 2 || (moved > 8 && mode != "countdown" && mode != "voice") { schedule() }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { finish(touches) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { finish(touches) }

    private func finish(_ touches: Set<UITouch>) {
        let ending = touches.first { active.contains($0) }
        active.removeAll { touches.contains($0) }
        if scrolling {
            if !active.isEmpty { centroidY = centroid(); return }   // re-base on the fingers left
            if link != nil { flush() }
            scrolling = false
            let now = ending?.timestamp ?? CACurrentMediaTime()
            while scrollSamples.count > 1, now - scrollSamples[0].t > 0.12 { scrollSamples.removeFirst() }
            if let a = scrollSamples.first, let b = scrollSamples.last, b.t > a.t {
                let v = (b.y - a.y) / CGFloat((b.t - a.t) * 1000)        // px per ms
                let px = max(-260, min(260, -v * 2.6 * 16.7))
                if abs(px) >= 4 { startCoast(px) }
            }
            scrollSamples = []
            return
        }
        guard active.isEmpty, let start else { return }
        showDot(at: nil, on: false)
        let now = ending?.timestamp ?? CACurrentMediaTime()
        let dt = now - start.t
        if moved < 10 && dt < 0.35 {
            send(["t": isService ? "click" : "tap"])
            Haptics.tap()
        } else if !isService && mode != "countdown" {
            if link != nil { flush() }
            let a = samples.first!, b = samples.last!
            let ms = (b.t - a.t) * 1000
            let vx = ms > 0 ? Double((b.x - a.x) / ms) : 0
            send(["t": "swipe", "phase": "end", "vx": vx,
                  "dxTotal": Double(b.x - start.p.x), "dyTotal": Double(lastY - start.p.y)])
        } else if link != nil {
            flush()
        }
        self.start = nil
    }

    private func schedule() {
        guard link == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick))
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func tick() { flush() }

    private func flush() {
        link?.invalidate()
        link = nil
        if isService {
            if scrolling {
                if accScroll != 0 { send(["t": "scroll", "dy": Double(accScroll)]) }
            } else if acc != 0 || accY != 0 {
                send(["t": "pad", "dx": Double(acc * 1.8), "dy": Double(accY * 1.8)])
            }
        } else if acc != 0 {
            send(["t": "swipe", "phase": "move", "dx": Double(acc)])
        }
        acc = 0; accY = 0; accScroll = 0
    }

    private func centroid() -> CGFloat {
        guard !active.isEmpty else { return centroidY }
        return active.reduce(0) { $0 + $1.location(in: self).y } / CGFloat(active.count)
    }

    private func startCoast(_ v: CGFloat) {
        coastV = v
        let l = CADisplayLink(target: self, selector: #selector(coastTick))
        l.add(to: .main, forMode: .common)
        coast = l
    }

    @objc private func coastTick() {
        send(["t": "scroll", "dy": Double(coastV)])
        coastV *= 0.93
        if abs(coastV) < 1.5 { stopCoast() }
    }

    private func stopCoast() {
        coast?.invalidate()
        coast = nil
    }

    private func showDot(at p: CGPoint?, on: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(p != nil)
        if let p { dot.position = p; dot.transform = CATransform3DMakeScale(0.6, 0.6, 1) }
        CATransaction.commit()
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.22)
        dot.opacity = on ? 1 : 0
        dot.transform = on ? CATransform3DIdentity : CATransform3DMakeScale(0.6, 0.6, 1)
        CATransaction.commit()
    }

    private func moveDot(to p: CGPoint) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        dot.position = p
        CATransaction.commit()
    }
}
