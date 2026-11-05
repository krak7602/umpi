import Foundation
import Observation
import UserNotifications

/// The Mac's stand-in for the phone's device effects. A Mac takes no device actions: alarms, reminder knocks, and Live
/// Activities stay on the phone. It advertises no capabilities, so Umpi does not target it, and any action that reaches
/// it anyway is acknowledged as unsupported, with nothing done.
@MainActor
@Observable
final class DeviceCapabilities {
    private(set) var pendingReview: [DeviceAction] = []
    private(set) var descriptors: [Capability] = []
    private(set) var errorMessage: String?
    private(set) var permissionSummary = "This Mac takes no device actions"
    private(set) var pushStatus = "This Mac does not use push. It stays connected to the chat while Umpi runs."
    private(set) var backgroundStatus = "Updates arrive while Umpi runs, also with its window closed"
    /// Notifications for Umpi's messages are allowed; nil until checked.
    private(set) var notificationsAllowed: Bool?

    @ObservationIgnored private weak var store: CompanionStore?

    func attach(store: CompanionStore) { self.store = store }

    func refreshCapabilities() async -> [Capability] {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notificationsAllowed = [.authorized, .provisional].contains(settings.authorizationStatus)
        return []
    }

    func requestNotificationPermission() async {
        do { _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) }
        catch { errorMessage = "Notifications could not be turned on. Check System Settings › Notifications." }
        _ = await refreshCapabilities()
    }

    func requestAlarmPermission() async { errorMessage = "Alarms are set on the phone." }

    func registerCurrentState() async {
        let capabilities = await refreshCapabilities()
        guard let store, store.isPaired else { return }
        await store.register(capabilities: capabilities)
    }

    func execute(action: DeviceAction, jobs: [Job]) async -> DeviceEffectOutcome {
        DeviceEffectOutcome(status: "unsupported", result: "This Mac has no adapter for \(action.capability)", retryableWithoutEffect: true)
    }

    func approve(actionID: String) async {}
    func deny(actionID: String) async {}
    func track(jobID: String) async { errorMessage = "Live Activities are on the phone." }
    func updateJobs(_ jobs: [Job]) async {}
}
