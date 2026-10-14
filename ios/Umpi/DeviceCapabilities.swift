import ActivityKit
import AlarmKit
import CryptoKit
import Foundation
import Observation
import SwiftUI
import UIKit
import UserNotifications

/// A receipt is written before returning an outcome to the sync engine. An interrupted
/// OS call is observed, never blindly retried: delivery is not an exactly-once API.
struct EffectReceipt: Codable, Equatable {
    var status: String
    var result: String
    var retryableWithoutEffect: Bool? = nil
}

struct EffectIntent: Codable, Equatable {
    var fingerprint: String
    var phase: String = "prepared"
    var approved: Bool = false
    var action: DeviceAction?
    var target: String?
    var registrationID: String?
    var observedAt: Date?
    var receipt: EffectReceipt?
}

@MainActor
final class EffectLedger {
    private let url: URL
    private(set) var entries: [String: EffectIntent]

    init(url: URL) throws {
        self.url = url
        if FileManager.default.fileExists(atPath: url.path) {
            entries = try JSONDecoder().decode([String: EffectIntent].self, from: Data(contentsOf: url))
        } else {
            entries = [:]
        }
    }

    func entry(key: String, fingerprint: String) throws -> EffectIntent? {
        guard let entry = entries[key] else { return nil }
        guard entry.fingerprint == fingerprint else { throw EffectError.reusedID }
        return entry
    }

    func save(_ entry: EffectIntent, key: String) throws {
        if let existing = entries[key], existing.fingerprint != entry.fingerprint {
            throw EffectError.reusedID
        }
        var next = entries
        next[key] = entry
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try JSONEncoder().encode(next).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var protectedURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protectedURL.setResourceValues(values)
        entries = next
    }

    static func fingerprint(_ action: DeviceAction) throws -> String {
        struct Request: Encodable {
            var deviceId: String
            var capability: String
            var input: [String: FieldValue]
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(Request(deviceId: action.deviceId, capability: action.capability, input: action.input))
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}

private enum EffectError: Error {
    case reusedID
    case invalidInput
    case notObserved
}

@available(iOS 26.0, *)
private struct UmpiAlarmMetadata: AlarmMetadata {
    var actionID: String
}

@MainActor
@Observable
final class DeviceCapabilities {
    private(set) var pendingReview: [DeviceAction] = []
    private(set) var descriptors: [Capability] = []
    private(set) var errorMessage: String?
    private(set) var permissionSummary = "Checking device permissions"
    private(set) var pushStatus = "Push registration has not completed"
    private(set) var backgroundStatus = "Background refresh is opportunistic, not guaranteed"

    @ObservationIgnored private weak var store: CompanionStore?
    @ObservationIgnored private var ledger: EffectLedger?
    @ObservationIgnored private var activeTargets: Set<String> = []
    @ObservationIgnored private var tokenTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var alarmObservation: Task<Void, Never>?
    @ObservationIgnored private var permissionObservation: Task<Void, Never>?
    @ObservationIgnored private var apnsToken: String?
    @ObservationIgnored private var apnsEnvironment: String?

    init(ledgerURL: URL? = nil) {
        do {
            let url = try ledgerURL ?? FileManager.default.url(for: .applicationSupportDirectory,
                in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("Umpi/effect-receipts.json")
            ledger = try EffectLedger(url: url)
        } catch {
            errorMessage = "Device effects are disabled because the durable receipt ledger could not be opened."
        }
    }

    func attach(store: CompanionStore) {
        self.store = store
        if #available(iOS 26.0, *), alarmObservation == nil {
            alarmObservation = Task { [weak self] in
                for await _ in AlarmManager.shared.alarmUpdates {
                    guard let self, !Task.isCancelled else { return }
                    _ = await self.refreshCapabilities()
                }
            }
            permissionObservation = Task { [weak self] in
                for await _ in AlarmManager.shared.authorizationUpdates {
                    guard let self, !Task.isCancelled else { return }
                    await self.registerCurrentState()
                }
            }
        }
        for activity in trackedActivities where ownsActivity(activity) { observeToken(activity) }
    }

    func refreshCapabilities() async -> [Capability] {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let notificationsAllowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
        let notificationReason = notificationsAllowed
            ? (settings.soundSetting == .enabled ? nil : "Notification sound is disabled in system settings")
            : "Allow notifications in system settings"
        var alarmStatus = "unsupported"
        var alarmReason: String? = "System alarms require iOS 26 or later; no notification fallback is used"
        if #available(iOS 26.0, *) {
            alarmStatus = AlarmManager.shared.authorizationState == .authorized ? "available" : "permission_required"
            alarmReason = alarmStatus == "available" ? nil : "Allow alarms in system settings"
        }
        let activitiesAllowed = ActivityAuthorizationInfo().areActivitiesEnabled
        descriptors = [
            Capability(id: "alarm.schedule", status: alarmStatus, reason: alarmReason),
            Capability(id: "alarm.cancel", status: alarmStatus, reason: alarmReason),
            Capability(id: "notification.schedule", status: notificationsAllowed ? "available" : "permission_required", reason: notificationReason),
            Capability(id: "notification.cancel", status: "available"),
            Capability(id: "activity.track", status: activitiesAllowed ? "available" : "permission_required",
                       reason: activitiesAllowed ? nil : "Enable Live Activities in system settings")
        ]
        if ledger == nil {
            descriptors = descriptors.map { Capability(id: $0.id, status: "unsupported", reason: "Durable effect receipts are unavailable") }
        }
        permissionSummary = "Alarms: \(alarmStatus.replacingOccurrences(of: "_", with: " ")). Notifications: \(notificationsAllowed ? "allowed" : "not allowed"). Live Activities: \(activitiesAllowed ? "allowed" : "not allowed")."
        return descriptors
    }

    func requestAlarmPermission() async {
        if #available(iOS 26.0, *) {
            do { _ = try await AlarmManager.shared.requestAuthorization() }
            catch { errorMessage = "Alarm authorization could not be requested. Check system settings." }
        } else {
            errorMessage = "System alarms require iOS 26 or later. Notifications are not a substitute for alarms."
        }
        await registerCurrentState()
    }

    func requestNotificationPermission() async {
        do { _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) }
        catch { errorMessage = "Notification authorization could not be requested. Check system settings." }
        UIApplication.shared.registerForRemoteNotifications()
        await registerCurrentState()
    }

    func receivePushToken(_ token: Data) async {
        guard let configured = Bundle.main.object(forInfoDictionaryKey: "APNSEnvironment") as? String,
              ["development", "sandbox", "production"].contains(configured) else {
            pushStatus = "Push environment is not configured; token was not registered"
            return
        }
        apnsToken = token.map { String(format: "%02x", $0) }.joined()
        apnsEnvironment = configured == "development" ? "sandbox" : configured
        pushStatus = "APNs token received; remote delivery remains best effort"
        await registerCurrentState()
    }

    func pushRegistrationFailed() {
        pushStatus = "APNs registration failed. A signed device and push entitlement may be required."
    }

    func setBackgroundStatus(_ status: String) { backgroundStatus = status }

    func registerCurrentState() async {
        let capabilities = await refreshCapabilities()
        guard let store, store.isPaired else { return }
        let owned = trackedActivities.filter { ownsActivity($0) }
        let jobIDs = Array(Set(owned.map { $0.attributes.jobId })).sorted()
        guard jobIDs.count <= 16, jobIDs.allSatisfy(DeviceActionValidation.identifier) else {
            errorMessage = "Live Activity registrations exceed the supported identifier or count limits."
            return
        }
        let tokens = jobIDs.compactMap { jobID -> ActivityToken? in
            guard let token = owned.first(where: { $0.attributes.jobId == jobID && $0.pushToken != nil })?.pushToken else { return nil }
            return ActivityToken(jobId: jobID, token: token.map { String(format: "%02x", $0) }.joined())
        }
        await store.register(capabilities: capabilities, apnsToken: apnsToken,
                             apnsEnvironment: apnsEnvironment, activityTokens: tokens, activityJobIds: jobIDs)
    }

    func execute(action: DeviceAction, jobs: [Job]) async -> DeviceEffectOutcome {
        guard let ledger else {
            return DeviceEffectOutcome(status: "uncertain", result: "Durable effect receipts are unavailable; no effect was attempted")
        }
        let key = receiptKey(action)
        let fingerprint: String
        var intent: EffectIntent
        do {
            fingerprint = try EffectLedger.fingerprint(action)
            intent = try ledger.entry(key: key, fingerprint: fingerprint) ?? EffectIntent(fingerprint: fingerprint)
            intent.target = targetKey(action)
            intent.action = action
            if let receipt = intent.receipt {
                return DeviceEffectOutcome(status: receipt.status, result: receipt.result,
                                           retryableWithoutEffect: receipt.retryableWithoutEffect)
            }
        } catch {
            return DeviceEffectOutcome(status: "conflict", result: "This action ID was already used for different input")
        }
        let target = targetKey(action)
        let namespace = "\(store?.serverURL ?? "local")|\(action.deviceId)|"
        if intent.phase == "prepared", ledger.entries.contains(where: { otherKey, other in
            otherKey != key && otherKey.hasPrefix(namespace) && other.target == target
                && other.phase != "prepared" && other.receipt == nil
        }) {
            return DeviceEffectOutcome(status: "pending", result: "An earlier interrupted action for this target must be reconciled first")
        }
        guard activeTargets.insert(target).inserted else {
            return DeviceEffectOutcome(status: "pending", result: "Another action for this target is being reconciled")
        }
        defer { activeTargets.remove(target) }
        do {
            try Task.checkCancellation()
            if intent.phase != "prepared" {
                let recovered = await reconcile(action, intent: &intent)
                return try finish(recovered, intent: &intent, key: key)
            }
            guard action.isLocal || store?.remoteEffectsAllowed == true || intent.approved else {
                if !pendingReview.contains(where: { $0.id == action.id }) { pendingReview.append(action) }
                return DeviceEffectOutcome(status: "pending", result: "Trusted owner review is required before this device effect")
            }
            pendingReview.removeAll { $0.id == action.id }
            let capabilities = await refreshCapabilities()
            guard let capability = capabilities.first(where: { $0.id == action.capability }) else {
                return try finish(EffectReceipt(status: "unsupported", result: "No native adapter exists for this capability",
                                                retryableWithoutEffect: true), intent: &intent, key: key)
            }
            guard capability.status == "available" else {
                return try finish(EffectReceipt(status: capability.status, result: capability.reason ?? "System permission is required",
                                                retryableWithoutEffect: true), intent: &intent, key: key)
            }
            try validate(action, jobs: jobs)
            try ledger.save(intent, key: key)
            let outcome: EffectReceipt
            switch action.capability {
            case "alarm.schedule", "alarm.cancel":
                if #available(iOS 26.0, *) {
                    outcome = try await performAlarm(action, intent: &intent, key: key)
                } else {
                    outcome = EffectReceipt(status: "unsupported", result: "System alarms require iOS 26 or later")
                }
            case "notification.schedule", "notification.cancel":
                outcome = try await performNotification(action, intent: &intent, key: key)
            case "activity.track":
                outcome = try await performActivity(action, jobs: jobs, intent: &intent, key: key)
            default:
                outcome = EffectReceipt(status: "unsupported", result: "No native adapter exists for this capability")
            }
            return try finish(outcome, intent: &intent, key: key)
        } catch EffectError.invalidInput {
            return persistFailure("Invalid device action input or unknown job", intent: &intent, key: key)
        } catch is CancellationError {
            return DeviceEffectOutcome(status: "pending", result: "Synchronization was interrupted; durable intent is retained")
        } catch {
            if intent.phase != "prepared" {
                let result = await reconcile(action, intent: &intent)
                do { return try finish(result, intent: &intent, key: key) }
                catch { }
            }
            errorMessage = "The device effect could not be durably confirmed. It will not be repeated automatically."
            return DeviceEffectOutcome(status: "uncertain", result: "Effect outcome could not be durably confirmed")
        }
    }

    func approve(actionID: String) async {
        guard let action = pendingReview.first(where: { $0.id == actionID }), let ledger, let store else { return }
        do {
            let fingerprint = try EffectLedger.fingerprint(action)
            var intent = try ledger.entry(key: receiptKey(action), fingerprint: fingerprint) ?? EffectIntent(fingerprint: fingerprint)
            intent.approved = true
            try ledger.save(intent, key: receiptKey(action))
            let outcome = await execute(action: action, jobs: store.jobs)
            if outcome.status != "pending" {
                await store.acknowledgeAction(id: action.id, status: outcome.status, result: outcome.result,
                                             retryableWithoutEffect: outcome.retryableWithoutEffect)
            }
        } catch { errorMessage = "Approval could not be saved; the effect was not started." }
    }

    func deny(actionID: String) async {
        guard let action = pendingReview.first(where: { $0.id == actionID }), let ledger, let store else { return }
        do {
            let fingerprint = try EffectLedger.fingerprint(action)
            var intent = try ledger.entry(key: receiptKey(action), fingerprint: fingerprint) ?? EffectIntent(fingerprint: fingerprint)
            let outcome = try finish(EffectReceipt(status: "failed", result: "Owner declined this device action"), intent: &intent, key: receiptKey(action))
            pendingReview.removeAll { $0.id == actionID }
            await store.acknowledgeAction(id: action.id, status: outcome.status, result: outcome.result)
        } catch { errorMessage = "The decision could not be saved. No effect was performed." }
    }

    func track(jobID: String) async {
        guard let store else { return }
        let now = ISO8601DateFormatter().string(from: Date())
        var action = DeviceAction(id: UUID().uuidString, deviceId: store.deviceID, capability: "activity.track",
                                  input: ["jobId": .string(jobID)], status: "pending", createdAt: now, updatedAt: now)
        action.isLocal = true
        let outcome = await execute(action: action, jobs: store.jobs)
        if outcome.status != "applied" { errorMessage = outcome.result }
    }

    /// Called only after an authenticated snapshot, not from notification payload content.
    func updateJobs(_ jobs: [Job]) async {
        // Recover local-only intents too: a direct Track tap may not have a server action.
        if let store, let ledger {
            let namespace = "\(store.serverURL)|\(store.deviceID)|"
            let interrupted = ledger.entries.filter {
                $0.key.hasPrefix(namespace) && $0.value.receipt == nil && $0.value.phase != "prepared"
            }.values.compactMap(\.action).sorted { $0.createdAt < $1.createdAt }
            for action in interrupted {
                guard !Task.isCancelled else { return }
                let outcome = await execute(action: action, jobs: jobs)
                if outcome.status != "pending", store.pendingDeviceActions.contains(where: { $0.id == action.id }) {
                    await store.acknowledgeAction(id: action.id, status: outcome.status, result: outcome.result,
                                                 retryableWithoutEffect: outcome.retryableWithoutEffect)
                }
            }
        }
        pendingReview.removeAll { action in
            guard let store else { return true }
            return !store.pendingDeviceActions.contains(where: { $0.id == action.id })
        }
        let updates = trackedActivities.compactMap { activity -> (String, TaskActivityAttributes.ContentState)? in
            guard ownsActivity(activity),
                  let job = jobs.first(where: { $0.jobId == activity.attributes.jobId }) else { return nil }
            return (activity.id, contentState(job))
        }
        for (activityID, state) in updates {
            await Self.updateActivity(id: activityID, state: state)
            if state.isTerminal {
                tokenTasks.removeValue(forKey: activityID)?.cancel()
            } else if let activity = trackedActivities.first(where: { $0.id == activityID }) {
                observeToken(activity)
            }
        }
        await registerCurrentState()
    }

    /// Only immutable identity and content cross executors; ActivityKit handles stay local.
    @concurrent
    private static func updateActivity(id: String, state: TaskActivityAttributes.ContentState) async {
        guard let activity = Activity<TaskActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(300))
        if state.isTerminal {
            await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(60)))
        } else {
            await activity.update(content)
        }
    }

    private func receiptKey(_ action: DeviceAction) -> String {
        "\(store?.serverURL ?? "local")|\(action.deviceId)|\(action.id)"
    }

    private func targetKey(_ action: DeviceAction) -> String {
        switch action.capability {
        case "alarm.schedule", "alarm.cancel":
            "alarm:" + (UUID(uuidString: action.input["alarmId"]?.stringValue ?? "")?.uuidString ?? "")
        case "notification.schedule", "notification.cancel": "notification:" + (action.input["notificationId"]?.stringValue ?? "")
        case "activity.track": "activity:" + (action.input["jobId"]?.stringValue ?? "")
        default: action.id
        }
    }

    private func string(_ action: DeviceAction, _ name: String) throws -> String {
        guard case .string(let value) = action.input[name], !value.isEmpty else { throw EffectError.invalidInput }
        return value
    }

    private func date(_ action: DeviceAction) throws -> Date {
        guard let date = DeviceActionValidation.instant(try string(action, "date")) else { throw EffectError.invalidInput }
        return date
    }

    private func validate(_ action: DeviceAction, jobs: [Job]) throws {
        guard DeviceActionValidation.valid(id: action.id, deviceID: action.deviceId,
                                           capability: action.capability, input: action.input) else {
            throw EffectError.invalidInput
        }
        if action.capability == "alarm.schedule" || action.capability == "notification.schedule" {
            guard try date(action) > Date() else { throw EffectError.invalidInput }
        }
        if action.capability == "activity.track" {
            let jobID = try string(action, "jobId")
            guard jobs.contains(where: { $0.jobId == jobID && !$0.isTerminal }) else { throw EffectError.invalidInput }
        }
    }

    private func finish(_ receipt: EffectReceipt, intent: inout EffectIntent, key: String) throws -> DeviceEffectOutcome {
        intent.receipt = receipt
        intent.phase = "finished"
        if receipt.status == "applied" { intent.observedAt = Date() }
        guard let ledger else { throw EffectError.notObserved }
        try ledger.save(intent, key: key)
        return DeviceEffectOutcome(status: receipt.status, result: receipt.result,
                                   retryableWithoutEffect: receipt.retryableWithoutEffect)
    }

    private func persistFailure(_ reason: String, intent: inout EffectIntent, key: String) -> DeviceEffectOutcome {
        do { return try finish(EffectReceipt(status: "failed", result: reason), intent: &intent, key: key) }
        catch { return DeviceEffectOutcome(status: "uncertain", result: "The result could not be saved") }
    }

    private func begin(_ phase: String, intent: inout EffectIntent, key: String) throws {
        try Task.checkCancellation()
        guard let ledger else { throw EffectError.notObserved }
        intent.phase = phase
        try ledger.save(intent, key: key)
    }

    @available(iOS 26.0, *)
    private func performAlarm(_ action: DeviceAction, intent: inout EffectIntent, key: String) async throws -> EffectReceipt {
        guard let id = UUID(uuidString: try string(action, "alarmId")) else { throw EffectError.invalidInput }
        let manager = AlarmManager.shared
        // Inspect existing registration before replacing it. Cancelling first gives the
        // recovery path an unambiguous absent baseline, even for title-only updates.
        let existing = try manager.alarms.first(where: { $0.id == id })
        if action.capability == "alarm.cancel" {
            try begin("cancelling", intent: &intent, key: key)
            if existing != nil { try manager.cancel(id: id) }
            guard try !manager.alarms.contains(where: { $0.id == id }) else { throw EffectError.notObserved }
            return EffectReceipt(status: "applied", result: "Alarm registration is absent")
        }
        if existing != nil {
            try begin("replacing", intent: &intent, key: key)
            try manager.cancel(id: id)
            guard try !manager.alarms.contains(where: { $0.id == id }) else { throw EffectError.notObserved }
        }
        let scheduledDate = try date(action)
        let title = try string(action, "title")
        let alert: AlarmPresentation.Alert
        if #available(iOS 26.1, *) {
            alert = AlarmPresentation.Alert(title: LocalizedStringResource(stringLiteral: title))
        } else {
            alert = AlarmPresentation.Alert(title: LocalizedStringResource(stringLiteral: title),
                stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.circle"))
        }
        let attributes = AlarmAttributes(presentation: AlarmPresentation(alert: alert),
                                        metadata: UmpiAlarmMetadata(actionID: action.id), tintColor: .accentColor)
        let configuration = AlarmManager.AlarmConfiguration.alarm(schedule: .fixed(scheduledDate), attributes: attributes)
        try begin("scheduling", intent: &intent, key: key)
        let registered = try await manager.schedule(id: id, configuration: configuration)
        guard registered.id == id, registered.schedule == .fixed(scheduledDate),
              try manager.alarms.contains(where: { $0.id == id && $0.schedule == .fixed(scheduledDate) }) else { throw EffectError.notObserved }
        intent.registrationID = registered.id.uuidString
        intent.observedAt = Date()
        return EffectReceipt(status: "applied", result: "System alarm registration was observed")
    }

    private func performNotification(_ action: DeviceAction, intent: inout EffectIntent, key: String) async throws -> EffectReceipt {
        let center = UNUserNotificationCenter.current()
        let id = try string(action, "notificationId")
        if action.capability == "notification.cancel" {
            try begin("cancelling", intent: &intent, key: key)
            center.removePendingNotificationRequests(withIdentifiers: [id])
            center.removeDeliveredNotifications(withIdentifiers: [id])
        } else {
            let content = UNMutableNotificationContent()
            content.title = try string(action, "title")
            content.body = action.input["body"]?.stringValue ?? ""
            content.sound = .default
            content.userInfo = ["umpiFingerprint": intent.fingerprint]
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(secondsFromGMT: 0)!
            var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: try date(action))
            components.timeZone = calendar.timeZone
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            try begin("scheduling", intent: &intent, key: key)
            try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
        }
        let receipt = await reconcileNotification(action, fingerprint: intent.fingerprint)
        if receipt.status == "applied", action.capability == "notification.schedule" { intent.registrationID = id }
        return receipt
    }

    private func performActivity(_ action: DeviceAction, jobs: [Job], intent: inout EffectIntent, key: String) async throws -> EffectReceipt {
        let jobID = try string(action, "jobId")
        guard let job = jobs.first(where: { $0.jobId == jobID }), !job.isTerminal else { throw EffectError.invalidInput }
        if let existing = trackedActivities.first(where: { $0.attributes.jobId == jobID }) {
            guard ownsActivity(existing) else {
                return EffectReceipt(status: "conflict", result: "Dismiss the Live Activity from the previous companion session before tracking this job")
            }
            intent.registrationID = existing.id
            intent.observedAt = Date()
            observeToken(existing)
            return EffectReceipt(status: "applied", result: "Existing Live Activity registration was observed")
        }
        guard UIApplication.shared.applicationState == .active else {
            return EffectReceipt(status: "failed", result: "Open Umpi to start a Live Activity for this job",
                                 retryableWithoutEffect: true)
        }
        try begin("tracking", intent: &intent, key: key)
        let activity = try Activity.request(attributes: TaskActivityAttributes(jobId: jobID),
            content: ActivityContent(state: contentState(job), staleDate: Date().addingTimeInterval(300)), pushType: .token)
        guard Activity<TaskActivityAttributes>.activities.contains(where: { $0.id == activity.id }) else { throw EffectError.notObserved }
        intent.registrationID = activity.id
        intent.observedAt = Date()
        observeToken(activity)
        return EffectReceipt(status: "applied", result: "Live Activity registration was observed")
    }

    private func reconcile(_ action: DeviceAction, intent: inout EffectIntent) async -> EffectReceipt {
        switch action.capability {
        case "notification.schedule", "notification.cancel":
            let receipt = await reconcileNotification(action, fingerprint: intent.fingerprint)
            if receipt.status == "applied", action.capability == "notification.schedule" {
                intent.registrationID = action.input["notificationId"]?.stringValue
            }
            return receipt
        case "alarm.schedule", "alarm.cancel":
            if #available(iOS 26.0, *), let idText = try? string(action, "alarmId"), let id = UUID(uuidString: idText),
               let alarms = try? AlarmManager.shared.alarms {
                let alarm = alarms.first(where: { $0.id == id })
                if action.capability == "alarm.cancel", alarm == nil {
                    return EffectReceipt(status: "applied", result: "Alarm cancellation was reconciled: registration is absent")
                }
                if intent.phase == "scheduling", let expectedDate = try? date(action), alarm?.schedule == .fixed(expectedDate) {
                    intent.registrationID = id.uuidString
                    return EffectReceipt(status: "applied", result: "Interrupted scheduling was reconciled with the system alarm registration")
                }
            }
        case "activity.track":
            if let jobID = try? string(action, "jobId"),
               let activity = trackedActivities.first(where: { $0.attributes.jobId == jobID && ownsActivity($0) }) {
                intent.registrationID = activity.id
                observeToken(activity)
                return EffectReceipt(status: "applied", result: "Live Activity registration was reconciled")
            }
        default: break
        }
        return EffectReceipt(status: "uncertain", result: "No matching registration could be confirmed after an interrupted effect; it was not repeated")
    }

    private func reconcileNotification(_ action: DeviceAction, fingerprint: String) async -> EffectReceipt {
        guard let id = try? string(action, "notificationId") else {
            return EffectReceipt(status: "failed", result: "Invalid notification identifier")
        }
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        let delivered = await center.deliveredNotifications()
        let requests = pending + delivered.map(\.request)
        if action.capability == "notification.cancel" {
            if !requests.contains(where: { $0.identifier == id }) {
                return EffectReceipt(status: "applied", result: "Pending and delivered notification registrations are absent")
            }
        } else if requests.contains(where: { $0.identifier == id && $0.content.userInfo["umpiFingerprint"] as? String == fingerprint }) {
            return EffectReceipt(status: "applied", result: "Notification registration or delivery was observed")
        }
        return EffectReceipt(status: "uncertain", result: "The notification outcome could not be observed; it was not repeated")
    }

    private func contentState(_ job: Job) -> TaskActivityAttributes.ContentState {
        TaskActivityAttributes.ContentState(title: "Umpi task " + String(job.jobId.prefix(8)), status: job.status)
    }

    private var trackedActivities: [Activity<TaskActivityAttributes>] {
        Activity<TaskActivityAttributes>.activities.filter {
            $0.activityState == .active || $0.activityState == .stale
        }
    }

    private func ownsActivity(_ activity: Activity<TaskActivityAttributes>) -> Bool {
        guard let store, let ledger else { return false }
        let namespace = "\(store.serverURL)|\(store.deviceID)|"
        return ledger.entries.contains { key, intent in
            key.hasPrefix(namespace) && intent.target == "activity:" + activity.attributes.jobId
                && (intent.registrationID == activity.id || (intent.phase == "tracking" && intent.receipt == nil))
        }
    }

    private func observeToken(_ activity: Activity<TaskActivityAttributes>) {
        guard tokenTasks[activity.id] == nil else { return }
        tokenTasks[activity.id] = Task { [weak self] in
            for await _ in activity.pushTokenUpdates {
                guard let self, !Task.isCancelled else { return }
                await self.registerCurrentState()
            }
        }
    }
}
