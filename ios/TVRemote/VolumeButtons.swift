import AVFoundation
import MediaPlayer
import SwiftUI

/// The iPhone's own volume buttons turn the TV up and down while the remote is open.
/// iOS has no direct "button pressed" event, so this listens for the phone's volume changing,
/// sends the change to the TV, and quietly puts the phone's volume back in the middle.
/// A hidden system volume view keeps the phone's own volume bubble from showing.
final class VolumeButtons: NSObject, ObservableObject {
    var onStep: ((Int) -> Void)?
    @Published var enabled: Bool = (UserDefaults.standard.object(forKey: "volumeButtons") as? Bool) ?? true {
        didSet { UserDefaults.standard.set(enabled, forKey: "volumeButtons"); enabled ? start() : stop() }
    }

    private var observation: NSKeyValueObservation?
    private var resetting = false
    private var paused = false
    weak var slider: UISlider?
    private let mid: Float = 0.5

    func start() {
        guard enabled, observation == nil, !paused else { return }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.ambient, options: [.mixWithOthers])
        try? s.setActive(true)
        observation = s.observe(\.outputVolume, options: [.old, .new]) { [weak self] _, change in
            DispatchQueue.main.async { self?.changed(old: change.oldValue, new: change.newValue) }
        }
        center()
    }

    func stop() {
        observation?.invalidate()
        observation = nil
    }

    /// Talking needs the microphone's audio setup: step aside, then come back.
    func pause() { paused = true; stop() }
    func resume() { paused = false; start() }

    private func changed(old: Float?, new: Float?) {
        guard let new else { return }
        if resetting { if abs(new - mid) < 0.01 { resetting = false }; return }
        let delta = new - (old ?? mid)
        guard abs(delta) > 0.001 else { return }
        onStep?(delta > 0 ? 10 : -10)
        Haptics.tick()
        center()
    }

    /// Put the phone's volume back in the middle so presses never hit the top or bottom.
    private func center() {
        let current = AVAudioSession.sharedInstance().outputVolume
        guard abs(current - mid) > 0.01, let slider else { return }
        resetting = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            slider.value = self.mid
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.resetting = false }
        }
    }
}

/// An invisible system volume view. Needed to set the volume and to hide the volume bubble.
struct HiddenVolumeView: UIViewRepresentable {
    let buttons: VolumeButtons
    func makeUIView(context: Context) -> MPVolumeView {
        let v = MPVolumeView(frame: CGRect(x: -200, y: -200, width: 10, height: 10))
        v.alpha = 0.011
        v.isUserInteractionEnabled = false
        DispatchQueue.main.async {
            buttons.slider = v.subviews.compactMap { $0 as? UISlider }.first
            buttons.start()
        }
        return v
    }
    func updateUIView(_ uiView: MPVolumeView, context: Context) {}
}
