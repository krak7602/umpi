import AppKit
import Observation
import ServiceManagement
import SwiftUI
import UserNotifications

/// The main window's sections, as the phone's tabs.
enum MacSection: String, CaseIterable, Identifiable {
    case chat, today, work, settings
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    /// Its place in the sidebar, which is also its Command-key shortcut.
    var number: Int { (Self.allCases.firstIndex(of: self) ?? 0) + 1 }
    var symbol: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .today: "sun.max"
        case .work: "tray.full"
        case .settings: "gear"
        }
    }
}

/// The Mac app's state, made once at launch and kept while it runs, also with every window closed: the pairing, one
/// live chat shared by the main window and the floating panel, the shortcuts, and notifications for Umpi's messages.
@MainActor @Observable
final class MacApp {
    static let shared = MacApp()

    let store: CompanionStore
    let capabilities = DeviceCapabilities()
    let t3 = T3CodeModel()
    /// One chat for every place it shows; replaced when the Mac is disconnected, so nothing of the old pairing remains.
    private(set) var chat = ChatModel()
    var section: MacSection = .chat
    /// Whether the main window shows the paired layout (sidebar) or the pairing form. It follows `store.isPaired`
    /// only after the window has been resized for the new layout.
    var windowPaired = false
    /// Counts the times the window came back on screen; the chat is laid out afresh each time.
    var windowShows = 0
    /// Voice mode shows in the main window's Chat, in place of the chat, started from there.
    var mainTalking = false
    /// Shortcuts the system refused, such as one another app already uses.
    private(set) var refusedShortcuts: Set<ShortcutSettings.Action> = []
    private(set) var launchAtLogin = SMAppService.mainApp.status == .enabled
    /// Quitting from the window (Command-Q, the app or Dock menu) only closes it; Umpi stays in the menu bar. Quit
    /// Umpi in the menu bar item always quits.
    var keepRunningWhenQuit = UserDefaults.standard.object(forKey: "mac.keepRunningWhenQuit") as? Bool ?? true {
        didSet { UserDefaults.standard.set(keepRunningWhenQuit, forKey: "mac.keepRunningWhenQuit") }
    }
    /// Set by the menu bar item's Quit Umpi: this quit is meant.
    @ObservationIgnored var quittingForReal = false

    func quitCompletely() {
        quittingForReal = true
        NSApp.terminate(nil)
    }

    /// Closes the window and the panel; Umpi keeps running in the menu bar.
    func runInBackground() {
        panel.hide()
        NSApp.windows.filter { $0.isVisible && !($0 is NSPanel) }.forEach { $0.performClose(nil) }
        NSApp.setActivationPolicy(.accessory)
    }
    private(set) var launchAtLoginProblem: String?

    @ObservationIgnored let panel = ChatPanelController()
    @ObservationIgnored let mainWindow = MainWindowController()
    @ObservationIgnored private var hotKeys: HotKeys?
    @ObservationIgnored private var started = false
    /// The newest chat position already seen; Umpi's messages after it are announced.
    @ObservationIgnored private var announcedThrough: Int?
    @ObservationIgnored private var askedForNotifications = false

    init(store: CompanionStore = CompanionStore()) {
        self.store = store
        windowPaired = store.isPaired
    }

    func start(showWindow: Bool) {
        guard !started else { return }
        started = true
        // After an install or update, voice models are compiled again; start now rather than in voice mode.
        VoiceModelWarmup.run()
        // Umpi starts with the Mac unless the owner turned that off: on by default, once, from an installed copy.
        if !UserDefaults.standard.bool(forKey: "mac.launchAtLoginDefaulted"), Bundle.main.bundlePath.hasPrefix("/Applications/") {
            UserDefaults.standard.set(true, forKey: "mac.launchAtLoginDefaulted")
            if SMAppService.mainApp.status != .enabled { setLaunchAtLogin(true) }
        }
        capabilities.attach(store: store)
        store.configureEffects(capabilities: { [weak capabilities] in
            await capabilities?.refreshCapabilities() ?? []
        }, execute: { [weak capabilities, weak store] action in
            guard let capabilities, let store else { return DeviceEffectOutcome(status: "pending", result: "Device runtime is not attached") }
            return await capabilities.execute(action: action, jobs: store.jobs)
        })
        let keys = HotKeys()
        keys.onPress = { [weak self] action in self?.panel.toggle(action == .voice ? .voice : .chat) }
        hotKeys = keys
        refusedShortcuts = Set(keys.registerSaved())
        if showWindow { showMain() }
        Task { await keepSynchronized() }
        Task { await keepChatLive() }
        watchChat()
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.store.isPaired else { return }
                Task { await self.synchronize(); await self.t3.loadRequests(self.store) }
            }
        }
    }

    // MARK: Windows

    func showMain(_ section: MacSection? = nil) {
        if let section { self.section = section }
        mainWindow.show()
    }

    /// One voice conversation at a time: voice mode in the panel ends the main window's.
    func showPanel(_ mode: ChatPanelController.Mode) {
        if mode == .voice { mainTalking = false }
        panel.show(mode)
    }

    /// Voice mode in the main window, from its chat's waveform button; ends the panel's.
    func talkInMain() {
        if panel.state.mode == .voice { panel.state.mode = .chat }
        section = .chat
        mainTalking = true
    }

    /// Command-N: the chat in the main window, ready to type.
    func newMessage() {
        showMain(.chat)
        mainWindow.focusComposer()
    }

    // MARK: Staying up to date

    /// The phone synchronizes every 12 seconds while it is open. The Mac keeps that pace while Umpi is in front or the
    /// panel shows, and slows to once a minute otherwise; the chat itself arrives through its socket at once.
    private func keepSynchronized() async {
        while !Task.isCancelled {
            await synchronize()
            let busy = NSApp.isActive || panel.isVisible
            try? await Task.sleep(for: .seconds(busy ? 12 : 60))
        }
    }

    func synchronize() async {
        guard store.isPaired else { return }
        if !askedForNotifications {
            askedForNotifications = true
            await capabilities.requestNotificationPermission()
        }
        await capabilities.registerCurrentState()
        await store.synchronize()
    }

    /// The chat's socket stays open while Umpi runs, so its messages arrive and can be announced with the window closed.
    private func keepChatLive() async {
        // After sleep the old connection is usually dead: open a new one at once rather than waiting for a ping.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { MacApp.shared.chat.reconnect() }
        }
        while !Task.isCancelled {
            if store.isPaired { await chat.stayLive(store) }
            if !store.isPaired, announcedThrough != nil || !chat.entries.isEmpty {
                // Disconnected: nothing of the old conversation stays in memory.
                chat = ChatModel()
                announcedThrough = nil
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    // MARK: Notifications

    private func watchChat() {
        withObservationTracking { _ = chat.entries } onChange: { [weak self] in
            Task { @MainActor in
                self?.announceNewMessages()
                self?.watchChat()
            }
        }
    }

    /// The chat is on screen: the panel shows, or the main window is in front on the chat.
    var chatIsVisible: Bool {
        panel.isVisible || (NSApp.isActive && section == .chat && mainWindow.isKey)
    }

    private func announceNewMessages() {
        // The first read after launch sets where new messages start, so old ones are not announced.
        guard chat.hasRefreshed else { return }
        let entries = chat.entries
        guard let baseline = announcedThrough else {
            announcedThrough = ChatNotices.baseline(nil, seqs: entries.map(\.seq))
            return
        }
        let fresh = ChatNotices.fresh(entries, after: baseline, seq: \.seq, role: \.role, id: \.id)
        announcedThrough = ChatNotices.baseline(baseline, seqs: entries.map(\.seq))
        guard !fresh.isEmpty, !chatIsVisible else { return }
        for entry in fresh.suffix(3) {
            let content = UNMutableNotificationContent()
            content.title = "Umpi"
            content.body = ChatNotices.preview(entry.text)
            if content.body.isEmpty { content.body = "New message" }
            content.sound = .default
            content.threadIdentifier = "chat"
            content.userInfo = ["chat": entry.seq]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "chat.\(entry.seq)", content: content, trigger: nil))
        }
    }

    // MARK: Settings

    func setShortcut(_ shortcut: Shortcut?, for action: ShortcutSettings.Action) {
        ShortcutSettings.set(shortcut, for: action)
        guard let hotKeys else { return }
        if hotKeys.register(shortcut, for: action) { refusedShortcuts.remove(action) } else { refusedShortcuts.insert(action) }
    }

    /// Recording a shortcut: the current ones are off until it ends.
    func recordingShortcut(_ recording: Bool) {
        guard let hotKeys else { return }
        if recording { hotKeys.pause() } else { refusedShortcuts = Set(hotKeys.registerSaved()) }
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            launchAtLoginProblem = nil
        } catch {
            launchAtLoginProblem = enabled
                ? "macOS did not add Umpi to Login Items. Add it in System Settings › General › Login Items."
                : "macOS did not remove Umpi from Login Items. Remove it in System Settings › General › Login Items."
        }
        launchAtLogin = SMAppService.mainApp.status == .enabled
        if SMAppService.mainApp.status == .requiresApproval {
            launchAtLoginProblem = "Allow Umpi in System Settings › General › Login Items."
        }
    }

    // MARK: Links

    /// `umpi://pair?server=&code=` fills the pairing form; `umpi://chat`, `talk`, `today`, `work`, and `remind` open
    /// those places, as on the phone.
    var pairingServer = ""
    var pairingCode = ""

    func open(_ url: URL) {
        guard url.scheme == "umpi" else { return }
        switch url.host ?? "" {
        case "pair":
            guard !store.isPaired else { showMain(.settings); return }
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            pairingServer = items.first { $0.name == "server" }?.value ?? ""
            pairingCode = items.first { $0.name == "code" }?.value ?? ""
            showMain()
        case "talk", "voice", "idea", "capture": showPanel(.voice)
        case "chat": showPanel(.chat)
        case "remind": ChatRequests.shared.draft = "Remind me "; showPanel(.chat)
        case "today": showMain(.today)
        default: showMain(.work)
        }
    }
}

/// Launch, the Dock icon, links, and clicks on notifications.
final class MacAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        // Opened at login, Umpi starts in the menu bar only; opened by the owner, it shows its window.
        let event = NSAppleEventManager.shared().currentAppleEvent
        let atLogin = event?.eventID == kAEOpenApplication && event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
        MainActor.assumeIsolated {
            if atLogin { NSApp.setActivationPolicy(.accessory) }
            MacApp.shared.start(showWindow: !atLogin)
        }
    }

    /// Closing the window keeps Umpi in the menu bar, with the chat connected and the shortcuts working.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Quitting from the window keeps Umpi running in the menu bar, when the owner chose that. Logging out, restarting,
    /// and shutting down always quit, as does Quit Umpi in the menu bar item.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let reason = NSAppleEventManager.shared().currentAppleEvent?.attributeDescriptor(forKeyword: kAEQuitReason)?.enumCodeValue
        let systemQuit = reason.map { [kAELogOut, kAEReallyLogOut, kAEShowRestartDialog, kAERestart, kAEShowShutdownDialog, kAEShutDown].map { OSType($0) }.contains($0) } ?? false
        return MainActor.assumeIsolated {
            let app = MacApp.shared
            if systemQuit || app.quittingForReal || !app.keepRunningWhenQuit { return .terminateNow }
            app.runInBackground()
            return .terminateCancel
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        MainActor.assumeIsolated { MacApp.shared.showMain() }
        return false
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        MainActor.assumeIsolated { urls.forEach(MacApp.shared.open) }
    }

    /// In front, Umpi's messages are announced unless the chat is on screen.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let visible = await MainActor.run { MacApp.shared.chatIsVisible }
        return visible ? [] : [.banner, .list, .sound]
    }

    /// A click on a message opens the chat in the main window.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run { MacApp.shared.showMain(.chat) }
    }
}
