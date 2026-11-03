import SwiftUI

/// The day's note from the owner's vault, the one Umpi prepares each morning, shown like a note. Ticking a checkbox
/// changes only that line in the note; if the line changed elsewhere meanwhile, the latest note is shown instead.
struct TodayView: View {
    @Environment(CompanionStore.self) private var store
    @State private var day = TodayView.today()
    @State private var note: DayNote?
    @State private var loading = false
    @State private var problem: String?
    @State private var notice: String?

    struct DayNote: Decodable, Equatable { var day: String; var text: String?; var revision: String }
    struct TaskResult: Decodable { var status: String; var text: String?; var revision: String }

    var body: some View {
        ScrollView {
            content
                .padding(.horizontal, 20).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .softScrollEdges()
        .refreshable { await load() }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarLeading) {
                Button { shift(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Previous day")
                Button { shift(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Next day")
            }
            if day != TodayView.today() {
                ToolbarItem(placement: .topBarTrailing) { Button("Today") { day = TodayView.today() } }
            }
        }
        .overlay(alignment: .top) {
            if let notice {
                Text(notice).font(.footnote).padding(.horizontal, 12).padding(.vertical, 8).background(.thinMaterial, in: Capsule()).padding(.top, 4)
                    .task(id: notice) { try? await Task.sleep(for: .seconds(4)); self.notice = nil }
            }
        }
        .task(id: day) { await load() }
    }

    @ViewBuilder private var content: some View {
        if let note, let text = note.text {
            let body = TodayView.withoutFrontmatter(text)
            MarkdownView(body.text)
                .environment(\.markdownTaskToggle) { line, checked in
                    Task { await setTask(sourceLine: line - 1 + body.offset, checked: checked, in: text) }
                }
                .textSelection(.enabled)
        } else if let problem {
            ContentUnavailableView("Notes aren't available", systemImage: "exclamationmark.triangle", description: Text(problem))
                .padding(.top, 80)
        } else if note != nil {
            ContentUnavailableView("No note for this day", systemImage: "doc.text",
                description: Text("Umpi prepares the day's note each morning when daily planning is on. Notes you write in Obsidian show here too."))
                .padding(.top, 80)
        } else {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 120)
        }
    }

    private var title: String {
        guard let date = TodayView.date(day) else { return "Today" }
        if day == TodayView.today() { return "Today · " + date.formatted(.dateTime.weekday(.wide).day().month(.abbreviated)) }
        return date.formatted(.dateTime.weekday(.wide).day().month(.abbreviated))
    }

    private func load() async {
        guard let transport = store.chatTransport, !loading else { return }
        loading = true; defer { loading = false }
        do {
            let data = try await transport.send(path: "/api/device/today?day=\(day)", method: "GET", body: nil)
            note = try JSONDecoder().decode(DayNote.self, from: data); problem = nil
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? "The note could not be loaded."
        }
    }

    /// Ticks the line optimistically; the server's answer is what stays.
    private func setTask(sourceLine: Int, checked: Bool, in text: String) async {
        var lines = text.components(separatedBy: "\n")
        guard let transport = store.chatTransport, lines.indices.contains(sourceLine) else { return }
        let expected = lines[sourceLine]
        lines[sourceLine] = expected.replacingOccurrences(of: checked ? "[ ]" : "[x]", with: checked ? "[x]" : "[ ]", options: [.caseInsensitive], range: expected.range(of: checked ? "[ ]" : "[x]", options: .caseInsensitive))
        note?.text = lines.joined(separator: "\n")
        struct Body: Encodable { var day: String; var line: Int; var text: String; var checked: Bool }
        do {
            let data = try await transport.send(path: "/api/device/today/task", method: "POST",
                                                body: JSONEncoder().encode(Body(day: day, line: sourceLine, text: expected, checked: checked)))
            let result = try JSONDecoder().decode(TaskResult.self, from: data)
            note = DayNote(day: day, text: result.text, revision: result.revision)
            if result.status == "conflict" { notice = "The note changed. Showing the latest." }
        } catch {
            notice = (error as? LocalizedError)?.errorDescription ?? "The note could not be changed."
            await load()
        }
    }

    private func shift(_ days: Int) {
        guard let date = TodayView.date(day), let next = Calendar.current.date(byAdding: .day, value: days, to: date) else { return }
        day = TodayView.key(next)
    }

    static func today() -> String { key(Date()) }
    static func key(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 2000, parts.month ?? 1, parts.day ?? 1)
    }
    static func date(_ key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
    /// Obsidian frontmatter is metadata, not part of the note to read; `offset` maps lines back to the source.
    static func withoutFrontmatter(_ text: String) -> (text: String, offset: Int) {
        let lines = text.components(separatedBy: "\n")
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---",
              let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) else { return (text, 0) }
        return (lines[(end + 1)...].joined(separator: "\n"), end + 1)
    }
}
