import ActivityKit
import SwiftUI
import WidgetKit

@main
struct UmpiWidgets: WidgetBundle {
    var body: some Widget {
        TaskLiveActivity()
    }
}

struct TaskLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TaskActivityAttributes.self) { context in
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: context.state.symbol)
                    .font(.title2)
                VStack(alignment: .leading, spacing: 4) {
                    Text(context.state.title).font(.headline).lineLimit(2)
                    Text(context.state.statusLabel).font(.subheadline)
                    if context.isStale && !context.state.isTerminal {
                        Text("Update delayed · Open Umpi to refresh")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding()
            .activityBackgroundTint(Color(uiColor: .secondarySystemBackground))
            .widgetURL(URL(string: "umpi://activity"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Umpi", systemImage: context.state.symbol)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.statusLabel).font(.caption)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(context.state.title).lineLimit(2)
                        if context.isStale && !context.state.isTerminal {
                            Text("Update delayed").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: context.state.symbol)
            } compactTrailing: {
                Image(systemName: context.isStale ? "clock.badge.exclamationmark" : "circle.fill")
                    .font(.caption2)
                    .accessibilityLabel(context.isStale ? "Update delayed" : context.state.statusLabel)
            } minimal: {
                Image(systemName: context.state.symbol)
            }
            .widgetURL(URL(string: "umpi://activity"))
        }
    }
}
