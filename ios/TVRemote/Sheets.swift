import SwiftUI
import VisionKit

private struct SheetTop: View {
    let title: String
    var button = "Done"
    let close: () -> Void
    var body: some View {
        HStack {
            Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.ink)
            Spacer()
            Button(button, action: close).font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.ink)
        }
    }
}

/// More: arrow keys, hands-free voice, pairing, the volume buttons, forgetting the TV.
struct MoreSheet: View {
    @EnvironmentObject var link: TVLink
    @EnvironmentObject var volume: VolumeButtons
    @Environment(\.dismiss) private var dismiss
    @Binding var showKey: Bool
    @Binding var showPower: Bool
    @State private var confirmForget = false
    @State private var keyOn: Bool?

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                SheetTop(title: link.tvPower.name ?? "TV") { dismiss() }
                TVPowerPanel()
                LineButton(title: "Hands-free voice (Claude key)", action: {
                    dismiss()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { showKey = true }
                }) {
                    Text(keyOn == nil ? "" : keyOn! ? "On" : "Off").foregroundStyle(Color.mute)
                }
                LineButton(title: "Quick Adds", action: {
                    dismiss()
                    let page = link.savablePage ?? QuickDraft()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { link.quickDraft = page }
                }) {
                    Text(link.quick.isEmpty ? "" : "\(link.quick.count)").foregroundStyle(Color.mute)
                }
                Toggle(isOn: Binding(get: { link.sounds }, set: { link.setSounds($0); Haptics.tap() })) {
                    Text("TV sounds").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.ink)
                }
                .tint(Color.ink)
                .padding(.horizontal, 15).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))
                VStack(alignment: .leading, spacing: 10) {
                    Text("Theme").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.ink)
                    ThemeRow()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(15)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))
                Toggle(isOn: $volume.enabled) {
                    Text("Volume buttons control the TV").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.ink)
                }
                .tint(Color.ink)
                .padding(.horizontal, 15).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))
                LineButton(title: "Pair another phone") { link.pairAnother(); dismiss() }
                LineButton(title: "Forget this TV", danger: true) { confirmForget = true }
                if confirmForget {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("This phone will stop controlling the TV until you pair again.")
                            .font(.system(size: 14)).foregroundStyle(Color.ink2)
                        HStack(spacing: 8) {
                            Button("Keep") { confirmForget = false }
                                .padding(.vertical, 11).padding(.horizontal, 18)
                                .background(RoundedRectangle(cornerRadius: 14).fill(Color.line))
                                .foregroundStyle(Color.ink)
                            Button("Forget") { dismiss(); link.unpair() }
                                .padding(.vertical, 11).padding(.horizontal, 18)
                                .background(RoundedRectangle(cornerRadius: 14).fill(Color.danger))
                                .foregroundStyle(.white)
                        }
                        .font(.system(size: 15, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))
                }
                if let a = link.address {
                    Text("TV box: \(a.host)\(a.secure ? " · secure" : "")")
                        .font(.system(size: 12)).foregroundStyle(Color.mute)
                }
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.room.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(28)
        .presentationDragIndicator(.visible)
        .task {
            if let j = try? await link.claudeKey(["read": true]) { keyOn = j["set"] as? Bool ?? false }
        }
    }
}

/// The TV set: power, HDMI input, and where to find it on the network.
struct TVPowerSheet: View {
    @EnvironmentObject var link: TVLink
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SheetTop(title: link.tvPower.name ?? "TV") { dismiss() }
                TVPowerPanel()
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.room.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(28)
        .presentationDragIndicator(.visible)
    }
}

/// TV power, input and address. Lives at the top of ••• and in its own sheet.
struct TVPowerPanel: View {
    @EnvironmentObject var link: TVLink
    @State private var ip = ""
    @FocusState private var ipFocused: Bool

    private var p: TVPower { link.tvPower }
    private var status: String {
        if p.busy { return "Working…" }
        if !p.found { return "Not found" }
        switch p.on {
        case true?: return "On"
        case false?: return "Off"
        default: return "Unknown"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Circle().fill(p.on == true ? Color.ok : Color.mute).frame(width: 8, height: 8)
                Text(status).font(.system(size: 14)).foregroundStyle(Color.ink2)
            }
            Button {
                Haptics.press()
                link.togglePower()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "power").font(.system(size: 20, weight: .bold))
                    Text(p.on == true ? "Turn off" : p.on == false ? "Turn on" : "Power")
                        .font(.system(size: 17, weight: .semibold))
                }
                .foregroundStyle(p.on == true ? Color.white : Color.ink)
                .frame(maxWidth: .infinity)
                .frame(height: 64)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(p.on == true ? Color.ok : Color.white))
                .shadow(color: Color.ok.opacity(p.on == true ? 0.45 : 0), radius: 14, y: 6)
                .rest()
                .opacity(p.busy ? 0.7 : 1)
                .animation(.easeInOut(duration: 0.3), value: p.on)
            }
            .buttonStyle(PressStyle(scale: 0.97))
            .accessibilityLabel("TV power")
            .accessibilityValue(p.on == true ? "On" : p.on == false ? "Off" : "Unknown")

            VStack(alignment: .leading, spacing: 10) {
                Text("Input").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.ink)
                HStack(spacing: 8) {
                    ForEach(1...4, id: \.self) { n in
                        Chip(on: p.hdmi == n) { link.setHDMI(n); Haptics.tap() } label: {
                            Text("HDMI \(n)").fixedSize()
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(15)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))

            VStack(alignment: .leading, spacing: 10) {
                Text("TV address").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.ink)
                TextField("Find automatically", text: $ip)
                    .font(.system(size: 15, weight: .medium, design: .monospaced))
                    .keyboardType(.numbersAndPunctuation)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($ipFocused)
                    .onSubmit(save)
                    .padding(.horizontal, 14)
                    .frame(height: 48)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.room))
                HStack(spacing: 8) {
                    Chip(on: true) { save() } label: { Text("Save") }
                        .disabled(ip.trimmingCharacters(in: .whitespaces).isEmpty)
                    Chip {
                        ip = ""
                        ipFocused = false
                        link.setTVIP("")
                        Haptics.tap()
                    } label: { Text("Find again") }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(15)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))

            if let hint = p.hint {
                Text(hint).font(.system(size: 13)).foregroundStyle(Color.mute)
            }
        }
    }

    private func save() {
        let v = ip.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty else { return }
        ipFocused = false
        link.setTVIP(v)
        Haptics.tap()
    }
}

/// The arrow keys and OK.
struct DPad: View {
    @EnvironmentObject var link: TVLink
    var body: some View {
        Grid(horizontalSpacing: 8, verticalSpacing: 8) {
            GridRow { Color.clear.frame(width: 64, height: 64); k("ArrowUp", "chevron.up"); Color.clear.frame(width: 64, height: 64) }
            GridRow { k("ArrowLeft", "chevron.left"); ok; k("ArrowRight", "chevron.right") }
            GridRow { Color.clear.frame(width: 64, height: 64); k("ArrowDown", "chevron.down"); Color.clear.frame(width: 64, height: 64) }
        }
    }
    private var ok: some View {
        Button { link.send(["t": "key", "key": "Enter"]); Haptics.press() } label: {
            Text("OK").font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                .frame(width: 64, height: 64)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.ink))
        }
        .buttonStyle(PressStyle())
    }
    private func k(_ key: String, _ icon: String) -> some View {
        Button { link.send(["t": "key", "key": key]); Haptics.tap() } label: {
            Image(systemName: icon).font(.system(size: 18, weight: .semibold)).foregroundStyle(Color.ink)
                .frame(width: 64, height: 64)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.white))
                .rest()
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(key.replacingOccurrences(of: "Arrow", with: ""))
    }
}

/// Hands-free voice: a Claude API key, kept on the TV box (the phone only sees its last 4 characters).
struct KeySheet: View {
    @EnvironmentObject var link: TVLink
    @Environment(\.dismiss) private var dismiss
    @State private var set = false
    @State private var hint = ""
    @State private var checking = true
    @State private var reachable = true
    @State private var input = ""
    @State private var error = ""
    @State private var saving = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SheetTop(title: "Hands-free voice") { dismiss() }
                Text("Add a Claude API key and requests like “play a jazz playlist on YouTube” happen on their own. No taps needed.")
                    .font(.system(size: 14)).foregroundStyle(Color.ink2)
                HStack(spacing: 8) {
                    Circle().fill(set ? Color.ok : Color.mute).frame(width: 8, height: 8)
                    Text(status).font(.system(size: 14)).foregroundStyle(Color.ink2)
                }
                HStack(spacing: 8) {
                    TextField("sk-ant-…", text: $input)
                        .font(.system(size: 15, weight: .medium, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(.horizontal, 14)
                        .frame(height: 48)
                        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))
                    Button("Paste") {
                        if let s = UIPasteboard.general.string { input = s.trimmingCharacters(in: .whitespacesAndNewlines); Haptics.tap() }
                    }
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.ink)
                    .padding(.horizontal, 14).frame(height: 48)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))
                }
                CTAButton(title: saving ? "Checking with Claude…" : set ? "Replace key" : "Save key", busy: saving, action: save)
                Text(LocalizedStringKey("Get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys) → API keys. The key stays on your TV box."))
                    .font(.system(size: 14)).foregroundStyle(Color.ink2).tint(Color.ink)
                if set {
                    Button("Remove key") { Task { await change("") } }
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(Color.danger)
                        .frame(maxWidth: .infinity)
                }
                Text(error).font(.system(size: 14)).foregroundStyle(Color.danger)
            }
            .padding(20)
        }
        .background(Color.room.ignoresSafeArea())
        .presentationDetents([.large])
        .presentationCornerRadius(28)
        .task { await read() }
    }

    private var status: String {
        if checking { return "Checking…" }
        if !reachable { return "Couldn’t reach the TV box" }
        return set ? "Key saved (\(hint.isEmpty ? "…" : hint)) · hands-free is on" : "No key yet · voice shows choices instead"
    }

    private func apply(_ j: [String: Any]) {
        set = j["set"] as? Bool ?? false
        hint = j["hint"] as? String ?? ""
    }

    private func read() async {
        checking = true
        do { apply(try await link.claudeKey(["read": true])); reachable = true }
        catch { reachable = false; self.error = error.localizedDescription }
        checking = false
    }

    private func save() {
        let v = input.filter { !$0.isWhitespace }
        guard !v.isEmpty else { error = "Paste your key first."; return }
        Task { await change(v) }
    }

    private func change(_ v: String) async {
        error = ""
        saving = true
        do {
            apply(try await link.claudeKey(["anthropicKey": v]))
            input = ""
            link.showToast(v.isEmpty ? "Key removed" : "Hands-free voice is on")
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.warn()
        }
        saving = false
    }
}

/// Quick Add: save a link as a tile under Apps. Opened from "+ Quick Add" with the page on the TV filled in,
/// or empty to paste a link. The box suggests a name (the video's title), so usually no typing at all.
struct QuickAddSheet: View {
    @EnvironmentObject var link: TVLink
    @Environment(\.dismiss) private var dismiss
    let draft: QuickDraft
    @State private var url = ""
    @State private var name = ""
    @State private var named = false
    @State private var icon = "auto"
    @State private var k = "chrome"
    @State private var asked = ""
    @State private var finding = false
    @State private var saving = false
    @State private var error = ""
    @State private var removing: String?
    @FocusState private var nameFocus: Bool

    private let iconCols = Array(repeating: GridItem(.flexible(), spacing: 8), count: 6)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                SheetTop(title: "Quick Adds") { dismiss() }
                HStack(spacing: 14) {
                    QuickFace(k: k, icon: icon, radius: 15)
                        .frame(width: 58, height: 58)
                        .rest()
                        .animation(.tv, value: icon)
                    VStack(alignment: .leading, spacing: 3) {
                        TextField(finding ? "Finding a name…" : "Name", text: $name)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Color.ink)
                            .focused($nameFocus)
                            .submitLabel(.done)
                            .onChange(of: name) { _, v in if nameFocus { named = !v.trimmingCharacters(in: .whitespaces).isEmpty } }
                        Text(host(url).isEmpty ? "Paste a link below" : host(url))
                            .font(.system(size: 13)).foregroundStyle(Color.mute).lineLimit(1)
                    }
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.white))
                HStack(spacing: 8) {
                    TextField("Paste a link", text: $url)
                        .font(.system(size: 15, weight: .medium))
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { peek() }
                        .padding(.horizontal, 14)
                        .frame(height: 48)
                        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))
                    Button("Paste") {
                        if let s = UIPasteboard.general.string { url = s.trimmingCharacters(in: .whitespacesAndNewlines); Haptics.tap(); peek() }
                    }
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.ink)
                    .padding(.horizontal, 14).frame(height: 48)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))
                }
                LazyVGrid(columns: iconCols, spacing: 8) {
                    ForEach(["auto"] + QuickIcons.all.map(\.k), id: \.self) { key in
                        Button {
                            icon = key
                            Haptics.tick()
                        } label: {
                            QuickFace(k: k, icon: key, radius: 14)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 17, style: .continuous)
                                        .stroke(Color.ink, lineWidth: icon == key ? 2 : 0)
                                        .padding(-3)
                                )
                        }
                        .buttonStyle(PressStyle(scale: 0.9))
                        .accessibilityLabel(QuickIcons.find(key)?.name ?? "App logo")
                        .accessibilityAddTraits(icon == key ? .isSelected : [])
                    }
                }
                .padding(.vertical, 4)
                CTAButton(title: saving ? "Saving…" : "Save to Quick Adds", busy: saving, action: save)
                if !error.isEmpty {
                    Text(error).font(.system(size: 14)).foregroundStyle(Color.danger)
                }
                if !link.quick.isEmpty {
                    Text("SAVED").font(.system(size: 12, weight: .medium)).tracking(1.7).foregroundStyle(Color.mute).padding(.top, 6)
                    ForEach(Array(link.quick.reversed())) { q in row(q) }
                }
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.room.ignoresSafeArea())
        .presentationDetents([.large])
        .presentationCornerRadius(28)
        .onAppear {
            url = draft.url
            if !draft.url.isEmpty { peek() }
        }
        .task(id: url) {
            // Typed or pasted a link: ask the box about it once typing pauses.
            try? await Task.sleep(for: .milliseconds(600))
            if !Task.isCancelled { peek() }
        }
        .onChange(of: link.quickPeek) { _, p in
            guard let p, p.asked == asked else { return }
            finding = false
            if let e = p.error { error = e; return }
            error = ""
            k = p.k
            if !p.url.isEmpty, !nameFocus { url = p.url; asked = p.url }
            if !named, !p.name.isEmpty { name = p.name }
        }
        .onChange(of: link.quickResult) { _, r in
            guard saving, let r else { return }
            saving = false
            if let e = r.error { error = e; Haptics.warn() } else { Haptics.success(); dismiss() }
        }
    }

    private func row(_ q: QuickAdd) -> some View {
        HStack(spacing: 12) {
            QuickFace(k: q.k, icon: q.icon, radius: 10).frame(width: 38, height: 38)
            VStack(alignment: .leading, spacing: 1) {
                Text(q.name).font(.system(size: 15, weight: .medium)).foregroundStyle(Color.ink).lineLimit(1)
                Text(host(q.url)).font(.system(size: 12)).foregroundStyle(Color.mute).lineLimit(1)
            }
            Spacer(minLength: 8)
            Button {
                if removing == q.id {
                    link.removeQuick(q.id)
                    removing = nil
                    Haptics.press()
                } else {
                    removing = q.id
                    Haptics.tap()
                }
            } label: {
                Group {
                    if removing == q.id { Text("Remove").font(.system(size: 13, weight: .semibold)).padding(.horizontal, 10) }
                    else { Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).frame(width: 32) }
                }
                .frame(height: 32)
                .foregroundStyle(removing == q.id ? .white : Color.ink2)
                .background(Capsule().fill(removing == q.id ? Color.danger : Color.room))
            }
            .buttonStyle(PressStyle())
            .accessibilityLabel("Remove \(q.name)")
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white))
        .animation(.tv, value: removing)
    }

    private func host(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, let h = URL(string: t.lowercased().hasPrefix("http") ? t : "https://" + t)?.host else { return "" }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }

    private func peek() {
        let u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !u.isEmpty, u != asked else { return }
        asked = u
        finding = !named
        link.peekQuick(u, title: u == draft.url ? draft.title : "")
    }

    private func save() {
        guard !saving else { return }
        let u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !u.isEmpty else { error = "Paste a link first."; return }
        error = ""
        saving = true
        nameFocus = false
        link.saveQuick(url: u, name: name.trimmingCharacters(in: .whitespaces), icon: icon, title: u == draft.url ? draft.title : "")
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            if saving { saving = false; error = "The TV box didn’t answer. Try again." }
        }
    }
}

/// Scan the QR code on the TV's pairing screen.
struct ScanSheet: View {
    @EnvironmentObject var link: TVLink
    @Environment(\.dismiss) private var dismiss
    @State private var error = ""
    @State private var busy = false

    var body: some View {
        VStack(spacing: 14) {
            SheetTop(title: "Scan the TV’s code", button: "Cancel") { dismiss() }
                .padding([.horizontal, .top], 20)
            QRScanner { value in
                guard !busy, value.contains("#pair=") else { return }
                busy = true
                Task {
                    do { _ = try await link.pair(qr: value); Haptics.success(); dismiss() }
                    catch { self.error = error.localizedDescription; Haptics.warn(); busy = false }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .padding(.horizontal, 20)
            Text(error.isEmpty ? (busy ? "Pairing…" : "Point the camera at the code on the TV.") : error)
                .font(.system(size: 14)).foregroundStyle(error.isEmpty ? Color.ink2 : Color.danger)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 20).padding(.bottom, 20)
        }
        .background(Color.room.ignoresSafeArea())
    }
}

struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
                                           qualityLevel: .fast, isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {
        context.coordinator.found = found
        if !vc.isScanning { try? vc.startScanning() }
    }
    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var found: (String) -> Void
        init(found: @escaping (String) -> Void) { self.found = found }
        func dataScanner(_ s: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in items {
                if case let .barcode(b) = item, let v = b.payloadStringValue { found(v) }
            }
        }
    }
}
