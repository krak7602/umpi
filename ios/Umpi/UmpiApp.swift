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

    var body: some View {
        Group {
            if store.isPaired {
                TabView(selection: $selectedTab) {
                    Tab("Workflows", systemImage: "list.bullet.rectangle", value: 0) {
                        NavigationStack { WorkflowListView() }
                    }
                    Tab("Activity", systemImage: "clock", value: 1) {
                        NavigationStack { ActivityListView() }
                    }
                    Tab("Settings", systemImage: "gear", value: 2) {
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
                selectedTab = 1
                Task { await store.synchronize() }
            }
        }
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
