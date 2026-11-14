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
