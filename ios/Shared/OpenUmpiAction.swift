import AppIntents
import Foundation

/// Opens Umpi at one of the widget's actions. Widget buttons and the Control Center control run this intent instead of
/// opening a link: the system launches the app and runs it there, and the app routes to the action. The request is
/// also kept until the app's screens are ready, so a cold launch does not lose it.
struct OpenUmpiAction: AppIntent {
    static let title: LocalizedStringResource = "Open in Umpi"
    static let openAppWhenRun = true
    static let isDiscoverable = false

    @Parameter(title: "Action") var action: String

    init() {}
    init(action: String) { self.action = action }

    @MainActor func perform() async throws -> some IntentResult {
        UmpiRoute.request(action)
        return .result()
    }
}

/// A requested destination in the app, from a widget, control, or link.
enum UmpiRoute {
    static let key = "umpi.route"
    static let notification = Notification.Name("umpi.route")

    @MainActor static func request(_ action: String) {
        UserDefaults.standard.set(action, forKey: key)
        NotificationCenter.default.post(name: notification, object: action)
    }
    /// The pending request, left in place.
    @MainActor static func peek() -> String? { UserDefaults.standard.string(forKey: key) }
    /// The pending request, once.
    @MainActor static func take() -> String? {
        let action = UserDefaults.standard.string(forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
        return action
    }
}
