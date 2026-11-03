import SwiftUI

/// Settings: the T3 Code machines Umpi reads, how to add one, and approval again after 30 days.
struct T3MachinesSection: View {
    @Environment(CompanionStore.self) private var store
    @Environment(T3CodeModel.self) private var t3
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var adding = false
    @State private var message: String?

    var body: some View {
        Section {
            ForEach(t3.machines) { machine in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(machine.label)
                        Spacer()
                        if !machine.connected {
                            Button(machine.status == "pending" ? "Open approval" : "Approve again") { Task { await approve(machine) } }
                                .buttonStyle(.borderless)
                        }
                    }
                    Text(machine.summary).font(.footnote).foregroundStyle(machine.connected ? Color.secondary : Color.orange)
                }
                .swipeActions { Button("Remove", role: .destructive) { Task { await t3.remove(store, machine) } } }
            }
            Button { adding = true } label: { Label("Add a machine", systemImage: "plus") }
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
        } header: { Text("T3 Code") } footer: {
            Text("Umpi reads your coding threads through your tailnet or T3 Connect; nothing runs on the machine. Approval lasts 30 days.")
        }
        .task { await t3.loadMachines(store) }
        // Back from the approval page in Safari: show the new state.
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await t3.loadMachines(store) } } }
        .sheet(isPresented: $adding) { T3AddMachineView { page in adding = false; openURL(page) } }
    }

    private func approve(_ machine: T3Machine) async {
        do { openURL(try await t3.approve(store, machine)); message = nil }
        catch { message = (error as? LocalizedError)?.errorDescription ?? "Approval could not start." }
    }
}

/// Paste the machine's MCP address; Umpi then opens the machine's approval page, where the owner enters a pairing code.
struct T3AddMachineView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(T3CodeModel.self) private var t3
    @Environment(\.dismiss) private var dismiss
    let opened: (URL) -> Void
    @State private var address = ""
    @State private var name = ""
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://…/mcp", text: $address)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Name (optional)", text: $name)
                } header: { Text("MCP address") } footer: {
                    Text("On the machine, in T3 Code: Settings → Environments → Copy MCP URL. Its Tailscale address (…ts.net/mcp) or its T3 Connect address both work.")
                }
                Section {
                    Label("Approve on the next page with a pairing code from T3 Code: Settings → Sharing & access.", systemImage: "1.circle")
                    Label("Choose Read only. Umpi only reads threads for now.", systemImage: "2.circle")
                }
                .font(.footnote).foregroundStyle(.secondary)
                if let problem { Section { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) } }
            }
            .navigationTitle("Add a machine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if working { ProgressView() } else {
                        Button("Continue") { Task { await submit() } }
                            .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .task {
                if address.isEmpty, let pasted = UIPasteboard.general.string, pasted.hasPrefix("https://"), pasted.contains("/mcp") { address = pasted }
            }
        }
    }

    private func submit() async {
        working = true; defer { working = false }
        do { opened(try await t3.add(store, url: address.trimmingCharacters(in: .whitespacesAndNewlines), label: name.trimmingCharacters(in: .whitespaces))) }
        catch { problem = (error as? LocalizedError)?.errorDescription ?? "The machine could not be added." }
    }
}

/// Work: what the coding agents on each machine are doing. Active threads first, then the latest few.
struct T3WorkSection: View {
    @Environment(T3CodeModel.self) private var t3

    var body: some View {
        ForEach(t3.machines.filter { $0.connected || $0.problem != nil || $0.threads != nil }) { machine in
            Section {
                if let problem = machine.problem {
                    Label(problem, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
                }
                ForEach(T3WorkSection.shown(machine.threads ?? [])) { thread in
                    NavigationLink { T3ThreadView(machine: machine, thread: thread) } label: { T3ThreadRow(thread: thread) }
                }
                if machine.connected, let threads = machine.threads, T3WorkSection.shown(threads).isEmpty, machine.problem == nil {
                    Text("Nothing running").foregroundStyle(.secondary)
                }
            } header: {
                Text(t3.machines.count > 1 ? "Coding · \(machine.label)" : "Coding")
            }
        }
    }

    /// Working first, then the most recent unsettled ones; six at most. Threads waiting on the owner show under Needs you.
    static func shown(_ threads: [T3Thread]) -> [T3Thread] {
        let top = threads.filter { $0.subagent != true && $0.status != "waiting" }
        let active = top.filter(\.active)
        let rest = top.filter { !$0.active && !$0.settled }
        return Array((active + rest).prefix(6))
    }
}

struct T3ThreadRow: View {
    let thread: T3Thread
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: thread.symbol)
                .foregroundStyle(thread.status == "waiting" ? Color.orange : thread.status == "failed" ? Color.red : Color.accentColor)
                .symbolEffect(.pulse, isActive: thread.status == "running")
            VStack(alignment: .leading, spacing: 3) {
                Text(thread.title).lineLimit(1)
                HStack(spacing: 4) {
                    Text(thread.statusText)
                    if let project = thread.project { Text("· \(project)") }
                    if let updated = thread.updated { Text("· \(updated, format: .relative(presentation: .named))") }
                }
                .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

/// A thread's latest messages: the owner's requests in a quiet box, the agent's answers as notes.
struct T3ThreadView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(T3CodeModel.self) private var t3
    let machine: T3Machine
    let thread: T3Thread
    @State private var read: T3ThreadRead?
    @State private var problem: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    if let read {
                        if read.messages.isEmpty { Text("No messages yet").foregroundStyle(.secondary) }
                        ForEach(read.messages) { message in
                            if message.fromOwner {
                                Text(message.text).textSelection(.enabled).lineLimit(12)
                                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                    .id(message.position)
                            } else {
                                MarkdownView(message.text).textSelection(.enabled).id(message.position)
                            }
                        }
                    } else if let problem {
                        ContentUnavailableView("Couldn't read the thread", systemImage: "exclamationmark.triangle", description: Text(problem))
                    } else {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 12)
            }
            .softScrollEdges()
            .refreshable { await load() }
            .task { await load(); if let last = read?.messages.last { proxy.scrollTo(last.position, anchor: .bottom) } }
        }
        .navigationTitle(thread.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        let current = read?.thread ?? thread
        return VStack(alignment: .leading, spacing: 4) {
            Label(current.statusText, systemImage: current.symbol).font(.subheadline.weight(.medium))
            Text([thread.project, thread.branch, machine.label].compactMap { $0 }.joined(separator: " · "))
                .font(.footnote).foregroundStyle(.secondary)
            Text("Showing the latest messages. Open the thread in T3 Code to continue it.").font(.caption).foregroundStyle(.tertiary)
        }
    }

    private func load() async {
        do { read = try await t3.read(store, machine: machine.id, thread: thread.threadId); problem = nil }
        catch { problem = (error as? LocalizedError)?.errorDescription ?? "The machine did not answer." }
    }
}
