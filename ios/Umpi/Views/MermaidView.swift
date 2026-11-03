import SwiftUI
import UIKit
import WebKit

/// A Mermaid diagram drawn by Pele, Obsidian's MIT-licensed renderer, bundled in the app. Pele runs offline in a small
/// web view with the system's colors and font; the view takes the diagram's height. Nothing is loaded from the network.
struct MermaidView: View {
    let source: String
    @State private var height: CGFloat = 120
    @State private var failed = false

    var body: some View {
        if failed {
            // A diagram Pele cannot draw shows its source, like any code block.
            Text(source).font(.system(.footnote, design: .monospaced)).padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else {
            MermaidWebView(source: source, height: $height, failed: $failed)
                .frame(height: height)
                .frame(maxWidth: .infinity)
                .accessibilityLabel("Diagram")
        }
    }
}

private struct MermaidWebView: UIViewRepresentable {
    let source: String
    @Binding var height: CGFloat
    @Binding var failed: Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "pele")
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.backgroundColor = .clear
        view.navigationDelegate = context.coordinator
        load(view)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        if context.coordinator.loaded != source { load(view) }
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "pele")
    }

    private func load(_ view: WKWebView) {
        guard let script = Bundle.main.url(forResource: "pele.global", withExtension: "js") else { failed = true; return }
        let encoded = (try? JSONEncoder().encode(source)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        // The source is passed as a JSON string; Pele escapes diagram text and filters links and styles.
        let html = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' file:; style-src 'unsafe-inline'; img-src data:">
        <style>
        :root { color-scheme: light dark; --pele-font: -apple-system, system-ui; --pele-radius: 8px;
          --pele-bg: transparent; --pele-fg: #1c1c1e; --pele-muted: #8e8e93; --pele-line: #8e8e93;
          --pele-surface: #f2f2f7; --pele-surface-alt: #e5e5ea; --pele-border: #c6c6c8; --pele-accent: #007aff; }
        @media (prefers-color-scheme: dark) { :root { --pele-fg: #f2f2f7; --pele-muted: #8e8e93; --pele-line: #98989f;
          --pele-surface: #1c1c1e; --pele-surface-alt: #2c2c2e; --pele-border: #38383a; --pele-accent: #0a84ff; } }
        html, body { margin: 0; padding: 0; background: transparent; -webkit-text-size-adjust: 100%; }
        #d { width: 100%; }
        </style>
        <script src="\(script.lastPathComponent)"></script></head><body><div id="d"></div><script>
        const report = () => webkit.messageHandlers.pele.postMessage({ height: Math.ceil(document.getElementById("d").getBoundingClientRect().height) });
        try {
          pele.mount(document.getElementById("d"), \(encoded), { zoom: "auto",
            onRender: () => requestAnimationFrame(report), onError: () => webkit.messageHandlers.pele.postMessage({ failed: true }) });
          new ResizeObserver(report).observe(document.getElementById("d"));
        } catch (e) { webkit.messageHandlers.pele.postMessage({ failed: true }); }
        </script></body></html>
        """
        view.loadHTMLString(html, baseURL: script.deletingLastPathComponent())
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: MermaidWebView
        var loaded: String?
        init(_ parent: MermaidWebView) { self.parent = parent; loaded = parent.source }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            if body["failed"] as? Bool == true { parent.failed = true; return }
            if let height = body["height"] as? Double, height > 0 { parent.height = min(CGFloat(height), 1_200) }
        }
        /// Links in a diagram open outside, never inside this view.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            if action.navigationType == .linkActivated, let url = action.request.url, ["http", "https"].contains(url.scheme) {
                await UIApplication.shared.open(url)
                return .cancel
            }
            return action.navigationType == .other ? .allow : .cancel
        }
    }
}
