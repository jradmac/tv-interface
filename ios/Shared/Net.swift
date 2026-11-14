import Foundation
import Network

/// Hosts this app will talk to: the TV box on the home network, and nothing else.
enum LocalHost {
    static let defaultName = "tv.local"

    /// True for tv.local, any other .local name, and private (home network) IP addresses.
    static func isLocal(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if h.hasSuffix(".local") { return true }
        if let v4 = IPv4Address(h) {
            let b = [UInt8](v4.rawValue)
            return b[0] == 10 || (b[0] == 172 && (16...31).contains(b[1])) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254)
        }
        if let v6 = IPv6Address(h) {
            let b = [UInt8](v6.rawValue)
            return (b[0] & 0xFE) == 0xFC || (b[0] == 0xFE && (b[1] & 0xC0) == 0x80)   // unique-local or link-local
        }
        return false
    }

    /// The host as it goes into a URL (IPv6 needs brackets).
    static func urlHost(_ host: String) -> String {
        host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    }
}

/// The one URLSession for everything. The box makes its own https certificate (no public
/// authority signs it), so this trusts that certificate only when talking to the box itself
/// on the home network (tv.local or a private address). Every other host gets normal checks.
final class BoxSession: NSObject, URLSessionDelegate, URLSessionWebSocketDelegate {
    static let shared = BoxSession()

    lazy var session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 8
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c, delegate: self, delegateQueue: .main)
    }()

    /// The phone's WebSocket hooks (set by TVLink).
    var onOpen: ((URLSessionWebSocketTask) -> Void)?
    var onClose: ((URLSessionWebSocketTask, Int) -> Void)?
    var onFail: ((URLSessionTask, Int?) -> Void)?

    // Session-level and task-level challenges both land here.
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        handle(challenge, completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        handle(challenge, completionHandler)
    }
    private func handle(_ challenge: URLAuthenticationChallenge,
                        _ done: (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = space.serverTrust,
              LocalHost.isLocal(space.host) else {
            return done(.performDefaultHandling, nil)
        }
        done(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        onOpen?(webSocketTask)
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        onClose?(webSocketTask, closeCode.rawValue)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task is URLSessionWebSocketTask, error != nil else { return }
        onFail?(task, (task.response as? HTTPURLResponse)?.statusCode)
    }
}

struct BoxError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Where the box answers, for example https://tv.local
struct BoxAddress: Equatable {
    var host: String
    var secure: Bool
    var base: URL { URL(string: "\(secure ? "https" : "http")://\(LocalHost.urlHost(host))")! }
    var ws: URL { URL(string: "\(secure ? "wss" : "ws")://\(LocalHost.urlHost(host))/ws")! }
}

enum BoxAPI {
    /// POST JSON to the box and get JSON back. Errors carry the box's own words.
    static func post(_ addr: BoxAddress, _ path: String, _ body: [String: Any], timeout: TimeInterval = 8) async throws -> [String: Any] {
        var req = URLRequest(url: addr.base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let reply: (Data, URLResponse)
        do { reply = try await BoxSession.shared.session.data(for: req) }
        catch { throw BoxError(message: "Couldn’t reach the TV box. Make sure your phone is on the same Wi-Fi.") }
        let (data, res) = reply
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if let http = res as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw BoxError(message: j["error"] as? String ?? "Something went wrong. Try again.")
        }
        return j
    }

    /// Does the box answer at this host? Tries the secure address first, then plain http.
    static func probe(_ host: String) async -> BoxAddress? {
        for secure in [true, false] {
            let a = BoxAddress(host: host, secure: secure)
            var req = URLRequest(url: a.base.appendingPathComponent("api/health"))
            req.timeoutInterval = secure ? 2.5 : 3
            if let r = try? await BoxSession.shared.session.data(for: req),
               (r.1 as? HTTPURLResponse)?.statusCode == 200,
               let j = try? JSONSerialization.jsonObject(with: r.0) as? [String: Any], j["ok"] as? Bool == true {
                return a
            }
        }
        return nil
    }
}

/// Finds the TV box on the home network: the saved address, tv.local, and Bonjour.
/// Bonjour looks for "_tvremote._tcp", which the box advertises once the server update ships;
/// until then tv.local (which the box already answers to) does the job.
final class BoxFinder {
    static let serviceType = "_tvremote._tcp"
    private var browser: NWBrowser?
    private var resolving: [NWConnection] = []
    private let lock = NSLock()
    private var _found: [String] = []
    var found: [String] { lock.lock(); defer { lock.unlock() }; return _found }
    private func add(_ h: String) { lock.lock(); if !_found.contains(h) { _found.append(h) }; lock.unlock() }

    func start() {
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjour(type: Self.serviceType, domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            for r in results { self?.resolve(r.endpoint) }
        }
        b.start(queue: .main)
        browser = b
    }

    func stop() {
        browser?.cancel(); browser = nil
        resolving.forEach { $0.cancel() }; resolving = []
    }

    /// Bonjour gives a service name; connect once to learn its IPv4 address.
    private func resolve(_ endpoint: NWEndpoint) {
        let params = NWParameters.tcp
        if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let c = NWConnection(to: endpoint, using: params)
        c.stateUpdateHandler = { [weak self, weak c] state in
            guard let self, let c else { return }
            switch state {
            case .ready:
                if case let .hostPort(host, _)? = c.currentPath?.remoteEndpoint {
                    var h = "\(host)"
                    if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }
                    self.add(h)
                }
                c.cancel()
            case .failed, .cancelled:
                self.resolving.removeAll { $0 === c }
            default: break
            }
        }
        resolving.append(c)
        c.start(queue: .main)
    }

    /// Try each place the box might be, best first. Returns the first that answers.
    func locate(preferred: String?) async -> BoxAddress? {
        start()
        var tried = Set<String>()
        for round in 0..<2 {
            var hosts: [String] = []
            if let p = preferred, !p.isEmpty { hosts.append(p) }
            hosts.append(LocalHost.defaultName)
            hosts += found
            for h in hosts where !tried.contains(h) {
                tried.insert(h)
                if let a = await BoxAPI.probe(h) { return a }
            }
            // Give Bonjour a moment to answer, then try what it found.
            if round == 0 { try? await Task.sleep(nanoseconds: 1_500_000_000) }
        }
        return nil
    }
}
