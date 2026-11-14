import SwiftUI

@main
struct TVRemoteApp: App {
    @StateObject private var link = TVLink()
    @StateObject private var listener = Listener()
    @StateObject private var volume = VolumeButtons()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(link)
                .environmentObject(listener)
                .environmentObject(volume)
                .preferredColorScheme(.light)
                .onAppear {
                    volume.onStep = { [weak link] v in link?.send(["t": "media", "a": "vol", "v": v]) }
                    link.start()
                    Haptics.prepare()
                }
        }
        .onChange(of: phase) { _, p in
            switch p {
            case .active:
                link.wake()
                volume.start()
            case .background:
                volume.stop()
                if listener.listening { listener.stop() }
            default: break
            }
        }
    }
}
