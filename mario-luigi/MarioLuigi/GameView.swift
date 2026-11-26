import SwiftUI
import WebKit

/// The whole game is a web page served by `LocalServer` on 127.0.0.1, shown full screen.
struct GameView: View {
    @State private var url: URL?
    @State private var failed = false

    var body: some View {
        ZStack {
            Color(red: 0.08, green: 0.08, blue: 0.086).ignoresSafeArea()
            if let url {
                GameWebView(url: url)
            } else if failed {
                Text("The game could not start. Close the app and open it again.")
                    .foregroundStyle(.white).padding()
            } else {
                ProgressView().tint(.white)
            }
        }
        .task {
            do { url = try await LocalServer.shared.start() } catch { failed = true }
        }
    }
}

struct GameWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()        // keeps the in-game saves and your name
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.08, green: 0.08, blue: 0.086, alpha: 1)
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsLinkPreview = false
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator           // lets the game use the motion sensor (shake = item)
        #if DEBUG
        web.isInspectable = true                    // Safari > Develop on the Mac can look inside
        #endif
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        // If the page ever crashes (memory), load it again instead of showing a blank screen.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

        // Shake the phone to use your item: the game page reads the motion sensor without asking each time.
        func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.grant)
        }
    }
}
