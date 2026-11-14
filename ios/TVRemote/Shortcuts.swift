import AppIntents

/// Phrases Siri knows without any setup. Each also appears in the Shortcuts app and can be
/// put on the Action button (Settings › Action Button › Shortcut).
struct TVShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskTVIntent(), phrases: [
            "Tell \(.applicationName)",
            "Ask \(.applicationName)",
            "Ask the TV with \(.applicationName)",
        ], shortTitle: "Ask the TV", systemImageName: "sparkles.tv")
        AppShortcut(intent: TalkToTVIntent(), phrases: [
            "Talk to \(.applicationName)",
            "Talk to the TV with \(.applicationName)",
        ], shortTitle: "Talk to the TV", systemImageName: "mic.fill")
        AppShortcut(intent: PlayPauseTVIntent(), phrases: [
            "Pause \(.applicationName)",
            "Play \(.applicationName)",
            "Play or pause with \(.applicationName)",
        ], shortTitle: "Play / Pause", systemImageName: "playpause.fill")
        AppShortcut(intent: TVOnIntent(), phrases: [
            "Turn the TV on with \(.applicationName)",
        ], shortTitle: "Turn TV On", systemImageName: "power")
        AppShortcut(intent: TVOffIntent(), phrases: [
            "Turn the TV off with \(.applicationName)",
        ], shortTitle: "Turn TV Off", systemImageName: "power")
        AppShortcut(intent: VolumeUpTVIntent(), phrases: [
            "Turn up \(.applicationName)",
        ], shortTitle: "Volume Up", systemImageName: "speaker.plus.fill")
        AppShortcut(intent: VolumeDownTVIntent(), phrases: [
            "Turn down \(.applicationName)",
        ], shortTitle: "Volume Down", systemImageName: "speaker.minus.fill")
    }
}
