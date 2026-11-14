import SwiftUI
import UIKit

/// Opens by itself when a text box on the TV is selected (kbd.show), or from the ⌨︎ button.
/// Typing is sent live: the difference between what was in the field and what is there now
/// becomes Backspaces plus new text, so autocorrect, paste and dictation all work. Return sends Enter.
struct KeyboardPanel: View {
    @EnvironmentObject var link: TVLink
    let request: KbdRequest
    @State private var prev = ""
    @State private var clearToken = 0

    private var term: Bool { link.state.mode == "service" && link.state.k == "claudecode" }

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Text(label.uppercased())
                    .font(.system(size: 13)).tracking(0.8).foregroundStyle(Color.mute).lineLimit(1)
                Spacer()
                Button("Done") { link.kbd = nil }
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.ink)
            }
            TVTextField(request: request, clearToken: clearToken, placeholder: placeholder,
                        changed: sendDiff,
                        enter: {
                            link.send(["t": "key", "key": "Enter"]); Haptics.tap()
                            if term { clear() }
                        },
                        emptyBackspace: { link.send(["t": "key", "key": "Backspace"]) })
                .frame(height: 44)
                .overlay(alignment: .bottom) { Rectangle().fill(Color.ink).frame(height: 2) }
            HStack(spacing: 8) {
                key("⌫ Delete") {
                    link.send(["t": "key", "key": "Backspace"])
                    prev = String(prev.dropLast())
                    clearToken += 1000   // tells the field to drop its last character too
                }
                key(term ? "Tab" : "Next field") { link.send(["t": "key", "key": "Tab"]); clear() }
                key("Enter") { link.send(["t": "key", "key": "Enter"]); if term { clear() } }
            }
            if term {
                HStack(spacing: 8) {
                    key("Esc") { link.send(["t": "key", "key": "Escape"]) }
                    key("⇧ Tab") { link.send(["t": "key", "key": "Tab", "shift": true]) }
                    key("↑") { link.send(["t": "key", "key": "ArrowUp"]) }
                    key("↓") { link.send(["t": "key", "key": "ArrowDown"]) }
                    key("Ctrl C") { link.send(["t": "key", "key": "c", "ctrl": true]) }
                }
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.white))
        .lift()
        .onAppear { prev = request.type == "password" || request.manual ? "" : request.value }
        .onChange(of: request.id) { _, _ in prev = request.type == "password" || request.manual ? "" : request.value }
    }

    private var label: String {
        if !request.label.isEmpty { return request.label }
        return term ? "Typing in Claude Code" : "Typing on the TV"
    }
    private var placeholder: String {
        request.label.isEmpty ? (request.manual ? "Type on the TV" : "Type here") : request.label
    }

    private func key(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button { action(); Haptics.tap() } label: {
            Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(Color.ink)
                .lineLimit(1).minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity).padding(.vertical, 11).padding(.horizontal, 6)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.room))
        }
        .buttonStyle(PressStyle(scale: 0.96))
    }

    private func clear() { prev = ""; clearToken += 1 }

    private func sendDiff(_ now: String) {
        let a = Array(prev), b = Array(now)
        var i = 0
        while i < a.count && i < b.count && a[i] == b[i] { i += 1 }
        for _ in 0..<(a.count - i) { link.send(["t": "key", "key": "Backspace"]) }
        if b.count > i { link.send(["t": "text", "s": String(b[i...])]) }
        prev = now
    }
}

/// A UIKit text field: it can open the keyboard by itself, notices Backspace on an empty
/// field, and waits for multi-step typing (like Japanese) to finish before sending.
struct TVTextField: UIViewRepresentable {
    let request: KbdRequest
    let clearToken: Int
    let placeholder: String
    let changed: (String) -> Void
    let enter: () -> Void
    let emptyBackspace: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> BackspaceField {
        let f = BackspaceField()
        f.font = .systemFont(ofSize: 20, weight: .medium)
        f.textColor = UIColor(red: 28 / 255, green: 27 / 255, blue: 25 / 255, alpha: 1)
        f.tintColor = f.textColor
        f.delegate = context.coordinator
        f.addTarget(context.coordinator, action: #selector(Coordinator.edited(_:)), for: .editingChanged)
        context.coordinator.parent = self
        configure(f, context: context, fresh: true)
        DispatchQueue.main.async { f.becomeFirstResponder() }
        return f
    }

    func updateUIView(_ f: BackspaceField, context: Context) {
        context.coordinator.parent = self
        let c = context.coordinator
        if c.requestID != request.id { configure(f, context: context, fresh: true) }
        if c.clearToken != clearToken {
            if clearToken - c.clearToken >= 1000 { f.text = String((f.text ?? "").dropLast()) } else { f.text = "" }
            c.clearToken = clearToken
        }
        f.placeholder = placeholder
    }

    private func configure(_ f: BackspaceField, context: Context, fresh: Bool) {
        let c = context.coordinator
        c.requestID = request.id
        c.clearToken = clearToken
        f.onEmptyBackspace = emptyBackspace
        f.isSecureTextEntry = request.type == "password"
        f.autocorrectionType = .no
        f.spellCheckingType = .no
        f.returnKeyType = request.type == "search" ? .search : .go
        switch request.type {
        case "email": f.keyboardType = .emailAddress; f.autocapitalizationType = .none; f.textContentType = .emailAddress
        case "password": f.keyboardType = .default; f.autocapitalizationType = .none; f.textContentType = .password
        case "number": f.keyboardType = .numberPad; f.autocapitalizationType = .none
        case "url": f.keyboardType = .URL; f.autocapitalizationType = .none; f.textContentType = .URL
        case "search": f.keyboardType = .webSearch; f.autocapitalizationType = .none
        default: f.keyboardType = .default; f.autocapitalizationType = .sentences
        }
        f.text = request.manual || request.type == "password" ? "" : request.value
        f.placeholder = placeholder
        if f.isFirstResponder { f.reloadInputViews() } else { DispatchQueue.main.async { f.becomeFirstResponder() } }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: TVTextField?
        var requestID: UUID?
        var clearToken = 0

        @objc func edited(_ f: UITextField) {
            guard f.markedTextRange == nil else { return }   // still composing
            parent?.changed(f.text ?? "")
        }
        func textFieldShouldReturn(_ f: UITextField) -> Bool {
            if f.markedTextRange == nil { parent?.changed(f.text ?? "") }
            parent?.enter()
            return false
        }
    }
}

final class BackspaceField: UITextField {
    var onEmptyBackspace: (() -> Void)?
    override func deleteBackward() {
        if (text ?? "").isEmpty { onEmptyBackspace?() }   // delete what was there before
        super.deleteBackward()
    }
}
