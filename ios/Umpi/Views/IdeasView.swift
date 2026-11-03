import SwiftUI

/// Ideas captured by voice, newest first, searchable by their words.
struct IdeasView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var ideas: [Idea] = []
    @State private var query = ""
    @State private var loaded = false

    struct Idea: Decodable, Identifiable { var id: String; var text: String; var at: String; var seconds: Int?
        var date: Date? { (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(at)) ?? (try? Date.ISO8601FormatStyle().parse(at)) }
    }
    private struct Page: Decodable { var ideas: [Idea] }

    var body: some View {
        List {
            if loaded && ideas.isEmpty {
                ContentUnavailableView(query.isEmpty ? "No ideas yet" : "No matching ideas", systemImage: "lightbulb",
                    description: Text(query.isEmpty ? "Tap Idea on the widget or in Control Center and say it. It's saved here and in today's note." : "Try other words."))
            }
            ForEach(ideas) { idea in
                VStack(alignment: .leading, spacing: 4) {
                    Text(idea.text).textSelection(.enabled)
                    if let date = idea.date {
                        Text(date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .searchable(text: $query, prompt: "Search ideas")
        .task(id: query) {
            try? await Task.sleep(for: .milliseconds(query.isEmpty ? 0 : 250))
            await load()
        }
        .refreshable { await load() }
        .navigationTitle("Ideas")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }

    private func load() async {
        guard let transport = store.chatTransport else { return }
        let q = query.trimmingCharacters(in: .whitespaces)
        let path = q.isEmpty ? "/api/device/ideas" : "/api/device/ideas?q=\(q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
        if let data = try? await transport.send(path: path, method: "GET", body: nil), let page = try? JSONDecoder().decode(Page.self, from: data) { ideas = page.ideas }
        loaded = true
    }
}
