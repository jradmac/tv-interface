import SwiftUI
import AVFoundation

// Kart Party: Mario Kart DS for up to 4 players. The host phone runs every racer's DS;
// friends join with a link or code. The game page (Web/) is served from the phone itself, so the emulator gets full speed.
@main
struct MarioKartApp: App {
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
                .onAppear { UIApplication.shared.isIdleTimerDisabled = true }   // no screen dimming mid-race
                .preferredColorScheme(.dark)
        }
    }
}
