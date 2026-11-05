import Foundation
import Observation
import OSLog
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
    /// The system's own words and code for the last problem, for a tooltip; the message above is the plain version.
    private(set) var errorDetail: String?
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
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            errorMessage = nil
            errorDetail = nil
        } catch {
            let reason = error as NSError
            Logger(subsystem: "Umpi", category: "notifications").error("Authorization failed: \(reason.domain, privacy: .public) \(reason.code, privacy: .public) \(reason.localizedDescription, privacy: .public)")
            errorMessage = Self.notificationProblem(reason, runsFromApplications: Self.runsFromApplications)
            errorDetail = "\(reason.localizedDescription) (\(reason.domain) \(reason.code))"
        }
        _ = await refreshCapabilities()
    }

    /// What the owner can do about a refusal, in plain words. macOS refused a Debug build run from its build folder
    /// without asking, and listed no Umpi in System Settings › Notifications.
    nonisolated static func notificationProblem(_ error: NSError, runsFromApplications: Bool) -> String {
        guard error.domain == UNErrorDomain, error.code == UNError.Code.notificationsNotAllowed.rawValue else {
            return "Notifications could not be turned on. Allow them for Umpi in System Settings › Notifications."
        }
        if !runsFromApplications {
            return "macOS isn't allowing notifications for this copy of Umpi, which runs from outside the Applications folder. Move Umpi to Applications and open it from there."
        }
        return "macOS isn't allowing notifications for Umpi. Allow them in System Settings › Notifications."
    }

    /// Umpi was opened from /Applications or ~/Applications.
    nonisolated static var runsFromApplications: Bool {
        let path = Bundle.main.bundleURL.resolvingSymlinksInPath().path
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix("/Applications/") || path.hasPrefix(home + "/Applications/")
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
