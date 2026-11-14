import SwiftUI
import UIKit

/// Full-screen DS controller, shown while a game runs on the TV: the live bottom screen
/// (touch it like the DS's stylus screen) with the D-pad, A/B/X/Y, L/R and Start/Select around it.
/// The app itself stays portrait, so the pad is drawn sideways and follows how you hold the phone.
struct DSPadScreen: View {
    @EnvironmentObject var link: TVLink
    @StateObject private var ds = DSLink()
    @State private var menu = false
    @State private var turn: Double = 90
    @Environment(\.scenePhase) private var phase

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color(hex: 0x141416)
                DSPadRepresentable(ds: ds, turn: turn, viewName: DSLink.viewName(ds.view), openMenu: openMenu)
                if let t = ds.toast {
                    Text(t)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 18).padding(.vertical, 10)
                        .background(Capsule().fill(Color(hex: 0x28282E).opacity(0.95)))
                        .rotationEffect(.degrees(turn))
                        .transition(.opacity)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .ignoresSafeArea()
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .animation(.easeInOut(duration: 0.2), value: ds.toast)
        .onAppear {
            ds.start(address: link.address, pairing: link.pairing)
            UIApplication.shared.isIdleTimerDisabled = true
            UIDevice.current.beginGeneratingDeviceOrientationNotifications()
            followDevice()
        }
        .onDisappear {
            ds.stop()
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .onReceive(NotificationCenter.default.publisher(for: UIDevice.orientationDidChangeNotification)) { _ in followDevice() }
        .onChange(of: phase) { _, p in if p == .active { ds.wake() } }
        .sheet(isPresented: $menu, onDismiss: { ds.pause(false) }) {
            DSMenu(ds: ds, title: link.game?.title ?? "Game", close: { menu = false })
                .presentationDetents([.large])
        }
    }

    private func openMenu() {
        ds.pause(true)
        ds.askSlots()
        menu = true
        Haptics.press()
    }
    /// Phone turned left or right: the pad turns with it so it's never upside down.
    private func followDevice() {
        switch UIDevice.current.orientation {
        case .landscapeLeft: withAnimation(.tv) { turn = 90 }
        case .landscapeRight: withAnimation(.tv) { turn = -90 }
        default: break
        }
    }
}

// MARK: - The pad itself (UIKit, for real multi-touch)

struct DSPadRepresentable: UIViewRepresentable {
    let ds: DSLink
    let turn: Double
    let viewName: String
    let openMenu: () -> Void
    func makeUIView(context: Context) -> DSPadHolder {
        let h = DSPadHolder()
        let v = h.pad
        ds.screen = v.screen
        v.onMask = { [weak ds] m in ds?.buttons(m) }
        v.onTouch = { [weak ds] x, y in ds?.touch(x: x, y: y) }
        v.onRelease = { [weak ds] in ds?.release() }
        v.onMenu = openMenu
        v.onView = { [weak ds] in Haptics.press(); ds?.nextView() }
        v.viewName = viewName
        h.turn = turn
        return h
    }
    func updateUIView(_ h: DSPadHolder, context: Context) {
        h.pad.onMenu = openMenu
        h.pad.viewName = viewName
        if h.turn != turn { UIView.animate(withDuration: 0.3) { h.turn = turn; h.layoutIfNeeded() } }
    }
}

/// Holds the pad turned sideways inside the portrait app. UIKit maps touches through the turn.
final class DSPadHolder: UIView {
    let pad = DSPadView()
    var turn: Double = 90 { didSet { setNeedsLayout() } }
    override init(frame: CGRect) { super.init(frame: frame); addSubview(pad); isMultipleTouchEnabled = true }
    required init?(coder: NSCoder) { fatalError() }
    override func layoutSubviews() {
        super.layoutSubviews()
        pad.transform = .identity
        pad.bounds = CGRect(x: 0, y: 0, width: bounds.height, height: bounds.width)
        pad.center = CGPoint(x: bounds.midX, y: bounds.midY)
        pad.transform = CGAffineTransform(rotationAngle: turn * .pi / 180)
    }
}

final class DSPadView: UIView {
    let screen = UIImageView()
    var onMask: ((Int) -> Void)?
    var onTouch: ((Double, Double) -> Void)?
    var onRelease: (() -> Void)?
    var onMenu: (() -> Void)?
    var onView: (() -> Void)?
    /// Fit / Fill / Stretch, shown on the key next to the menu.
    var viewName = "Fit" { didSet { if viewName != oldValue { paintViewKey() } } }

    private final class Key: UIView {
        let name: String
        let label = UILabel()
        var on = false { didSet { guard on != oldValue else { return }
            UIView.animate(withDuration: 0.06) { self.backgroundColor = self.on ? DSPadView.keyHi : DSPadView.key
                self.transform = self.on ? CGAffineTransform(scaleX: 0.93, y: 0.93) : .identity } } }
        init(_ name: String, _ text: String, size: CGFloat = 19, dim: Bool = false) {
            self.name = name
            super.init(frame: .zero)
            backgroundColor = DSPadView.key
            label.text = text
            label.font = .systemFont(ofSize: size, weight: .semibold)
            label.textColor = dim ? DSPadView.dim : DSPadView.ink
            label.textAlignment = .center
            addSubview(label)
            layer.shadowColor = UIColor.black.cgColor
            layer.shadowOpacity = 0.35
            layer.shadowRadius = 5
            layer.shadowOffset = CGSize(width: 0, height: 3)
        }
        required init?(coder: NSCoder) { fatalError() }
        override func layoutSubviews() { super.layoutSubviews(); label.frame = bounds }
    }

    static let key = UIColor(red: 0x25 / 255, green: 0x25 / 255, blue: 0x2A / 255, alpha: 1)
    static let keyHi = UIColor(red: 0x34 / 255, green: 0x34 / 255, blue: 0x3B / 255, alpha: 1)
    static let ink = UIColor(red: 0xE9 / 255, green: 0xE6 / 255, blue: 0xDF / 255, alpha: 1)
    static let dim = UIColor(red: 0x8C / 255, green: 0x88 / 255, blue: 0x80 / 255, alpha: 1)

    private let keys: [Key] = [Key("l", "L", size: 15), Key("r", "R", size: 15), Key("x", "X"), Key("y", "Y"), Key("a", "A"), Key("b", "B"),
                               Key("select", "SELECT", size: 11, dim: true), Key("start", "START", size: 11, dim: true)]
    private let dpad = UIView()
    private let arrows = (0..<4).map { _ in UIImageView() }
    private let menuKey = Key("menu", "", size: 15, dim: true)
    private let viewKey = Key("view", "", size: 13, dim: true)
    private let wait = UILabel()

    private var stylus: UITouch?
    private var fingers: [UITouch: Int] = [:]
    private var heldMask = 0
    private var lastTouchSend: CFTimeInterval = 0
    private let tick = UIImpactFeedbackGenerator(style: .light)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(red: 0x14 / 255, green: 0x14 / 255, blue: 0x16 / 255, alpha: 1)
        isMultipleTouchEnabled = true
        screen.backgroundColor = .black
        screen.layer.magnificationFilter = .nearest
        screen.layer.cornerRadius = 10
        screen.layer.masksToBounds = true
        screen.contentMode = .scaleToFill
        addSubview(screen)
        wait.text = "Connecting to the TV…"
        wait.textColor = DSPadView.dim
        wait.font = .systemFont(ofSize: 15)
        wait.textAlignment = .center
        screen.addSubview(wait)
        for (i, name) in ["chevron.up", "chevron.down", "chevron.left", "chevron.right"].enumerated() {
            arrows[i].image = UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .bold))
            arrows[i].tintColor = DSPadView.dim
            arrows[i].contentMode = .center
        }
        let h = UIView(), v = UIView()
        for p in [h, v] { p.backgroundColor = DSPadView.key; p.layer.cornerRadius = 12; dpad.addSubview(p) }
        h.tag = 1; v.tag = 2
        arrows.forEach { dpad.addSubview($0) }
        dpad.isUserInteractionEnabled = false
        addSubview(dpad)
        keys.forEach { $0.isUserInteractionEnabled = false; addSubview($0) }
        menuKey.label.text = nil
        let pauseIcon = UIImageView(image: UIImage(systemName: "pause.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)))
        pauseIcon.tintColor = DSPadView.dim
        pauseIcon.contentMode = .center
        pauseIcon.tag = 9
        menuKey.addSubview(pauseIcon)
        menuKey.isUserInteractionEnabled = false
        addSubview(menuKey)
        viewKey.isUserInteractionEnabled = false
        addSubview(viewKey)
        paintViewKey()
        tick.prepare()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func paintViewKey() {
        let icon = NSTextAttachment(image: UIImage(systemName: "arrow.up.left.and.arrow.down.right",
                                                   withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))!
                                        .withTintColor(DSPadView.dim, renderingMode: .alwaysOriginal))
        let s = NSMutableAttributedString(attachment: icon)
        s.append(NSAttributedString(string: "  " + viewName, attributes: [.font: UIFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: DSPadView.dim]))
        viewKey.label.attributedText = s
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let W = bounds.width, H = bounds.height
        // Leave room for the notch / Dynamic Island and the home bar at either end.
        let side: CGFloat = 50, pad: CGFloat = 12
        let sh = H - pad * 2, sw = min(sh * 4 / 3, W - side * 2 - 2 * 170)
        let shh = sw * 3 / 4
        screen.frame = CGRect(x: (W - sw) / 2, y: (H - shh) / 2, width: sw, height: shh)
        wait.frame = screen.bounds
        let leftW = screen.frame.minX - side, rightX = screen.frame.maxX
        func k(_ n: String) -> Key { keys.first { $0.name == n }! }
        // Left: L, D-pad, menu.
        let colL = CGRect(x: side - 20, y: pad, width: leftW, height: H - pad * 2)
        let colR = CGRect(x: rightX, y: pad, width: W - rightX - side + 20, height: H - pad * 2)
        let shW = min(132, colL.width - 20)
        k("l").frame = CGRect(x: colL.midX - shW / 2, y: colL.minY, width: shW, height: 40)
        k("r").frame = CGRect(x: colR.midX - shW / 2, y: colR.minY, width: shW, height: 40)
        [k("l"), k("r")].forEach { $0.layer.cornerRadius = 14 }
        let dp = min(150, colL.width - 16, H * 0.42)
        dpad.frame = CGRect(x: colL.midX - dp / 2, y: H / 2 - dp / 2, width: dp, height: dp)
        let third = dp / 3
        dpad.viewWithTag(1)?.frame = CGRect(x: 0, y: third, width: dp, height: third)
        dpad.viewWithTag(2)?.frame = CGRect(x: third, y: 0, width: third, height: dp)
        arrows[0].frame = CGRect(x: third, y: 0, width: third, height: third)
        arrows[1].frame = CGRect(x: third, y: third * 2, width: third, height: third)
        arrows[2].frame = CGRect(x: 0, y: third, width: third, height: third)
        arrows[3].frame = CGRect(x: third * 2, y: third, width: third, height: third)
        // Menu (pause) and the TV screen size key, side by side under the D-pad.
        let vkW = min(88, colL.width - 44 - 10 - 8), rowX = colL.midX - (44 + 10 + vkW) / 2
        menuKey.frame = CGRect(x: rowX, y: colL.maxY - 44, width: 44, height: 44)
        menuKey.layer.cornerRadius = 22
        viewKey.frame = CGRect(x: rowX + 54, y: colL.maxY - 44, width: vkW, height: 44)
        viewKey.layer.cornerRadius = 22
        menuKey.viewWithTag(9)?.frame = menuKey.bounds
        // Right: R, A/B/X/Y diamond, Select + Start.
        let ab = min(156, colR.width - 12, H * 0.44), b = ab * 0.36
        let o = CGPoint(x: colR.midX - ab / 2, y: H / 2 - ab / 2)
        k("x").frame = CGRect(x: o.x + ab * 0.32, y: o.y, width: b, height: b)
        k("b").frame = CGRect(x: o.x + ab * 0.32, y: o.y + ab - b, width: b, height: b)
        k("y").frame = CGRect(x: o.x, y: o.y + ab * 0.32, width: b, height: b)
        k("a").frame = CGRect(x: o.x + ab - b, y: o.y + ab * 0.32, width: b, height: b)
        ["x", "b", "y", "a"].forEach { k($0).layer.cornerRadius = b / 2 }
        let ssW = min(76, (colR.width - 18) / 2)
        k("select").frame = CGRect(x: colR.midX - ssW - 5, y: colR.maxY - 30, width: ssW, height: 30)
        k("start").frame = CGRect(x: colR.midX + 5, y: colR.maxY - 30, width: ssW, height: 30)
        [k("select"), k("start")].forEach { $0.layer.cornerRadius = 15 }
    }

    // MARK: Touches: every finger is checked against every control, so you can roll between buttons.

    private func maskAt(_ p: CGPoint) -> Int {
        let d = dpad.frame.insetBy(dx: -18, dy: -18)
        if d.contains(p) {
            let dx = p.x - dpad.frame.midX, dy = p.y - dpad.frame.midY
            if hypot(dx, dy) < dpad.frame.width * 0.12 { return 0 }
            let a = atan2(dy, dx) * 180 / .pi
            var m = 0
            let bit = DSLink.bits
            if a > -67.5 && a < 67.5 { m |= 1 << bit["right"]! }
            if a > 22.5 && a < 157.5 { m |= 1 << bit["down"]! }
            if a > 112.5 || a < -112.5 { m |= 1 << bit["left"]! }
            if a > -157.5 && a < -22.5 { m |= 1 << bit["up"]! }
            return m
        }
        // A little forgiveness around each button, nearest one wins.
        var best: (Key, CGFloat)?
        for k in keys {
            let f = k.frame.insetBy(dx: -10, dy: -10)
            guard f.contains(p) else { continue }
            let dist = hypot(p.x - k.frame.midX, p.y - k.frame.midY)
            if best == nil || dist < best!.1 { best = (k, dist) }
        }
        if let k = best?.0, let b = DSLink.bits[k.name] { return 1 << b }
        return 0
    }
    private func screenPoint(_ p: CGPoint) -> (Double, Double) {
        let f = screen.frame
        return (Double(max(0, min(255, (p.x - f.minX) / f.width * 256))), Double(max(0, min(191, (p.y - f.minY) / f.height * 192))))
    }
    private func update() {
        let m = fingers.values.reduce(0, |)
        guard m != heldMask else { return }
        if m & ~heldMask != 0 { tick.impactOccurred() }
        heldMask = m
        onMask?(m)
        for k in keys { if let b = DSLink.bits[k.name] { k.on = m & (1 << b) != 0 } }
        let bit = DSLink.bits
        for (i, n) in ["up", "down", "left", "right"].enumerated() { arrows[i].tintColor = m & (1 << bit[n]!) != 0 ? .white : DSPadView.dim }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            let p = t.location(in: self)
            if menuKey.frame.insetBy(dx: -4, dy: -8).contains(p) { menuKey.on = true; continue }
            if viewKey.frame.insetBy(dx: -4, dy: -8).contains(p) { viewKey.on = true; continue }
            if stylus == nil && screen.frame.contains(p) {
                stylus = t
                let (x, y) = screenPoint(p)
                onTouch?(x, y)
                continue
            }
            fingers[t] = maskAt(p)
        }
        update()
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            let p = t.location(in: self)
            if t === stylus {
                let now = CACurrentMediaTime()
                if now - lastTouchSend > 0.012 { lastTouchSend = now; let (x, y) = screenPoint(p); onTouch?(x, y) }
            } else if fingers[t] != nil { fingers[t] = maskAt(p) }
        }
        update()
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { finish(touches, tapped: true) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { finish(touches, tapped: false) }
    private func finish(_ touches: Set<UITouch>, tapped: Bool) {
        for t in touches {
            if t === stylus { stylus = nil; onRelease?() }
            fingers[t] = nil
            if menuKey.on {
                menuKey.on = false
                if tapped && menuKey.frame.insetBy(dx: -4, dy: -8).contains(t.location(in: self)) { onMenu?() }
            }
            if viewKey.on {
                viewKey.on = false
                if tapped && viewKey.frame.insetBy(dx: -4, dy: -8).contains(t.location(in: self)) { onView?() }
            }
        }
        update()
    }

}

// MARK: - Menu: quick save/load, slots, restart, leave

struct DSMenu: View {
    @ObservedObject var ds: DSLink
    let title: String
    let close: () -> Void
    @State private var sure: String?
    @State private var sureRestart = false

    private let cols = [GridItem(.adaptive(minimum: 108), spacing: 10)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(title).font(.system(size: 20, weight: .semibold))
                    Spacer()
                    Button("Resume", action: close).font(.system(size: 16, weight: .medium))
                }
                HStack(spacing: 10) {
                    big("Quick save", accent: true) { ds.save("1"); close() }
                    big("Quick load") {
                        if let s = ds.slots.filter({ $0.time != nil }).max(by: { $0.time! < $1.time! }) { ds.load(s.slot); close() }
                        else { ds.show("Nothing saved yet") }
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("TV screen").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
                    Picker("TV screen", selection: Binding(get: { ds.view }, set: { Haptics.tap(); ds.setView($0) })) {
                        ForEach(DSLink.views, id: \.self) { Text(DSLink.viewName($0)).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Text(ds.view == "fill" ? "Fills the TV. The top and bottom edges are cut off a little."
                         : ds.view == "stretch" ? "Stretches the game to the whole TV." : "The real DS shape, as big as fits.")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                LazyVGrid(columns: cols, spacing: 10) {
                    ForEach(ds.slots) { s in slot(s) }
                }
                HStack(spacing: 10) {
                    big(sureRestart ? "Tap again to restart" : "Restart game", accent: sureRestart) {
                        if sureRestart { ds.reset(); close() } else { sureRestart = true }
                    }
                    big("Leave game") { ds.leave(); close() }
                }
                Text("Your in-game saves stay on the TV box, and leaving the game always keeps an Auto save.")
                    .font(.system(size: 13)).foregroundStyle(.secondary)
            }
            .padding(20)
        }
        .onAppear { ds.askSlots() }
    }

    private func big(_ text: String, accent: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button(action: { Haptics.tap(); action() }) {
            Text(text).font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity).frame(height: 48)
                .background(RoundedRectangle(cornerRadius: 14).fill(accent ? Color(hex: 0xB9A8FF) : Color(.secondarySystemBackground)))
                .foregroundStyle(accent ? Color(hex: 0x16131F) : Color.primary)
        }
        .buttonStyle(.plain)
    }

    private func slot(_ s: DSLink.Slot) -> some View {
        VStack(spacing: 0) {
            ZStack {
                Color.black
                if let img = s.image { Image(uiImage: img).resizable().interpolation(.none).scaledToFill() }
                else { Text("Empty").font(.system(size: 12)).foregroundStyle(.gray) }
            }
            .aspectRatio(4 / 3, contentMode: .fit)
            .clipped()
            HStack {
                Text(s.name).font(.system(size: 12, weight: .semibold))
                Spacer()
                if let t = s.time { Text(t, style: .relative).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1) }
            }
            .padding(.horizontal, 8).padding(.top, 6)
            HStack(spacing: 6) {
                Button(sure == s.slot ? "Replace?" : "Save") {
                    Haptics.tap()
                    if s.time != nil && sure != s.slot { sure = s.slot; return }
                    ds.save(s.slot); close()
                }
                .disabled(s.slot == "auto")
                Button("Load") { Haptics.tap(); ds.load(s.slot); close() }
                    .disabled(s.time == nil)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .padding(8)
        }
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(.secondarySystemBackground)))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}
