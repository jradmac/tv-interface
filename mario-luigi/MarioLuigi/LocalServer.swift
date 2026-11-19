import Foundation
import Network

/// A tiny web server on 127.0.0.1 that hands the game page its files from inside the app.
/// (Web workers and WebAssembly need a real http:// address; a file:// page can't start them.)
final class LocalServer {
    static let shared = LocalServer()
    private var listener: NWListener?
    private var baseURL: URL?
    private let queue = DispatchQueue(label: "LocalServer")

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "wasm": "application/wasm", "png": "image/png", "json": "application/json", "nds": "application/octet-stream",
    ]

    func start() async throws -> URL {
        if let baseURL { return baseURL }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        params.acceptLocalOnly = true
        let listener = try NWListener(using: params)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] conn in self?.serve(conn) }
        let port: UInt16 = try await withCheckedThrowingContinuation { cont in
            var done = false
            listener.stateUpdateHandler = { state in
                guard !done else { return }
                switch state {
                case .ready: done = true; cont.resume(returning: listener.port?.rawValue ?? 0)
                case .failed(let e): done = true; cont.resume(throwing: e)
                default: break
                }
            }
            listener.start(queue: queue)
        }
        let url = URL(string: "http://127.0.0.1:\(port)/index.html")!
        baseURL = url
        return url
    }

    /// Where a file of the game page lives in the app (Xcode may put Web/ files at the top level).
    private func file(_ name: String) -> URL? {
        guard !name.isEmpty, !name.contains(".."), !name.hasPrefix(".") else { return nil }
        let res = Bundle.main.resourceURL!
        for candidate in [res.appendingPathComponent("Web").appendingPathComponent(name), res.appendingPathComponent(name)] {
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    private func serve(_ conn: NWConnection) {
        conn.start(queue: queue)
        receiveHeader(conn, buffer: Data())
    }

    private func receiveHeader(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<end.lowerBound], as: UTF8.self)
                self.respond(conn, head: head)
            } else if isComplete || error != nil || buf.count > 65536 {
                conn.cancel()
            } else {
                self.receiveHeader(conn, buffer: buf)
            }
        }
    }

    private func respond(_ conn: NWConnection, head: String) {
        let first = head.split(separator: "\r\n").first.map(String.init) ?? ""
        let parts = first.split(separator: " ")
        var path = parts.count > 1 ? String(parts[1]) : "/"
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        path = path.removingPercentEncoding ?? path
        var name = String(path.drop(while: { $0 == "/" }))
        if name.isEmpty { name = "index.html" }

        guard parts.first == "GET" || parts.first == "HEAD", let url = file(name), let body = try? Data(contentsOf: url, options: .mappedIfSafe) else {
            send(conn, status: "404 Not Found", type: "text/plain", body: Data("Not found".utf8), headOnly: false)
            return
        }
        let type = Self.types[url.pathExtension.lowercased()] ?? "application/octet-stream"
        send(conn, status: "200 OK", type: type, body: body, headOnly: parts.first == "HEAD")
    }

    private func send(_ conn: NWConnection, status: String, type: String, body: Data, headOnly: Bool) {
        var out = Data("HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n".utf8)
        if !headOnly { out.append(body) }
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
}
