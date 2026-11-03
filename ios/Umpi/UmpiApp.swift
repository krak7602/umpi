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
    @State private var showIdeas = false
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
        .sheet(isPresented: $showIdeas) { NavigationStack { IdeasView() } }
        // Widget buttons and the control open the app through OpenUmpiAction; a request made before this view
        // existed waits in UmpiRoute.
        .onReceive(NotificationCenter.default.publisher(for: UmpiRoute.notification)) { note in
            if let action = note.object as? String { _ = UmpiRoute.take(); route(action) }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active, let action = UmpiRoute.take() { route(action) } }
        .onAppear { if let action = UmpiRoute.take() { route(action) } }
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
    /// Opens one of the widget's actions: chat, today, work, ideas, remind, or idea (record an idea).
    func route(_ action: String) {
        switch action {
        case "chat": selectedTab = 0
        case "today": selectedTab = 1
        case "ideas": showIdeas = true
        case "remind":
            selectedTab = 0
            ChatRequests.shared.draft = "Remind me "
        case "idea", "capture":
            selectedTab = 0
            ChatRequests.shared.capture = true
        default: selectedTab = 2
        }
        Task { await store.synchronize() }
    }
}

/// What the chat should do when it appears or is already showing: start recording an idea, or begin a draft. Kept here
/// rather than sent as a notification, so a chat screen that does not exist yet still gets it.
@MainActor @Observable
final class ChatRequests {
    static let shared = ChatRequests()
    var capture = false
    var draft: String?
}
