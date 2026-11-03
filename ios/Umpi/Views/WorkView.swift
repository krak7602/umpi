import SwiftUI

/// Everything Umpi is doing or waiting on: what needs the owner first, then workflows and the activity record.
struct WorkView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(DeviceCapabilities.self) private var effects
    @Environment(T3CodeModel.self) private var t3

    private var waitingJobs: [Job] { store.jobs.filter { $0.status == "pending_approval" } }
    private var runningJobs: [Job] { store.jobs.filter { $0.status == "queued" || $0.status == "running" } }
    private var openQuestions: [Choice] { store.choices.filter { $0.status == "pending" } }
    /// Coding threads waiting on the owner, from every connected machine.
    private var waitingThreads: [(machine: T3Machine, thread: T3Thread)] {
        t3.machines.flatMap { machine in (machine.threads ?? []).filter { $0.status == "waiting" && $0.subagent != true }.map { (machine, $0) } }
    }
    private var nextReminders: [Reminder] {
        store.reminders.filter { $0.status == "scheduled" }.sorted { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }.prefix(5).map { $0 }
    }

    var body: some View {
        List {
            if waitingJobs.isEmpty && openQuestions.isEmpty && effects.pendingReview.isEmpty && waitingThreads.isEmpty {
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
                    ForEach(waitingThreads, id: \.thread.id) { item in
                        NavigationLink { T3ThreadView(machine: item.machine, thread: item.thread) } label: { T3ThreadRow(thread: item.thread) }
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
            T3WorkSection()
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
        .refreshable { async let sync: Void = store.synchronize(); async let threads: Void = t3.loadThreads(store); _ = await (sync, threads) }
        .onAppear { Task { await t3.loadThreads(store) } }
        .navigationTitle("Work")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A reminder in a list: its one-line title and when it is due. The details open on tap.
struct ReminderRow: View {
    let reminder: Reminder
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: reminder.intensity == "gentle" ? "bell" : "bell.badge").foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 3) {
                Text(reminder.text).lineLimit(2)
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
                Text(reminder.text).font(.title3.weight(.semibold)).textSelection(.enabled)
                if let details = reminder.details { MarkdownView(details).textSelection(.enabled) }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .softScrollEdges()
        .navigationTitle("Reminder")
        .navigationBarTitleDisplayMode(.inline)
    }
}
