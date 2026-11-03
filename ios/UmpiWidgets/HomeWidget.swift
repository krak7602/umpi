import AppIntents
import SwiftUI
import WidgetKit

/// The home-screen and lock-screen widget: what Umpi chose, or today's open tasks, the next reminders, and what is
/// waiting. Small shows the first item, medium four, large eight. The app refreshes it after each sync.
struct HomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "UmpiHome", provider: HomeProvider()) { entry in
            HomeWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Umpi")
        .description("What's next today, chosen by Umpi.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}

struct HomeEntry: TimelineEntry {
    var date: Date
    var content: WidgetContent?
}

struct HomeProvider: TimelineProvider {
    func placeholder(in context: Context) -> HomeEntry {
        HomeEntry(date: .now, content: WidgetContent(items: [.init(title: "Review the plan", symbol: "circle"), .init(title: "Buy oats", symbol: "circle")], source: "default", updatedAt: ""))
    }
    func getSnapshot(in context: Context, completion: @escaping (HomeEntry) -> Void) { completion(HomeEntry(date: .now, content: WidgetContent.load() ?? placeholder(in: context).content)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<HomeEntry>) -> Void) {
        // The app reloads the widget when its content changes; this is only a fallback refresh.
        completion(Timeline(entries: [HomeEntry(date: .now, content: WidgetContent.load())], policy: .after(.now.addingTimeInterval(30 * 60))))
    }
}

struct HomeWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: HomeEntry

    private var items: [WidgetContent.Item] { entry.content?.items ?? [] }
    private var limit: Int {
        switch family { case .systemSmall: 1; case .systemMedium: 4; case .systemLarge: 8; default: 2 }
    }

    var body: some View {
        switch family {
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                ForEach(items.prefix(limit)) { item in Label(item.title, systemImage: item.symbol ?? "circle").font(.caption).lineLimit(1) }
                if items.isEmpty { Text("Nothing next").font(.caption) }
            }
            .widgetURL(WidgetContent.url("today"))
        case .systemSmall:
            VStack(alignment: .leading, spacing: 6) {
                header
                Spacer(minLength: 0)
                if let first = items.first {
                    Image(systemName: first.symbol ?? "circle").font(.title3).foregroundStyle(.tint)
                    Text(first.title).font(.headline).lineLimit(3)
                    if let detail = first.detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                } else {
                    Text("Nothing next").font(.headline).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .widgetURL(WidgetContent.url(items.first?.link))
        default:
            VStack(alignment: .leading, spacing: family == .systemLarge ? 10 : 6) {
                HStack { header; Spacer(); Link(destination: URL(string: "umpi://capture")!) { Image(systemName: "mic.circle.fill").font(.title2) }.accessibilityLabel("Capture an idea") }
                if items.isEmpty {
                    Spacer(); Text("Nothing next. Enjoy the quiet.").font(.subheadline).foregroundStyle(.secondary); Spacer()
                } else {
                    ForEach(items.prefix(limit)) { item in
                        Link(destination: WidgetContent.url(item.link)) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: item.symbol ?? "circle").foregroundStyle(.tint).frame(width: 18)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.title).font(.subheadline).lineLimit(1)
                                    if family == .systemLarge, let detail = item.detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                                }
                                Spacer(minLength: 0)
                                if family != .systemLarge, let detail = item.detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                            }
                        }
                    }
                    Spacer(minLength: 0)
                    if family == .systemLarge, let note = entry.content?.note { Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                }
            }
        }
    }

    private var header: some View {
        Text(entry.content?.source == "umpi" ? "From Umpi" : "Next").font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
    }
}

/// A Control Center and Action Button control: opens Umpi straight into recording an idea.
@available(iOS 18.0, *)
struct CaptureControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "UmpiCapture") {
            ControlWidgetButton(action: OpenURLIntent(URL(string: "umpi://capture")!)) {
                Label("Capture idea", systemImage: "mic")
            }
        }
        .displayName("Capture idea")
        .description("Record an idea; Umpi files it in your notes.")
    }
}
