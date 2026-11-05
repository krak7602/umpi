import SwiftUI

/// Everything Umpi is doing or waiting on: what needs the owner first, then what is running, then what finished.
/// Coding threads from every machine sit with Umpi's own work; chips narrow them to one machine.
struct WorkView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(DeviceCapabilities.self) private var effects
    @Environment(T3CodeModel.self) private var t3
    @State private var machineFilter: String?

    private var waitingJobs: [Job] { store.jobs.filter { $0.status == "pending_approval" } }
    private var runningJobs: [Job] { store.jobs.filter { $0.status == "queued" || $0.status == "running" } }
    private var openQuestions: [Choice] { store.choices.filter { $0.status == "pending" } }
    private var nextReminders: [Reminder] {
        store.reminders.filter { $0.status == "scheduled" }.sorted { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }.prefix(5).map { $0 }
    }
    private var shownMachines: [T3Machine] { t3.machines.filter { machineFilter == nil || $0.id == machineFilter } }
    private var threads: [(machine: T3Machine, thread: T3Thread)] {
        shownMachines.flatMap { machine in (machine.threads ?? []).filter { $0.subagent != true }.map { (machine, $0) } }
    }
    private var waitingThreads: [(machine: T3Machine, thread: T3Thread)] { threads.filter { $0.thread.status == "waiting" } }
    private var runningThreads: [(machine: T3Machine, thread: T3Thread)] { threads.filter { $0.thread.active && $0.thread.status != "waiting" } }
    private var recentThreads: [(machine: T3Machine, thread: T3Thread)] {
        Array(threads.filter { !$0.thread.active && !$0.thread.settled }.sorted { ($0.thread.updated ?? .distantPast) > ($1.thread.updated ?? .distantPast) }.prefix(5))
    }
    private var pendingRequests: [T3Request] {
        t3.pendingRequests.filter { request in machineFilter == nil || t3.machines.first { $0.id == machineFilter }?.label == request.machineLabel }
    }
    private var nothingWaiting: Bool { waitingJobs.isEmpty && openQuestions.isEmpty && effects.pendingReview.isEmpty && waitingThreads.isEmpty && pendingRequests.isEmpty }
    private var multipleMachines: Bool { t3.machines.count > 1 }

    var body: some View {
        PlatformList {
            #if os(iOS)
            if multipleMachines { chips }
            #endif
            if nothingWaiting {
                Section { Label("Nothing is waiting on you", systemImage: "checkmark.circle").foregroundStyle(.secondary) }
            } else {
                Section("Needs you") {
                    ForEach(pendingRequests) { request in
                        NavigationLink { T3RequestView(id: request.id) } label: {
                            WorkRow(symbol: "hand.raised.fill", tint: .orange, title: request.headline, detail: "Umpi's idea · \(request.machineLabel)")
                        }
                    }
                    ForEach(waitingThreads, id: \.thread.id) { item in
                        NavigationLink { T3ThreadView(machine: item.machine, thread: item.thread) } label: {
                            WorkRow(symbol: "questionmark", tint: .orange, title: item.thread.title, detail: "Waiting on you · \(item.machine.name)")
                        }
                    }
                    ForEach(effects.pendingReview) { action in
                        NavigationLink { DeviceActionReviewView(action: action) } label: { WorkRow(symbol: "iphone", tint: .orange, title: action.capability, detail: "Review on this phone") }
                    }
                    ForEach(waitingJobs) { job in
                        NavigationLink { JobDetailView(jobID: job.id) } label: { WorkRow(symbol: "terminal", tint: .orange, title: job.command, detail: "Command for your Mac", mono: true) }
                    }
                    ForEach(openQuestions) { choice in
                        NavigationLink { ChoiceDetailView(choice: choice) } label: { WorkRow(symbol: "questionmark.bubble", tint: .orange, title: ReminderRow.title(choice.question), detail: "Umpi asks") }
                    }
                }
            }
            if !runningThreads.isEmpty || !runningJobs.isEmpty || shownMachines.contains(where: { $0.problem != nil }) {
                Section("Running") {
                    ForEach(runningThreads, id: \.thread.id) { item in
                        NavigationLink { T3ThreadView(machine: item.machine, thread: item.thread) } label: { T3ThreadRow(thread: item.thread, machine: multipleMachines ? item.machine.name : nil) }
                    }
                    ForEach(runningJobs) { job in
                        NavigationLink { JobDetailView(jobID: job.id) } label: {
                            Label { Text(job.command).font(.system(.callout, design: .monospaced)).lineLimit(1) } icon: { ProgressView().controlSize(.small) }
                        }
                    }
                    ForEach(shownMachines.filter { $0.problem != nil }) { machine in
                        Label("\(machine.label) didn't answer", systemImage: "wifi.slash").font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            if !recentThreads.isEmpty {
                Section("Recent") {
                    ForEach(recentThreads, id: \.thread.id) { item in
                        NavigationLink { T3ThreadView(machine: item.machine, thread: item.thread) } label: { T3ThreadRow(thread: item.thread, machine: multipleMachines ? item.machine.name : nil) }
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
        .readableWidth()
        .refreshable { await reload() }
        .onAppear { Task { async let threads: Void = t3.loadThreads(store); async let requests: Void = t3.loadRequests(store); _ = await (threads, requests) } }
        .navigationTitle("Work")
        .navigationBarTitleDisplayMode(.inline)
        #if os(macOS)
        // The Mac has no pull to refresh, and the machine chips become a toolbar menu.
        .toolbar {
            if multipleMachines {
                ToolbarItem(placement: .primaryAction) {
                    Picker("Machine", selection: $machineFilter) {
                        Text("All machines").tag(String?.none)
                        Divider()
                        ForEach(t3.machines) { machine in Text(machine.name).tag(Optional(machine.id)) }
                    }
                    .pickerStyle(.menu)
                    .help("Show the work of one machine")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await reload() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .help("Refresh")
                    .keyboardShortcut("r")
            }
        }
        #endif
    }

    private func reload() async {
        async let sync: Void = store.synchronize(); async let threads: Void = t3.loadThreads(store); async let requests: Void = t3.loadRequests(store)
        _ = await (sync, threads, requests)
    }

    /// All machines, or one: a quiet row of chips above the lists.
    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                chip("All", selected: machineFilter == nil) { machineFilter = nil }
                ForEach(t3.machines) { machine in chip(machine.name, selected: machineFilter == machine.id) { machineFilter = machine.id } }
            }
            .padding(.horizontal, 2)
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
    }
    private func chip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                .padding(.horizontal, 13).padding(.vertical, 7)
                .foregroundStyle(selected ? Color(.systemBackground) : .primary)
                .background(selected ? Color.primary : Color(.secondarySystemBackground), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// One line of something that needs the owner: a small tinted symbol, a title, and where it comes from.
private struct WorkRow: View {
    let symbol: String
    let tint: Color
    let title: String
    let detail: String
    var mono = false
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 13, weight: .semibold)).foregroundStyle(tint)
                .frame(width: 28, height: 28).background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(mono ? .system(.callout, design: .monospaced) : .body).lineLimit(1)
                Text(detail).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

/// One approval, full screen: the same card as in the chat.
struct T3RequestView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(T3CodeModel.self) private var t3
    @Environment(\.dismiss) private var dismiss
    let id: String
    var body: some View {
        ScrollView {
            if let request = t3.request(id) {
                T3ApprovalCard(request: request) { approve in
                    Task { await t3.decide(store, id, approve: approve) }
                }
                .padding(20)
            } else {
                ProgressView().padding(.top, 80)
            }
        }
        .readableWidth()
        .navigationTitle("Approval")
        .navigationBarTitleDisplayMode(.inline)
        .task { await t3.loadRequests(store) }
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
        .readableWidth()
        .navigationTitle("Reminder")
        .navigationBarTitleDisplayMode(.inline)
    }
}
