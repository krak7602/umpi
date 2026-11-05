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
    /// The widget's buttons, in order; see `WidgetAction`.
    var actions: [String]?

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

/// A widget button: what it shows and the link it opens.
struct WidgetAction: Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let symbol: String
    var url: URL { URL(string: "umpi://\(id)")! }

    static let all: [WidgetAction] = [
        .init(id: "voice", label: "Voice", symbol: "mic.fill"),
        .init(id: "talk", label: "Talk", symbol: "waveform"),
        .init(id: "today", label: "Today", symbol: "sun.max.fill"),
        .init(id: "chat", label: "Chat", symbol: "bubble.left.and.bubble.right.fill"),
        .init(id: "work", label: "Work", symbol: "tray.full.fill"),
        .init(id: "remind", label: "Remind me", symbol: "bell.badge.fill"),
    ]
    static let defaults = ["voice", "today", "chat", "work"]
    static func list(_ ids: [String]?) -> [WidgetAction] {
        (ids ?? defaults).map { $0 == "idea" ? "voice" : $0 }.compactMap { id in all.first { $0.id == id } }
    }
}
