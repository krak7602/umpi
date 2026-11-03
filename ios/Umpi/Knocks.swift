import Foundation
import UserNotifications

/// Reminders knock on the phone instead of ringing like an alarm. Each scheduled reminder becomes local notifications
/// set ahead on the phone, so a knock comes even when the phone is offline: a time-sensitive knock with its sound, then
/// two repeats three minutes apart until it is answered (a gentle reminder knocks once, quietly). Done, Snooze 10 min,
/// and Later answer it. The phone tells the coordinator which reminders it has set, so Telegram stays silent for them.
@MainActor
final class KnockScheduler {
    nonisolated static let category = "UMPI_KNOCK"
    static let prefix = "knock."
    enum Action: String { case done = "KNOCK_DONE", snooze = "KNOCK_SNOOZE", later = "KNOCK_LATER" }
    /// iOS keeps at most 64 pending requests; three per reminder leaves room for other notifications.
    static let maxReminders = 18
    static let repeatInterval: TimeInterval = 180

    static func registerCategory() {
        let actions = [
            UNNotificationAction(identifier: Action.done.rawValue, title: "Done", options: [], icon: UNNotificationActionIcon(systemImageName: "checkmark")),
            UNNotificationAction(identifier: Action.snooze.rawValue, title: "Snooze 10 min", options: [], icon: UNNotificationActionIcon(systemImageName: "clock")),
            UNNotificationAction(identifier: Action.later.rawValue, title: "Later", options: [], icon: UNNotificationActionIcon(systemImageName: "tray")),
        ]
        let category = UNNotificationCategory(identifier: category, actions: actions, intentIdentifiers: [], options: [.customDismissAction])
        UNUserNotificationCenter.current().getNotificationCategories { existing in
            UNUserNotificationCenter.current().setNotificationCategories(existing.filter { $0.identifier != KnockScheduler.category }.union([category]))
        }
    }

    static func identifier(_ reminder: Reminder, _ attempt: Int) -> String { "\(prefix)\(reminder.id).\(reminder.version).\(attempt)" }

    /// Brings the phone's pending knocks in line with the coordinator's scheduled reminders. Returns the reminders that
    /// are set as knocks, or nil when notifications are not allowed (then Telegram stays the alert).
    static func reconcile(_ reminders: [Reminder], now: Date = Date()) async -> [Reminder]? {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return nil }
        // A fired reminder nobody answered keeps its repeats for the ten minutes they span.
        let wanted = reminders
            .filter { reminder in
                guard let due = reminder.due else { return false }
                if reminder.status == "scheduled" { return due > now.addingTimeInterval(-60) }
                return reminder.status == "fired" && reminder.answer == nil && due > now.addingTimeInterval(-600)
            }
            .sorted { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }
            .prefix(maxReminders)
        let delivered = Set(await center.deliveredNotifications().map(\.request.identifier))
        var desired: [String: UNNotificationRequest] = [:]
        for reminder in wanted {
            guard let due = reminder.due else { continue }
            let gentle = reminder.intensity == "gentle"
            for attempt in 0..<(gentle ? 1 : 3) {
                let content = UNMutableNotificationContent()
                content.title = attempt == 0 ? "Umpi" : "Umpi · still waiting"
                // The title, then the first line of the details as a hint; the rest is in the app.
                let hint = reminder.details.flatMap { $0.split(separator: "\n").first }.map { String($0).replacingOccurrences(of: #"^([-*+]|\d+\.)\s+"#, with: "", options: .regularExpression) }
                content.body = hint.map { "\(reminder.text)\n\($0)" } ?? reminder.text
                content.categoryIdentifier = category
                content.threadIdentifier = "knock.\(reminder.id)"
                content.interruptionLevel = gentle ? .active : .timeSensitive
                content.sound = UNNotificationSound(named: UNNotificationSoundName(gentle ? "knock-gentle.caf" : "knock.caf"))
                content.userInfo = ["reminderId": reminder.id, "version": reminder.version]
                let id = identifier(reminder, attempt)
                let delay = due.timeIntervalSince(now) + Double(attempt) * repeatInterval
                // A knock that already sounded, or whose time passed more than a minute ago, is not set again.
                if delivered.contains(id) || delay < -60 { continue }
                desired[id] = UNNotificationRequest(identifier: id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, delay), repeats: false))
            }
        }
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(prefix) }
        center.removePendingNotificationRequests(withIdentifiers: pending.filter { desired[$0] == nil })
        for (id, request) in desired where !pending.contains(id) { try? await center.add(request) }
        let set = Set(await center.pendingNotificationRequests().map(\.identifier))
        return wanted.filter { $0.status == "scheduled" && (set.contains(identifier($0, 0)) || delivered.contains(identifier($0, 0))) }
    }

    /// Stops a reminder's remaining repeats and clears its delivered knocks.
    static func stop(reminderID: String) async {
        let center = UNUserNotificationCenter.current()
        let mine = { (id: String) in id.hasPrefix("\(prefix)\(reminderID).") }
        center.removePendingNotificationRequests(withIdentifiers: await center.pendingNotificationRequests().map(\.identifier).filter(mine))
        center.removeDeliveredNotifications(withIdentifiers: await center.deliveredNotifications().map(\.request.identifier).filter(mine))
    }
}

extension Reminder {
    var due: Date? { (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(dueAt)) ?? (try? Date.ISO8601FormatStyle().parse(dueAt)) }
}
