import AppKit
import Observation
import SwiftUI

/// The floating chat: a panel over every app, on every Space and over full-screen apps, opened by a global shortcut.
/// It does not bring Umpi to the front, so the app the owner was in stays active underneath. One shortcut opens it on
/// the chat, the other in voice mode; the same shortcut again, Esc, or its close button hides it.
@MainActor
final class ChatPanelController: NSObject, NSWindowDelegate {
    enum Mode: Equatable { case chat, voice }

    @MainActor @Observable final class State {
        var mode = Mode.chat
    }

    let state = State()
    private var panel: ChatPanel?
    private var escapeMonitor: Any?

    var isVisible: Bool { panel?.isVisible == true }

    /// The shortcut's action: hides the panel when it already shows this mode; otherwise shows it in this mode.
    func toggle(_ mode: Mode) {
        if isVisible, state.mode == mode { hide() } else { show(mode) }
    }

    func show(_ mode: Mode) {
        let panel = self.panel ?? make()
        self.panel = panel
        state.mode = mode
        if !panel.isVisible { place(panel) }
        panel.orderFrontRegardless()
        panel.makeKey()
        if mode == .chat { focusComposer(in: panel) }
    }

    func hide() {
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
        didHide()
    }

    /// Voice mode ends with the panel: what was heard is still sent, and the microphone stops.
    private func didHide() {
        if state.mode == .voice { state.mode = .chat }
    }

    func windowWillClose(_ notification: Notification) { didHide() }

    private func make() -> ChatPanel {
        let app = MacApp.shared
        let content = ChatPanelView(controller: self)
            .environment(app)
            .environment(app.store)
            .environment(app.capabilities)
            .environment(app.t3)
        let panel = ChatPanel(showing: content)
        panel.delegate = self
        panel.setFrameAutosaveName("UmpiPanelFrame")
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self, weak panel] event in
            // Esc hides the panel; a sheet or menu over it takes its own Esc first.
            guard event.keyCode == 53, let panel, event.window === panel, panel.attachedSheet == nil else { return event }
            MainActor.assumeIsolated { self?.hide() }
            return nil
        }
        return panel
    }

    /// On the screen with the pointer: where it was last time if that is on this screen, otherwise top centre.
    private func place(_ panel: ChatPanel) {
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        var frame = panel.frame
        // A remembered size stays within the panel's limits.
        frame.size.width = min(max(frame.width, ChatPanel.smallest.width), ChatPanel.largest.width)
        frame.size.height = min(max(frame.height, ChatPanel.smallest.height), ChatPanel.largest.height)
        if !visible.intersects(frame) || !visible.contains(NSPoint(x: frame.midX, y: frame.midY)) {
            frame.origin = NSPoint(x: visible.midX - frame.width / 2, y: visible.maxY - frame.height - visible.height * 0.08)
        }
        panel.setFrame(frame, display: false)
    }

    private func focusComposer(in panel: NSPanel) {
        DispatchQueue.main.async {
            guard let field = Self.composer(in: panel.contentView) else { return }
            panel.makeFirstResponder(field)
        }
    }

    private static func composer(in view: NSView?) -> NSView? {
        guard let view else { return nil }
        if view is ComposerNSTextView { return view }
        for child in view.subviews { if let found = composer(in: child) { return found } }
        return nil
    }
}

/// A non-activating floating panel that can take typing without bringing Umpi to the front. The title bar is hidden;
/// the panel's own header has the close button and moves the panel.
final class ChatPanel: NSPanel {
    static let defaultSize = NSSize(width: 400, height: 600)
    static let smallest = NSSize(width: 340, height: 440)
    static let largest = NSSize(width: 720, height: 1_100)

    init(contentRect: NSRect) {
        super.init(contentRect: contentRect, styleMask: [.titled, .resizable, .fullSizeContentView, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        // Every Space, and over full-screen apps.
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { standardWindowButton(button)?.isHidden = true }
        contentMinSize = Self.smallest
        contentMaxSize = Self.largest
        animationBehavior = .utilityWindow
    }

    /// A panel showing `content` at the default size.
    convenience init(showing content: some View) {
        self.init(contentRect: NSRect(origin: .zero, size: Self.defaultSize))
        let hosting = NSHostingController(rootView: content)
        // SwiftUI sets only the smallest size; the owner sizes the panel.
        hosting.sizingOptions = [.minSize]
        contentViewController = hosting
        setContentSize(Self.defaultSize)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// What the panel shows, from the top: its header, then the chat with its message field, or voice mode.
struct ChatPanelView: View {
    let controller: ChatPanelController
    @Environment(MacApp.self) private var app
    @Environment(CompanionStore.self) private var store

    var body: some View {
        let state = controller.state
        VStack(spacing: 0) {
            // Solid and above the chat, so messages never scroll through it.
            header(state)
                .background(Color(nsColor: .windowBackgroundColor))
                .zIndex(1)
            Divider()
            Group {
                if !store.isPaired {
                    ContentUnavailableView {
                        Label("Umpi is not paired", systemImage: "link")
                    } description: {
                        Text("Pair this Mac in the Umpi window first.")
                    } actions: {
                        Button("Open Umpi") { app.showMain() }
                    }
                } else if state.mode == .voice {
                    VoiceModeView(onEnd: { state.mode = .chat })
                } else {
                    // The header has the panel's controls; the chat's own toolbar items would sit on top of it.
                    ChatView(chat: app.chat).id(ObjectIdentifier(app.chat))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // The chat stays inside its own area, below the header.
            .clipped()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // The header takes the hidden title bar's place.
        .ignoresSafeArea(.container, edges: .top)
        .environment(\.openVoiceMode) { state.mode = .voice }
        .frame(minWidth: ChatPanel.smallest.width, minHeight: ChatPanel.smallest.height)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    /// Close, the name and connection, and the main window; dragging it moves the panel.
    private func header(_ state: ChatPanelController.State) -> some View {
        HStack(spacing: 8) {
            Button { controller.hide() } label: { Image(systemName: "xmark") }
                .buttonStyle(PanelHeaderButtonStyle())
                .help("Hide (Esc)")
                .accessibilityLabel("Hide")
            HStack(spacing: 6) {
                Text("Umpi").font(.system(size: 13, weight: .semibold))
                // The connection shows only when it is down.
                if store.isPaired, app.chat.isOffline {
                    Image(systemName: "wifi.slash")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .help("Not connected")
                        .accessibilityLabel("Not connected")
                }
            }
            Spacer()
            Button { app.showMain(.chat) } label: { Image(systemName: "macwindow") }
                .buttonStyle(PanelHeaderButtonStyle())
                .help("Open the Umpi window")
                .accessibilityLabel("Open the Umpi window")
        }
        .padding(.horizontal, 8)
        .frame(height: 40)
        .contentShape(Rectangle())
        .gesture(WindowDragGesture())
    }
}

/// A header control as Mac toolbars draw them: a clear symbol in a 28 pt square that is highlighted under the pointer
/// and darker while pressed.
struct PanelHeaderButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Highlighted(configuration: configuration)
    }

    private struct Highlighted: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.system(size: 13, weight: .semibold))
                .imageScale(.medium)
                .foregroundStyle(isEnabled ? (hovering ? Color.primary : Color.secondary) : Color.secondary.opacity(0.5))
                .frame(width: 28, height: 28)
                .background {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.primary.opacity(configuration.isPressed ? 0.16 : hovering ? 0.08 : 0))
                }
                .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .onHover { hovering = isEnabled && $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
        }
    }
}
