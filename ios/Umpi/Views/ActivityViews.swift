import SwiftUI

struct ActivityListView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(DeviceCapabilities.self) private var effects
    @State private var showAsk = false

    var body: some View {
        List {
            ConnectionStatusSection()
            if !effects.pendingReview.isEmpty {
                Section("Device actions awaiting your review") {
                    ForEach(effects.pendingReview) { action in
                        NavigationLink { DeviceActionReviewView(action: action) } label: {
                            Label(action.capability, systemImage: "hand.raised")
                        }
                    }
                }
            }
            Section("Commands") {
                if store.jobs.isEmpty {
                    ContentUnavailableView("No commands", systemImage: "terminal", description: Text("Commands requested by Umpi appear here. Nothing runs without your separate approval."))
                }
                ForEach(store.jobs) { job in
                    NavigationLink { JobDetailView(jobID: job.id) } label: {
                        VStack(alignment: .leading) {
                            Text(job.command).font(.system(.body, design: .monospaced)).lineLimit(2)
                            Text(job.status.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityIdentifier("job.row.\(job.id)")
                }
            }
            if !store.choices.isEmpty {
                Section("Questions") {
                    ForEach(store.choices) { choice in
                        NavigationLink { ChoiceDetailView(choice: choice) } label: {
                            VStack(alignment: .leading) {
                                Text(choice.question)
                                Text(choice.status).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            if !store.operations.isEmpty {
                Section("Requests") {
                    ForEach(store.operations) { operation in
                        DisclosureGroup {
                            Text(operation.text).textSelection(.enabled)
                            if let result = operation.result { Text(result).textSelection(.enabled) }
                            if let error = operation.error { Label(error, systemImage: "exclamationmark.triangle") }
                        } label: {
                            VStack(alignment: .leading) {
                                Text(operation.text).lineLimit(2)
                                Text(operation.status).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            if !store.reminders.isEmpty {
                Section("Coordinator reminders") {
                    ForEach(store.reminders) { reminder in
                        VStack(alignment: .leading) {
                            Text(reminder.text)
                            Text("\(reminder.status) · \(reminder.dueAt)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Text("Coordinator reminders are not proof of a scheduled phone alarm.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            if !store.pendingDeviceActions.isEmpty {
                Section("Device action status") {
                    ForEach(store.pendingDeviceActions) { action in
                        DisclosureGroup {
                            Text(action.id).font(.caption).textSelection(.enabled)
                            if let result = action.result { Text(result) }
                        } label: {
                            VStack(alignment: .leading) {
                                Text(action.capability)
                                Text(action.status.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Activity")
        .refreshable { await store.synchronize() }
        .toolbar {
            Button("Ask Umpi", systemImage: "bubble.left") { showAsk = true }
                .accessibilityIdentifier("activity.ask")
        }
        .sheet(isPresented: $showAsk) { AskUmpiView() }
    }
}

struct JobDetailView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(DeviceCapabilities.self) private var effects
    let jobID: String
    @State private var review: Job?
    @State private var cancel: Job?

    var body: some View {
        Group {
            if let job = store.jobs.first(where: { $0.id == jobID }) {
                Form {
                    ExactCommandSections(job: job)
                    Section("State") {
                        LabeledContent("Status", value: job.status.replacingOccurrences(of: "_", with: " "))
                        if job.cancelRequested { Text("Cancellation requested; the executor has not yet confirmed the outcome.") }
                        if job.status == "pending_approval" {
                            Button("Review command for approval") { review = job }
                                .accessibilityIdentifier("job.review")
                        }
                        if !job.isTerminal {
                            Button("Request cancellation", role: .destructive) { cancel = job }
                                .accessibilityIdentifier("job.cancel")
                            Button("Track with Live Activity") { Task { await effects.track(jobID: jobID) } }
                        }
                        if let error = effects.errorMessage { Text(error) }
                    }
                    if let completion = job.completion {
                        Section("Executor result") {
                            LabeledContent("Outcome", value: completion.status)
                            if let exitCode = completion.exitCode { LabeledContent("Exit code", value: String(exitCode)) }
                            Text(completion.output).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                            if completion.truncated { Text("Output was truncated by the executor.").foregroundStyle(.secondary) }
                        }
                    }
                    ConnectionStatusSection()
                }
            } else {
                ContentUnavailableView("Command unavailable", systemImage: "terminal", description: Text("Refresh Activity to retrieve the current coordinator state."))
            }
        }
        .navigationTitle("Command details")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.synchronize() }
        .sheet(item: $review) { job in CommandApprovalView(job: job) }
        .confirmationDialog("Request command cancellation?", isPresented: Binding(get: { cancel != nil }, set: { if !$0 { cancel = nil } }), titleVisibility: .visible) {
            Button("Request cancellation", role: .destructive) {
                if let job = cancel { Task { await store.cancelJob(id: job.id, version: job.version) } }
                cancel = nil
            }
        } message: { Text("A running command may already have made changes. A cancellation request does not undo them or imply that the process has stopped.") }
    }
}

private struct ExactCommandSections: View {
    let job: Job

    var body: some View {
        Section("Exact command") {
            Text(job.command)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .accessibilityIdentifier("job.exactCommand")
        }
        Section("Execution context") {
            LabeledContent("Folder") { Text(job.cwd).textSelection(.enabled) }
            LabeledContent("Timeout", value: "\(job.timeoutMs) milliseconds")
            LabeledContent("Version", value: String(job.version))
            Text("This command runs natively on your configured Mac executor, with its account's access. The allowed working folder is not a filesystem sandbox. Commands can change or delete files and make network requests.")
        }
    }
}

private struct CommandApprovalView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let job: Job
    @State private var submitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section { Label("Owner command approval", systemImage: "lock.shield") }
                ExactCommandSections(job: job)
                Section {
                    Text("Approve only if you understand this exact command and folder. Approval applies only to the displayed version. If the command changes, this review cannot approve the new version.")
                    Button("Approve exact command") {
                        submitting = true
                        Task {
                            store.clearError()
                            let accepted = await store.approveJob(id: job.id, version: job.version)
                            submitting = false
                            if accepted { dismiss() }
                        }
                    }
                    .disabled(submitting)
                    .accessibilityIdentifier("job.approveExact")
                    Button("Cancel command", role: .destructive) {
                        submitting = true
                        Task {
                            store.clearError()
                            let accepted = await store.cancelJob(id: job.id, version: job.version)
                            submitting = false
                            if accepted { dismiss() }
                        }
                    }
                    .disabled(submitting)
                }
                if let error = store.errorMessage { Section { Text(error) } }
            }
            .navigationTitle("Review command")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Not now") { dismiss() }.disabled(submitting) } }
            .interactiveDismissDisabled(submitting)
        }
    }
}

private struct ChoiceDetailView: View {
    @Environment(CompanionStore.self) private var store
    let choice: Choice
    @State private var answer = ""
    @State private var sending = false

    private var current: Choice { store.choices.first(where: { $0.id == choice.id }) ?? choice }

    var body: some View {
        Form {
            Section { Text(current.question) }
            if let existing = current.answer {
                Section("Answer") { Text(existing) }
            } else {
                Section("Choose an answer") {
                    ForEach(current.options, id: \.self) { option in
                        Button(option) { send(option) }.disabled(sending)
                    }
                    TextField("Your answer", text: $answer, axis: .vertical)
                    Button("Send answer") { send(answer) }.disabled(sending || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            Section { Text("Answering a question does not approve a command.").foregroundStyle(.secondary) }
            ConnectionStatusSection()
        }
        .navigationTitle("Question")
    }

    private func send(_ text: String) {
        sending = true
        Task { await store.answerChoice(id: choice.id, answer: text); sending = false }
    }
}

struct DeviceActionReviewView: View {
    @Environment(DeviceCapabilities.self) private var effects
    @Environment(\.dismiss) private var dismiss
    let action: DeviceAction
    @State private var submitting = false

    var body: some View {
        Form {
            Section("Device effect") {
                Text(action.capability).font(.headline)
                ForEach(action.input.keys.sorted(), id: \.self) { key in
                    LabeledContent(key) { Text(action.input[key]?.stringValue ?? "").textSelection(.enabled) }
                }
                Text("Only the displayed device action is authorized by this review. System permission is also required. An accepted request is not proof that the device applied it.").font(.footnote)
            }
            Section {
                Button("Allow this device action") {
                    submitting = true
                    Task {
                        await effects.approve(actionID: action.id)
                        submitting = false
                        if effects.errorMessage == nil { dismiss() }
                    }
                }
                .disabled(submitting)
                .accessibilityIdentifier("deviceAction.approve")
                Button("Deny this device action", role: .destructive) {
                    submitting = true
                    Task {
                        await effects.deny(actionID: action.id)
                        submitting = false
                        if effects.errorMessage == nil { dismiss() }
                    }
                }
                .disabled(submitting)
            }
            if let error = effects.errorMessage { Section { Text(error) } }
        }
        .navigationTitle("Review device action")
        .navigationBarTitleDisplayMode(.inline)
    }
}
