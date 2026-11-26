import SwiftUI
import AVFoundation

// Mario & Luigi: co-op Super Mario Bros. on two iPhones. The game page (Web/) runs inside the app,
// served from the phone itself, so the emulator gets full speed and nothing is downloaded.
@main
struct MarioLuigiApp: App {
    init() {
        // Game sound plays even when the ring/silent switch is on silent, and mixes with nothing else.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
    }
    var body: some Scene {
        WindowGroup {
            GameView()
                .ignoresSafeArea()
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)
                .defersSystemGestures(on: .all)
                .onAppear { UIApplication.shared.isIdleTimerDisabled = true }   // no screen dimming mid-level
                .preferredColorScheme(.dark)
        }
    }
}
