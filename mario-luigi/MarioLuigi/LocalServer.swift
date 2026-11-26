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
        // Always the same address (port 47813) when it's free, so the page keeps its name and settings
        // between launches. Game saves don't depend on it: they're files in the app (see /save/ below).
        let port: UInt16
        if let p = try? await listen(on: 47813) { port = p } else { port = try await listen(on: .any) }
        let url = URL(string: "http://127.0.0.1:\(port)/index.html")!
        baseURL = url
        return url
    }

    private func listen(on port: NWEndpoint.Port) async throws -> UInt16 {
        let listener = try NWListener(using: Self.params(port: port))
        listener.newConnectionHandler = { [weak self] conn in self?.serve(conn) }
        let ready: UInt16 = try await withCheckedThrowingContinuation { cont in
            var done = false
            listener.stateUpdateHandler = { state in
                guard !done else { return }
                switch state {
                case .ready: done = true; cont.resume(returning: listener.port?.rawValue ?? 0)
                case .failed(let e), .waiting(let e): done = true; listener.cancel(); cont.resume(throwing: e)
                default: break
                }
            }
            listener.start(queue: queue)
        }
        self.listener = listener
        return ready
    }

    private static func params(port: NWEndpoint.Port) -> NWParameters {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        params.acceptLocalOnly = true
        params.allowLocalEndpointReuse = true
        return params
    }

    /// Game saves live in Application Support/Saves (kept when the app is updated from Xcode).
    private static let saveDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("Saves", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    private func saveFile(_ name: String) -> URL? {
        guard !name.isEmpty, name.count <= 40, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else { return nil }
        return Self.saveDir.appendingPathComponent(name + ".sav")
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
                let body = Data(buf[end.upperBound...])
                let length = head.split(separator: "\r\n").compactMap { line -> Int? in
                    let kv = line.split(separator: ":", maxSplits: 1)
                    guard kv.count == 2, kv[0].lowercased() == "content-length" else { return nil }
                    return Int(kv[1].trimmingCharacters(in: .whitespaces))
                }.first ?? 0
                if length > 0 && length <= 4_000_000 { self.receiveBody(conn, head: head, body: body, length: length) }
                else { self.respond(conn, head: head, body: body) }
            } else if isComplete || error != nil || buf.count > 65536 {
                conn.cancel()
            } else {
                self.receiveHeader(conn, buffer: buf)
            }
        }
    }

    private func receiveBody(_ conn: NWConnection, head: String, body: Data, length: Int) {
        if body.count >= length { respond(conn, head: head, body: body.prefix(length)); return }
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var b = body
            if let data { b.append(data) }
            if b.count >= length { self.respond(conn, head: head, body: b.prefix(length)) }
            else if isComplete || error != nil { conn.cancel() }
            else { self.receiveBody(conn, head: head, body: b, length: length) }
        }
    }

    private func respond(_ conn: NWConnection, head: String, body reqBody: Data = Data()) {
        let first = head.split(separator: "\r\n").first.map(String.init) ?? ""
        let parts = first.split(separator: " ")
        var path = parts.count > 1 ? String(parts[1]) : "/"
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        path = path.removingPercentEncoding ?? path
        var name = String(path.drop(while: { $0 == "/" }))
        if name.isEmpty { name = "index.html" }

        // Game saves: GET reads one, PUT writes one.
        if name.hasPrefix("save/") {
            let method = parts.first.map(String.init) ?? ""
            guard let file = saveFile(String(name.dropFirst(5))) else {
                send(conn, status: "400 Bad Request", type: "text/plain", body: Data("Bad name".utf8), headOnly: false); return
            }
            if method == "PUT" || method == "POST" {
                do {
                    try reqBody.write(to: file, options: .atomic)
                    send(conn, status: "200 OK", type: "text/plain", body: Data("saved".utf8), headOnly: false)
                } catch {
                    send(conn, status: "500 Internal Server Error", type: "text/plain", body: Data("not saved".utf8), headOnly: false)
                }
            } else if let data = try? Data(contentsOf: file) {
                send(conn, status: "200 OK", type: "application/octet-stream", body: data, headOnly: method == "HEAD")
            } else {
                send(conn, status: "404 Not Found", type: "text/plain", body: Data("No save".utf8), headOnly: false)
            }
            return
        }

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
