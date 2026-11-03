import Foundation

/// What the home-screen widgets show, shared from the app to the widget extension through the App Group.
struct WidgetContent: Codable, Equatable, Sendable {
    struct Item: Codable, Equatable, Sendable, Identifiable {
        var title: String
        var detail: String?
        var symbol: String?
        var link: String?
        var id: String { title + (detail ?? "") }
    }
    var items: [Item]
    var source: String
    var updatedAt: String
    var note: String?

    static let key = "umpi.widget"
    static var defaults: UserDefaults? {
        (Bundle.main.object(forInfoDictionaryKey: "UmpiAppGroup") as? String).flatMap(UserDefaults.init(suiteName:))
    }
    static func load() -> WidgetContent? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(WidgetContent.self, from: data)
    }
    func save() { if let data = try? JSONEncoder().encode(self) { WidgetContent.defaults?.set(data, forKey: WidgetContent.key) } }

    /// Where a tap opens the app.
    static func url(_ link: String?) -> URL { URL(string: "umpi://\(link ?? "today")")! }
}
