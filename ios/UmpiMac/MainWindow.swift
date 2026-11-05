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
            window = make()
            fit(paired: MacApp.shared.store.isPaired)
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
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
        window.title = "Umpi"
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
        window.titleVisibility = paired ? .visible : .hidden
        window.titlebarAppearsTransparent = !paired
        if paired {
            if !window.setFrameUsingName(Self.frameName) {
                window.setContentSize(NSSize(width: 980, height: 720))
                window.center()
            }
            window.setFrameAutosaveName(Self.frameName)
        } else {
            window.setFrameAutosaveName("")
            window.setContentSize(NSSize(width: 520, height: 540))
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

    var body: some View {
        @Bindable var app = app
        Group {
            if store.isPaired {
                NavigationSplitView {
                    List(MacSection.allCases, selection: Binding(get: { app.section }, set: { if let section = $0 { app.section = section } })) { section in
                        Label(section.title, systemImage: section.symbol)
                            .badge(section == .work ? workBadge : 0)
                            .tag(section)
                    }
                    .navigationSplitViewColumnWidth(min: 160, ideal: 190, max: 260)
                    // The connection, quietly, where it is always visible.
                    .safeAreaInset(edge: .bottom) {
                        HStack(spacing: 6) {
                            Circle().fill(app.chat.isLive ? Color.green : Color.secondary.opacity(0.5)).frame(width: 7, height: 7)
                            Text(app.chat.isLive ? "Connected" : "Not connected")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                    }
                } detail: {
                    detail
                }
                .frame(minWidth: 640, minHeight: 480)
            } else {
                pairing
            }
        }
        .environment(\.openVoiceMode) { app.showPanel(.voice) }
        .onChange(of: store.isPaired) { _, paired in app.mainWindow.fit(paired: paired) }
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

    @ViewBuilder private var detail: some View {
        switch app.section {
        case .chat: NavigationStack { ChatView(chat: app.chat) }.id(ObjectIdentifier(app.chat))
        case .today: NavigationStack { TodayView() }
        case .work: NavigationStack { WorkView() }
        case .settings: NavigationStack { MacSettingsView() }
        }
    }
}
