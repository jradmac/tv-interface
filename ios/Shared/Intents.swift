import AppIntents
import Foundation

// Actions for Siri, Shortcuts, the Action button, Control Center and the Lock Screen.
// Each one sends the same message the remote's own button sends.

enum TalkRequest {
    static let key = "talkRequestedAt"
    /// Ask the app to start listening as soon as it's open.
    static func post() {
        AppGroup.defaults.set(Date().timeIntervalSince1970, forKey: key)
        NotificationCenter.default.post(name: .talkRequested, object: nil)
    }
}

extension Notification.Name {
    static let talkRequested = Notification.Name("talkRequested")
}

struct PlayPauseTVIntent: AppIntent {
    static var title: LocalizedStringResource = "Play or Pause the TV"
    static var description = IntentDescription("Plays or pauses whatever is on the TV.")
    func perform() async throws -> some IntentResult {
        try await QuickSend.send([["t": "media", "a": "playpause"]])
        return .result()
    }
}

struct PowerTVIntent: AppIntent {
    static var title: LocalizedStringResource = "TV power"
    static var description = IntentDescription("Turns the TV on or off.")
    func perform() async throws -> some IntentResult {
        try await QuickSend.send([["t": "tv.power"]])
        return .result()
    }
}

struct TVOnIntent: AppIntent {
    static var title: LocalizedStringResource = "Turn TV on"
    func perform() async throws -> some IntentResult {
        try await QuickSend.send([["t": "tv.power", "on": true]])
        return .result()
    }
}

struct TVOffIntent: AppIntent {
    static var title: LocalizedStringResource = "Turn TV off"
    func perform() async throws -> some IntentResult {
        try await QuickSend.send([["t": "tv.power", "on": false]])
        return .result()
    }
}

struct VolumeUpTVIntent: AppIntent {
    static var title: LocalizedStringResource = "Turn the TV Up"
    func perform() async throws -> some IntentResult {
        try await QuickSend.send([["t": "media", "a": "vol", "v": 10]])
        return .result()
    }
}

struct VolumeDownTVIntent: AppIntent {
    static var title: LocalizedStringResource = "Turn the TV Down"
    func perform() async throws -> some IntentResult {
        try await QuickSend.send([["t": "media", "a": "vol", "v": -10]])
        return .result()
    }
}

struct HomeTVIntent: AppIntent {
    static var title: LocalizedStringResource = "Go to the TV Home Screen"
    func perform() async throws -> some IntentResult {
        try await QuickSend.send([["t": "home"]])
        return .result()
    }
}

/// "Hey Siri, tell TV Remote…" then say what you want: "play jazz on YouTube".
/// The words go to the TV box like a voice request, so with a Claude key the hands-free agent does it.
struct AskTVIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask the TV"
    static var description = IntentDescription("Tell the TV what to do, like “play jazz on YouTube” or “put on The Office”.")

    @Parameter(title: "Request", requestValueDialog: "What should the TV do?")
    var request: String

    static var parameterSummary: some ParameterSummary { Summary("Ask the TV to \(\.$request)") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = request.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .result(dialog: "I didn’t catch that.") }
        try await QuickSend.send([
            ["t": "voice", "phase": "start"],
            ["t": "voice", "phase": "partial", "text": text],
            ["t": "voice", "phase": "final", "text": text],
        ])
        return .result(dialog: "On it.")
    }
}

/// Opens the remote and starts listening right away (stops by itself when you pause).
struct TalkToTVIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk to the TV"
    static var description = IntentDescription("Opens TV Remote ready to listen.")
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        TalkRequest.post()
        return .result()
    }
}
