import Foundation

/// For the Lock Screen, Control Center, Siri and the Action button: connect to the box, send a
/// message or two, and hang up. Uses the pairing saved by the app (shared through the App Group).
enum QuickSend {
    static func send(_ msgs: [[String: Any]]) async throws {
        guard let p = PairingStore.load() else {
            throw BoxError(message: "Open TV Remote and pair it with the TV first.")
        }
        var addr = await BoxAPI.probe(p.host)
        if addr == nil, p.host != LocalHost.defaultName { addr = await BoxAPI.probe(LocalHost.defaultName) }
        guard let a = addr else {
            throw BoxError(message: "Couldn’t reach the TV box. Is your phone on the home Wi-Fi?")
        }
        var c = URLComponents(url: a.ws, resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "tv", value: p.tv),
                        URLQueryItem(name: "role", value: "remote"),
                        URLQueryItem(name: "k", value: p.key)]
        let t = BoxSession.shared.session.webSocketTask(with: c.url!)
        t.resume()
        defer { t.cancel(with: .normalClosure, reason: nil) }

        // The box says "welcome" once this phone is let in.
        let inRoom = try await withThrowingTaskGroup(of: Bool.self) { g -> Bool in
            g.addTask { _ = try await t.receive(); return true }
            g.addTask {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                t.cancel(with: .goingAway, reason: nil)
                return false
            }
            let first: Bool = (try? await g.next()) ?? false
            g.cancelAll()
            return first
        }
        guard inRoom else {
            throw BoxError(message: "The TV box didn’t let this phone in. Open TV Remote to pair again.")
        }
        for m in msgs {
            let d = try JSONSerialization.data(withJSONObject: m)
            try await t.send(.string(String(decoding: d, as: UTF8.self)))
        }
        try? await Task.sleep(nanoseconds: 250_000_000)   // let the last message leave
    }
}
