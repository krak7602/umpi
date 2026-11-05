import SwiftUI

@main
struct UmpiApp: App {
    @UIApplicationDelegateAdaptor(UmpiAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appDelegate.store)
                .environment(appDelegate.capabilities)
                .environment(appDelegate.t3)
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    while !Task.isCancelled {
                        await appDelegate.synchronize()
                        do { try await Task.sleep(for: .seconds(12)) }
                        catch { return }
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background {
                        appDelegate.scheduleBackgroundRefresh()
                    }
                }
        }
    }
}

private struct RootView: View {
    @Environment(CompanionStore.self) private var store
    @State private var pairingServer = ""
    @State private var pairingCode = ""
    @State private var selectedTab = 0
    @State private var linkMessage: String?
    /// Voice mode over the whole app, opened by a shortcut, widget, control, or link: shown at once, with no slide and
    /// without the chat appearing first. A request already waiting at launch shows it from the first frame.
    @State private var talking = ["voice", "talk", "idea", "capture"].contains(UmpiRoute.peek() ?? "")
    /// False until the app is first in front. While it opens, the app shows a plain screen like the launch screen, not
    /// the chat: iOS hands over a shortcut's or widget's request (such as voice mode) up to a second after it starts
    /// drawing, and always before the app becomes active.
    @State private var opened = false
    @Environment(T3CodeModel.self) private var t3
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if store.isPaired {
                TabView(selection: $selectedTab) {
                    Tab("Chat", systemImage: "bubble.left.and.bubble.right", value: 0) {
                        NavigationStack { ChatView() }
                    }
                    Tab("Today", systemImage: "sun.max", value: 1) {
                        NavigationStack { TodayView() }
                    }
                    Tab("Work", systemImage: "tray.full", value: 2) {
                        NavigationStack { WorkView() }
                    }
                    .badge(t3.needsYou + store.jobs.filter { $0.status == "pending_approval" }.count + store.choices.filter { $0.status == "pending" }.count)
                    Tab("Settings", systemImage: "gear", value: 3) {
                        NavigationStack { SettingsView() }
                    }
                }
            } else {
                NavigationStack {
                    PairingView(server: $pairingServer, code: $pairingCode)
                }
            }
        }
        .overlay {
            if talking && store.isPaired {
                VoiceModeView(onEnd: { talking = false }).transition(.identity)
            } else if !opened {
                Color(.systemBackground).ignoresSafeArea()
            }
        }
        .onAppear { if scenePhase == .active { opened = true } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { opened = true } }
        .onOpenURL { url in
            guard url.scheme == "umpi" else { return }
            if url.host == "pair" {
                guard !store.isPaired else {
                    linkMessage = "This device is already paired. Disconnect in Settings before choosing another coordinator."
                    return
                }
                let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
                pairingServer = items.first(where: { $0.name == "server" })?.value ?? ""
                pairingCode = items.first(where: { $0.name == "code" })?.value ?? ""
            } else {
                route(url.host ?? "work")
            }
        }
        // Widget buttons and the control open the app through OpenUmpiAction; a request made before this view
        // existed waits in UmpiRoute.
        .onReceive(NotificationCenter.default.publisher(for: UmpiRoute.notification)) { note in
            if let action = note.object as? String { _ = UmpiRoute.take(); route(action) }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active, let action = UmpiRoute.take() { route(action) } }
        // The Work badge counts approvals; reading them needs no machine, so it is done on every return to the app.
        .task(id: scenePhase) { if scenePhase == .active, store.isPaired { await t3.loadRequests(store) } }
        .onAppear { if let action = UmpiRoute.take() { route(action) } }
        .modifier(IntentRoutes(route: route))
        .alert("Pairing link", isPresented: Binding(get: { linkMessage != nil }, set: { if !$0 { linkMessage = nil } })) {
            Button("OK", role: .cancel) { linkMessage = nil }
        } message: {
            Text(linkMessage ?? "")
        }
        .task {
            #if DEBUG
            // Test configuration only prefills the real, owner-confirmed pairing form.
            let environment = ProcessInfo.processInfo.environment
            if !store.isPaired {
                pairingServer = environment["UMPI_UI_TEST_ORIGIN"] ?? pairingServer
                pairingCode = environment["UMPI_UI_TEST_CODE"] ?? pairingCode
            }
            #endif
        }
    }
}


extension RootView {
    /// Opens one of the widget's actions: chat, today, work, remind, or voice (voice mode, a spoken conversation).
    func route(_ action: String) {
        switch action {
        case "chat": selectedTab = 0
        case "today": selectedTab = 1
        case "remind":
            selectedTab = 0
            ChatRequests.shared.draft = "Remind me "
        case "voice", "talk", "idea", "capture":
            // Straight to voice mode, no animation: the chat does not show first.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { talking = true }
        default: selectedTab = 2
        }
        Task { await store.synchronize() }
    }
}

/// Routes Umpi's intents as the system delivers them to the scene, before the app comes to the front (iOS 26 and later),
/// so a shortcut or widget opens straight on its destination instead of the screen the app was showing.
private struct IntentRoutes: ViewModifier {
    let route: (String) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .onAppIntentExecution(TalkToUmpiIntent.self) { _ in _ = UmpiRoute.take(); route("talk") }
                .onAppIntentExecution(OpenUmpiAction.self) { intent in _ = UmpiRoute.take(); route(intent.action) }
        } else {
            content
        }
    }
}
