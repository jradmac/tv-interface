import SwiftUI

// One warm light room, one ink, one soft lift. The same tokens as shared/tokens.css on the TV.
extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: opacity)
    }
    static let room = Color(hex: 0xF3F1EC)
    static let roomHi = Color(hex: 0xFBFAF7)
    static let card = Color.white
    static let ink = Color(hex: 0x1C1B19)
    static let ink2 = Color(hex: 0x5E5B55)
    static let mute = Color(hex: 0x9A968E)
    static let line = Color(hex: 0xE4E0D8)
    static let ok = Color(hex: 0x3C8B5A)
    static let danger = Color(hex: 0xB3261E)
}

extension View {
    /// The resting shadow every white surface sits on.
    func rest() -> some View {
        self
            .shadow(color: Color(red: 40 / 255, green: 30 / 255, blue: 20 / 255).opacity(0.04), radius: 1, y: 1)
            .shadow(color: Color(red: 40 / 255, green: 30 / 255, blue: 20 / 255).opacity(0.14), radius: 20, y: 16)
    }
    /// The bigger lift for floating panels.
    func lift() -> some View {
        self
            .shadow(color: Color(red: 40 / 255, green: 30 / 255, blue: 20 / 255).opacity(0.10), radius: 12, y: 12)
            .shadow(color: Color(red: 40 / 255, green: 30 / 255, blue: 20 / 255).opacity(0.22), radius: 40, y: 40)
    }
}

extension Animation {
    /// cubic-bezier(.22,1,.36,1), the TV's ease.
    static let tv = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.35)
    static let springy = Animation.spring(response: 0.45, dampingFraction: 0.72)
}

/// Every button in the app presses in a little.
struct PressStyle: ButtonStyle {
    var scale: CGFloat = 0.94
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// A white pill or round button on the room.
struct Chip<Label: View>: View {
    var on = false
    let action: () -> Void
    @ViewBuilder let label: () -> Label
    var body: some View {
        Button(action: action) {
            label()
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(on ? Color.white : Color.ink)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(Capsule().fill(on ? Color.ink : Color.white))
                .rest()
        }
        .buttonStyle(PressStyle())
    }
}

/// The big black call to action used in sheets.
struct CTAButton: View {
    let title: String
    var busy = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(.white) }
                Text(title)
            }
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.ink))
        }
        .buttonStyle(PressStyle(scale: 0.97))
        .disabled(busy)
    }
}

/// A white row button in a sheet.
struct LineButton<Trailing: View>: View {
    let title: String
    var danger = false
    let action: () -> Void
    @ViewBuilder var trailing: () -> Trailing
    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).foregroundStyle(danger ? Color.danger : Color.ink)
                Spacer()
                trailing()
            }
            .font(.system(size: 15, weight: .medium))
            .padding(15)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white))
        }
        .buttonStyle(PressStyle(scale: 0.98))
    }
}

extension LineButton where Trailing == EmptyView {
    init(title: String, danger: Bool = false, action: @escaping () -> Void) {
        self.init(title: title, danger: danger, action: action, trailing: { EmptyView() })
    }
}
