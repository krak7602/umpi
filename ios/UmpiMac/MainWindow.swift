import AppKit
import SwiftUI

/// The main window: the phone's tabs as a sidebar. It is an AppKit window so the menu bar item, the panel, and
/// notifications can open it at any time. Closing it leaves Umpi in the menu bar only, without a Dock icon.
@MainActor
final class MainWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?

    var isKey: Bool { window?.isVisible == true && window?.isKeyWindow == true }

    func show() {
        NSApp.setActivationPolicy(.regular)
        if window == nil {
            let app = MacApp.shared
            app.windowPaired = app.store.isPaired
            window = make()
            fit(paired: app.windowPaired)
        }
        // A chat laid out while the window was off screen can keep stale text sizes (lines clipped inside bubbles), so
        // it is built afresh whenever the window comes back, as switching sections does.
        if window?.isVisible != true { MacApp.shared.windowShows += 1 }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// Puts the cursor in the chat's message field, once the chat shows. The field may appear a moment after the
    /// section changes, so it is looked for a few times.
    func focusComposer(attempt: Int = 0) {
        guard let window else { return }
        if let field = Self.composer(in: window.contentView) {
            window.makeFirstResponder(field)
        } else if attempt < 10 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.focusComposer(attempt: attempt + 1) }
        }
    }

    private static func composer(in view: NSView?) -> NSView? {
        guard let view else { return nil }
        if view is ComposerNSTextView { return view }
        for child in view.subviews { if let found = composer(in: child) { return found } }
        return nil
    }

    private func make() -> NSWindow {
        let app = MacApp.shared
        let root = MacRootView()
            .environment(app)
            .environment(app.store)
            .environment(app.capabilities)
            .environment(app.t3)
        let hosting = NSHostingController(rootView: root)
        hosting.sceneBridgingOptions = [.toolbars, .title]
        // SwiftUI sets only the smallest size; the owner sizes the window.
        hosting.sizingOptions = [.minSize]
        let window = NSWindow(contentViewController: hosting)
        // The shown section's title replaces this once SwiftUI bridges it; the first one is set here, as bridging does
        // not overwrite a title set after the window is made.
        window.title = app.windowPaired ? app.section.title : "Umpi"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window.toolbarStyle = .unified
        window.isReleasedWhenClosed = false
        window.delegate = self
        return window
    }

    /// Before pairing, a small window with only the pairing form and no toolbar; once paired, the full window with the
    /// sidebar, where the owner left it last time.
    func fit(paired: Bool) {
        guard let window else { return }
        style(window, paired: paired)
        resize(window, paired: paired)
    }

    /// Pairing or disconnecting while the window shows: the window takes its new size first and the content changes on
    /// the next turn of the run loop, so the sidebar is never laid out in the small pairing window. Disconnecting
    /// lowers the sidebar's minimum size first, so the window can shrink before the pairing form replaces it.
    func transition(paired: Bool) {
        let app = MacApp.shared
        guard paired != app.windowPaired else { return }
        guard let window, window.isVisible else {
            app.windowPaired = paired
            fit(paired: paired)
            return
        }
        if !paired { window.contentMinSize = Self.pairingSize }
        resize(window, paired: paired)
        DispatchQueue.main.async { [weak self] in
            app.windowPaired = paired
            self?.style(window, paired: paired)
        }
    }

    /// The pairing window's content size; the pairing form's smallest size fits inside it.
    static let pairingSize = NSSize(width: 520, height: 540)

    private func style(_ window: NSWindow, paired: Bool) {
        window.titleVisibility = paired ? .visible : .hidden
        window.titlebarAppearsTransparent = !paired
    }

    private func resize(_ window: NSWindow, paired: Bool) {
        if paired {
            if !window.setFrameUsingName(Self.frameName) {
                window.setContentSize(NSSize(width: 980, height: 720))
                window.center()
            }
            window.setFrameAutosaveName(Self.frameName)
        } else {
            window.setFrameAutosaveName("")
            window.setContentSize(Self.pairingSize)
            window.center()
        }
    }

    private static let frameName = "UmpiMain"

    func windowWillClose(_ notification: Notification) {
        // Only the menu bar item remains; the panel and the shortcuts keep working.
        NSApp.setActivationPolicy(.accessory)
    }
}

/// The phone's tabs in a sidebar: Chat, Today, Work, and Settings. Before pairing, the pairing form.
struct MacRootView: View {
    @Environment(MacApp.self) private var app
    @Environment(CompanionStore.self) private var store
    @Environment(T3CodeModel.self) private var t3
    @State private var showModels = false

    var body: some View {
        @Bindable var app = app
        Group {
            // The window's layout follows the pairing once the window has its new size; see `transition(paired:)`.
            if app.windowPaired {
                NavigationSplitView {
                    List(selection: Binding(get: { app.section }, set: { if let section = $0 { app.section = section } })) {
                        ForEach(MacSection.allCases) { section in
                            Label(section.title, systemImage: section.symbol)
                                .badge(section == .work ? workBadge : 0)
                                .help("\(section.title) (⌘\u{2009}\(section.number))")
                                .tag(section)
                        }
                    }
                    .listStyle(.sidebar)
                    .navigationSplitViewColumnWidth(min: 170, ideal: 200, max: 280)
                    // The connection, quietly, only when it is down.
                    .safeAreaInset(edge: .bottom) {
                        VStack(alignment: .leading, spacing: 0) {
                            // The voice models, the same way, while they download or prepare (such as after an update).
                            if VoiceModelStatus.shared.showing {
                                Button { showModels = true } label: {
                                    Label { Text(VoiceModelStatus.shared.summary).monospacedDigit() } icon: { VoiceModelIcon() }
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .help("Voice models")
                                .popover(isPresented: $showModels, arrowEdge: .trailing) { VoiceModelsPopover() }
                                .padding(.horizontal, 16).padding(.vertical, 10)
                            }
                            if app.chat.isOffline {
                                Label("Not connected", systemImage: "wifi.slash")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 16).padding(.vertical, 10)
                            }
                        }
                    }
                } detail: {
                    detail
                        // Every section keeps the full toolbar, also one with no buttons of its own (Chat, Settings), so
                        // the title bar keeps its height and the sidebar does not move when the section changes.
                        .toolbar { ToolbarSpacer(.flexible) }
                }
                .frame(minWidth: 640, minHeight: 480)
            } else {
                pairing
            }
        }
        .environment(\.openVoiceMode) { app.showPanel(.voice) }
        .onChange(of: store.isPaired) { _, paired in app.mainWindow.transition(paired: paired) }
        // The Work badge counts approvals; reading them needs no machine, so it is done whenever the window opens.
        .task { if store.isPaired { await t3.loadRequests(store) } }
        .onChange(of: app.section) { _, _ in Task { await store.synchronize() } }
        .task {
            #if DEBUG
            // Test configuration only prefills the real, owner-confirmed pairing form.
            let environment = ProcessInfo.processInfo.environment
            if !store.isPaired {
                app.pairingServer = environment["UMPI_UI_TEST_ORIGIN"] ?? app.pairingServer
                app.pairingCode = environment["UMPI_UI_TEST_CODE"] ?? app.pairingCode
            }
            #endif
        }
    }

    /// Before pairing: only the form, centred, under the app's name; no sidebar and no toolbar.
    private var pairing: some View {
        @Bindable var app = app
        return VStack(spacing: 0) {
            VStack(spacing: 6) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 64, height: 64)
                Text("Pair Umpi").font(.title2.weight(.semibold))
                Text("On your phone: Settings › Server › Pair another device.").font(.callout).foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.center)
            .padding(.top, 40)
            .padding(.horizontal, 24)
            PairingView(server: $app.pairingServer, code: $app.pairingCode)
                .formStyle(.grouped)
                .scrollContentBackground(.hidden)
        }
        .frame(minWidth: 460, idealWidth: 520, maxWidth: .infinity, minHeight: 480, maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
        .ignoresSafeArea(.container, edges: .top)
        .toolbar(.hidden, for: .windowToolbar)
    }

    private var workBadge: Int {
        t3.needsYou + store.jobs.filter { $0.status == "pending_approval" }.count + store.choices.filter { $0.status == "pending" }.count
    }

    /// Each section in its own stack, so its title shows in the window's toolbar and its pages push there. Forms are
    /// grouped, as in Mac settings, instead of the Mac's default two-column form.
    @ViewBuilder private var detail: some View {
        Group {
            switch app.section {
            case .chat: NavigationStack { ChatView(chat: app.chat) }.id("\(ObjectIdentifier(app.chat).hashValue)-\(app.windowShows)")
            case .today: NavigationStack { TodayView() }
            case .work: NavigationStack { WorkView() }
            case .settings: NavigationStack { MacSettingsView() }
            }
        }
        .formStyle(.grouped)
    }
}
