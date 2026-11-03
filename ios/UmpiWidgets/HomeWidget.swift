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
        .description("Quick buttons for an idea, today, and chat; choose them in Umpi's Settings.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular])
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
    private var actions: [WidgetAction] { WidgetAction.list(entry.content?.actions) }

    var body: some View {
        switch family {
        case .accessoryCircular:
            let first = actions.first ?? WidgetAction.all[0]
            ZStack { AccessoryWidgetBackground(); Image(systemName: first.symbol).font(.title3) }
                .widgetURL(first.url).accessibilityLabel(first.label)
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                ForEach(items.prefix(2)) { item in Label(item.title, systemImage: item.symbol ?? "circle").font(.caption).lineLimit(1) }
                if items.isEmpty { Text("Nothing next").font(.caption) }
            }
            .widgetURL(WidgetContent.url("today"))
        case .systemSmall:
            // One big button: the first action, such as recording an idea.
            let first = actions.first ?? WidgetAction.all[0]
            VStack(spacing: 10) {
                Image(systemName: first.symbol).font(.system(size: 34, weight: .semibold)).foregroundStyle(.tint)
                Text(first.label).font(.headline)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .widgetURL(first.url)
        case .systemMedium:
            buttons.frame(maxHeight: .infinity)
        default:
            VStack(alignment: .leading, spacing: 14) {
                buttons
                Divider()
                Text(entry.content?.source == "umpi" ? "From Umpi" : "Next").font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
                if items.isEmpty { Text("Nothing next.").font(.subheadline).foregroundStyle(.secondary) }
                ForEach(items.prefix(5)) { item in
                    Link(destination: WidgetContent.url(item.link)) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: item.symbol ?? "circle").foregroundStyle(.tint).frame(width: 18)
                            Text(item.title).font(.subheadline).lineLimit(1)
                            Spacer(minLength: 0)
                            if let detail = item.detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    /// The configured buttons in a row, each an icon in a soft circle with its name, like the system's shortcuts.
    private var buttons: some View {
        HStack(spacing: 0) {
            ForEach(actions.prefix(4)) { action in
                Link(destination: action.url) {
                    VStack(spacing: 6) {
                        Image(systemName: action.symbol).font(.title3.weight(.semibold)).foregroundStyle(.tint)
                            .frame(width: 52, height: 52).background(.tint.opacity(0.15), in: Circle())
                        Text(action.label).font(.caption2.weight(.medium)).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity)
                }
                .accessibilityLabel(action.label)
            }
        }
    }
}

/// A small square with four buttons in a 2×2 grid, each opening its own action. Widget buttons run an intent per tap
/// (iOS 17 and later), so a small widget is not limited to one tap target.
struct ButtonsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "UmpiButtons", provider: HomeProvider()) { entry in
            ButtonsWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Umpi Buttons")
        .description("Four quick buttons in a small square; choose them in Umpi's Settings.")
        .supportedFamilies([.systemSmall])
    }
}

struct ButtonsWidgetView: View {
    let entry: HomeEntry
    private var actions: [WidgetAction] { Array(WidgetAction.list(entry.content?.actions).prefix(4)) }

    var body: some View {
        Grid(horizontalSpacing: 10, verticalSpacing: 10) {
            ForEach(0..<2, id: \.self) { row in
                GridRow {
                    ForEach(0..<2, id: \.self) { column in
                        let index = row * 2 + column
                        if actions.indices.contains(index) { button(actions[index]) } else { Color.clear }
                    }
                }
            }
        }
    }

    private func button(_ action: WidgetAction) -> some View {
        Button(intent: OpenURLIntent(action.url)) {
            Image(systemName: action.symbol).font(.title2.weight(.semibold)).foregroundStyle(.tint)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(action.label)
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
