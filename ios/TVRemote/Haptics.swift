import UIKit

/// Small taps under the finger, like the web remote's vibrate() calls but with real iPhone haptics.
enum Haptics {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let medium = UIImpactFeedbackGenerator(style: .medium)
    private static let soft = UIImpactFeedbackGenerator(style: .soft)
    private static let select = UISelectionFeedbackGenerator()
    private static let note = UINotificationFeedbackGenerator()

    static func tap() { light.impactOccurred() }
    static func press() { medium.impactOccurred() }
    static func tick() { select.selectionChanged() }
    static func land() { soft.impactOccurred(intensity: 0.8) }
    static func success() { note.notificationOccurred(.success) }
    static func warn() { note.notificationOccurred(.warning) }
    static func prepare() { light.prepare(); select.prepare() }
}
