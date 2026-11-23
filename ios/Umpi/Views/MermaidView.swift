import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
import WebKit

/// A Mermaid diagram drawn by Pele, Obsidian's MIT-licensed renderer, bundled in the app. Pele runs offline in a small
///
/// The web view is made only when the diagram comes near the visible part of its scroll view; until then the diagram
/// is an empty space of the same size. The height a source was drawn at, or that it could not be drawn, is kept, so a
/// diagram shown again takes its place at once.
struct MermaidView: View {
    let source: String
    @State private var height: CGFloat
    @State private var failed: Bool
    /// The diagram has come near the visible part of its scroll view, so it has a web view.
    @State private var drawn = false
    /// The view was told where it is in its scroll view at least once.
    @State private var placed = false

    /// What is known of a source that was drawn before.
    struct Outcome { var height: CGFloat; var failed: Bool }
    nonisolated static let known = RecentCache<String, Outcome>(limit: 100)

    init(source: String) {
        self.source = source
        let known = MermaidView.known[source]
        _height = State(initialValue: known?.height ?? 120)
        _failed = State(initialValue: known?.failed ?? false)
    }

    var body: some View {
        if failed {
            // A diagram Pele cannot draw shows its source, like any code block.
            Text(source).font(.system(.footnote, design: .monospaced)).padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else {
            Group {
                if drawn { MermaidWebView(source: source, height: $height, failed: $failed) } else { Color.clear }
            }
            .frame(height: height)
            .frame(maxWidth: .infinity)
            .accessibilityLabel("Diagram")
            .onVisibilityInScrollView(margin: 400) { visible in
                placed = true
                if visible, !drawn { drawn = true }
            }
            // If the view is never told its place, the diagram is drawn anyway.
            .task {
                try? await Task.sleep(for: .seconds(2))
                if !placed, !Task.isCancelled { drawn = true }
            }
        }
    }
}

extension View {
    /// Tells whether the view is in the visible part of the scroll view it is in, or within `margin` points of it, at
    /// first and whenever that changes. A view outside a scroll view counts as visible.
    func onVisibilityInScrollView(margin: CGFloat = 0, _ action: @escaping (Bool) -> Void) -> some View {
        onGeometryChange(for: Bool.self) { proxy in
            guard let shown = proxy.bounds(of: .scrollView) else { return true }
            return shown.insetBy(dx: -margin, dy: -margin).intersects(CGRect(origin: .zero, size: proxy.size))
        } action: { visible in
            action(visible)
        }
    }
}

@MainActor private struct MermaidWebView {
    let source: String
    @Binding var height: CGFloat
    @Binding var failed: Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    /// One store for every diagram, kept in memory only: a store for each diagram cost a new one at each drawing.
    private static let store = WKWebsiteDataStore.nonPersistent()

    private func makeView(_ coordinator: Coordinator) -> DiagramWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(coordinator, name: "pele")
        configuration.websiteDataStore = Self.store
        let view = DiagramWebView(frame: .zero, configuration: configuration)
        #if os(iOS)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.backgroundColor = .clear
        #else
        view.setValue(false, forKey: "drawsBackground")
        #endif
        view.navigationDelegate = coordinator
        load(view, coordinator)
        return view
    }

    /// Loads the source when the view does not show it yet.
    private func update(_ view: WKWebView, _ coordinator: Coordinator) {
        coordinator.parent = self
        if coordinator.loaded != source { load(view, coordinator) }
    }

    private func load(_ view: WKWebView, _ coordinator: Coordinator) {
        coordinator.loaded = source
        guard let script = Bundle.main.url(forResource: "pele.global", withExtension: "js") else { failed = true; return }
        let encoded = (try? JSONEncoder().encode(source)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        // The source is passed as a JSON string; Pele escapes diagram text and filters links and styles.
        let html = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' file:; style-src 'unsafe-inline'; img-src data:">
        <style>
        /* Styled after Freeform: soft tinted shapes without outlines, a light shadow, smooth curved connectors. */
        :root { color-scheme: light dark; --pele-font: -apple-system, system-ui; --pele-radius: 12px;
          --pele-bg: transparent; --pele-fg: #1c1c1e; --pele-muted: #6e6e73; --pele-line: #aeaeb2;
          --pele-surface: #e8f1ff; --pele-surface-alt: #f2f2f7; --pele-border: transparent; --pele-accent: #007aff;
          --pele-series-1: #007aff; --pele-series-2: #34c759; --pele-series-3: #ff9500; --pele-series-4: #af52de;
          --pele-series-5: #ff2d55; --pele-series-6: #5ac8fa; --pele-series-7: #ffcc00; --pele-series-8: #8e8e93;
          --shadow: drop-shadow(0 1px 1.5px rgba(0,0,0,.06)) drop-shadow(0 3px 8px rgba(0,0,0,.07)); }
        @media (prefers-color-scheme: dark) { :root { --pele-fg: #f2f2f7; --pele-muted: #98989f; --pele-line: #636366;
          --pele-surface: #1d2a3d; --pele-surface-alt: #2c2c2e; --pele-accent: #0a84ff;
          --shadow: drop-shadow(0 1px 2px rgba(0,0,0,.5)); } }
        html, body { margin: 0; padding: 0; background: transparent; -webkit-text-size-adjust: 100%; }
        #d { width: 100%; display: flex; justify-content: center; }
        .pele-node > rect, .pele-node > path, .pele-node > polygon, .pele-node > circle, .pele-node > ellipse,
        .pele-cluster > rect { stroke: none !important; filter: var(--shadow); }
        .pele-cluster > rect { fill: var(--pele-surface-alt) !important; filter: none; }
        /* Diamonds and other pointed shapes get soft corners: a stroke in the fill colour, joined round. */
        .pele-node > polygon, .pele-node > path { stroke: var(--pele-surface) !important; stroke-width: 9px !important; stroke-linejoin: round; paint-order: stroke; }
        /* Arrowheads: rounded tips and corners, a touch smaller. */
        .pele-marker { stroke: var(--pele-line); stroke-width: 1.5px; stroke-linejoin: round; stroke-linecap: round; }
        .pele-edge path, .pele-edges path { stroke-width: 1.6px !important; stroke-linecap: round; stroke-linejoin: round; }
        .pele-label, .pele-title, .pele-edge-label { font-family: -apple-system, system-ui; }
        .pele-title { font-weight: 600; }
        </style>
        <script src="\(script.lastPathComponent)"></script></head><body><div id="d"></div><script>
        const report = () => webkit.messageHandlers.pele.postMessage({ height: Math.ceil(document.getElementById("d").getBoundingClientRect().height) });
        try {
          pele.mount(document.getElementById("d"), \(encoded), { zoom: "auto", fontSize: 15, padding: 12, config: { flowchart: { curve: "basis" } },
            onRender: () => requestAnimationFrame(report), onError: () => webkit.messageHandlers.pele.postMessage({ failed: true }) });
          new ResizeObserver(report).observe(document.getElementById("d"));
        } catch (e) { webkit.messageHandlers.pele.postMessage({ failed: true }); }
        </script></body></html>
        """
        view.loadHTMLString(html, baseURL: script.deletingLastPathComponent())
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: MermaidWebView
        /// The source the web view shows, or is loading.
        var loaded: String?
        init(_ parent: MermaidWebView) { self.parent = parent }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            if body["failed"] as? Bool == true {
                MermaidView.known.set(.init(height: parent.height, failed: true), for: parent.source)
                parent.failed = true
                return
            }
            if let reported = body["height"] as? Double, reported > 0 {
                let height = min(CGFloat(reported), 1_200)
                MermaidView.known.set(.init(height: height, failed: false), for: parent.source)
                if parent.height != height { parent.height = height }
            }
        }
        /// Links in a diagram open outside, never inside this view.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            if action.navigationType == .linkActivated, let url = action.request.url, ["http", "https"].contains(url.scheme) {
                await openOutside(url)
                return .cancel
            }
            return action.navigationType == .other ? .allow : .cancel
        }
    }
}

#if os(iOS)
private typealias DiagramWebView = WKWebView

extension MermaidWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { makeView(context.coordinator) }

    func updateUIView(_ view: WKWebView, context: Context) {
        update(view, context.coordinator)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "pele")
    }
}
#else
/// A diagram does not scroll; the wheel scrolls the conversation around it.
private final class DiagramWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) { nextResponder?.scrollWheel(with: event) }
}

extension MermaidWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> DiagramWebView { makeView(context.coordinator) }

    func updateNSView(_ view: DiagramWebView, context: Context) {
        update(view, context.coordinator)
    }

    static func dismantleNSView(_ view: DiagramWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "pele")
    }
}
#endif
