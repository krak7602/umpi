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
                        NavigationLink { ChoiceDetailView(choice: choice) } label: { Label(choice.question, systemImage: "questionmark.bubble") }
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
                        HStack {
                            Label(reminder.text, systemImage: reminder.intensity == "gentle" ? "bell" : "bell.badge")
                            Spacer()
                            if let due = reminder.due { Text(due, format: .dateTime.weekday(.abbreviated).hour().minute()).font(.footnote).foregroundStyle(.secondary) }
                        }
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
