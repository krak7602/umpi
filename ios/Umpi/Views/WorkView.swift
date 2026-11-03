import SwiftUI

/// Everything Umpi is doing or waiting on: what needs the owner first, then workflows and the activity record.
struct WorkView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(DeviceCapabilities.self) private var effects

    private var waitingJobs: [Job] { store.jobs.filter { $0.status == "pending_approval" } }
    private var runningJobs: [Job] { store.jobs.filter { $0.status == "queued" || $0.status == "running" } }
    private var openQuestions: [Choice] { store.choices.filter { $0.status == "pending" } }
    private var nextReminders: [Reminder] {
        store.reminders.filter { $0.status == "scheduled" }.sorted { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }.prefix(5).map { $0 }
    }

    var body: some View {
        List {
            if waitingJobs.isEmpty && openQuestions.isEmpty && effects.pendingReview.isEmpty {
                Section {
                    Label("Nothing is waiting on you", systemImage: "checkmark.circle").foregroundStyle(.secondary)
                }
            } else {
                Section("Needs you") {
                    ForEach(effects.pendingReview) { action in
                        NavigationLink { DeviceActionReviewView(action: action) } label: { Label(action.capability, systemImage: "hand.raised") }
                    }
                    ForEach(waitingJobs) { job in
                        NavigationLink { JobDetailView(jobID: job.id) } label: {
                            Label { Text(job.command).font(.system(.callout, design: .monospaced)).lineLimit(2) } icon: { Image(systemName: "terminal") }
                        }
                    }
                    ForEach(openQuestions) { choice in
                        NavigationLink { ChoiceDetailView(choice: choice) } label: { Label { Text(ReminderRow.title(choice.question)).lineLimit(2) } icon: { Image(systemName: "questionmark.bubble") } }
                    }
                }
            }
            if !runningJobs.isEmpty {
                Section("Running") {
                    ForEach(runningJobs) { job in
                        NavigationLink { JobDetailView(jobID: job.id) } label: {
                            Label { Text(job.command).font(.system(.callout, design: .monospaced)).lineLimit(1) } icon: { ProgressView().controlSize(.small) }
                        }
                    }
                }
            }
            if !nextReminders.isEmpty {
                Section("Coming up") {
                    ForEach(nextReminders) { reminder in
                        NavigationLink { ReminderDetailView(reminder: reminder) } label: { ReminderRow(reminder: reminder) }
                    }
                }
            }
            Section {
                NavigationLink { WorkflowListView() } label: { Label("Workflows", systemImage: "list.bullet.rectangle") }
                NavigationLink { ActivityListView() } label: { Label("All activity", systemImage: "clock") }
            }
        }
        .softScrollEdges()
        .refreshable { await store.synchronize() }
        .navigationTitle("Work")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A reminder in a list: its first line as a two-line preview, and when it is due. The full text opens on tap.
struct ReminderRow: View {
    let reminder: Reminder
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: reminder.intensity == "gentle" ? "bell" : "bell.badge").foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 3) {
                Text(ReminderRow.title(reminder.text)).lineLimit(2)
                if let due = reminder.due {
                    Text(due, format: .dateTime.weekday(.abbreviated).hour().minute()).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }
    /// The first line with text, without list or heading marks.
    static func title(_ text: String) -> String {
        let line = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? text
        return line.replacingOccurrences(of: #"^(#+|[-*+]|\d+\.)\s+"#, with: "", options: .regularExpression)
    }
}

/// The whole reminder, rendered like a note.
struct ReminderDetailView: View {
    let reminder: Reminder
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let due = reminder.due {
                    Label(due.formatted(.dateTime.weekday(.wide).day().month(.abbreviated).hour().minute()), systemImage: "bell")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                MarkdownView(reminder.text).textSelection(.enabled)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .softScrollEdges()
        .navigationTitle("Reminder")
        .navigationBarTitleDisplayMode(.inline)
    }
}
