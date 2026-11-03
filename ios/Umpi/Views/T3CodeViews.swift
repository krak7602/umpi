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
            Text("Umpi reaches your coding threads through your tailnet or T3 Connect; nothing runs on the machine. Approval lasts 30 days.")
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
                    Label("Choose Full access, or Supervised, so Umpi can message, start, and stop threads. Read only lets it just look.", systemImage: "2.circle")
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

extension T3Thread {
    /// Colour only says status: blue working, orange waiting on you, green done, red failed.
    var tint: Color {
        switch status {
        case "running", "starting", "preparing", "queued": .accentColor
        case "waiting": .orange
        case "completed": .green
        case "failed": .red
        default: .secondary
        }
    }
}

/// A thread in a list: a status dot, its title, and one quiet line of where and when.
struct T3ThreadRow: View {
    let thread: T3Thread
    var machine: String?
    var body: some View {
        HStack(spacing: 12) {
            Circle().fill(thread.tint).frame(width: 8, height: 8)
                .overlay { if thread.status == "running" { Circle().stroke(thread.tint.opacity(0.35), lineWidth: 4).frame(width: 16, height: 16) } }
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.title).lineLimit(1)
                Text([thread.statusText, thread.project].compactMap { $0 }.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                if let updated = thread.updated { Text(updated, format: .relative(presentation: .numeric, unitsStyle: .narrow)).font(.caption).foregroundStyle(.secondary) }
                if let machine { Text(machine).font(.caption2).foregroundStyle(.tertiary).lineLimit(1) }
            }
        }
    }
}

/// An action Umpi decided on and asks the owner to approve. The same card shows in the chat and in Work, and it
/// changes in place once it is answered.
struct T3ApprovalCard: View {
    let request: T3Request
    /// The message's buttons, Approve then Decline; nil where the card cannot be answered.
    var answer: ((Bool) -> Void)?
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "hand.raised.fill").font(.system(size: 14, weight: .semibold)).foregroundStyle(.orange)
                    .frame(width: 30, height: 30).background(Color.orange.opacity(0.16), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(request.pending ? "NEEDS YOUR OK" : "UMPI ASKED").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Text(request.headline).font(.body.weight(.semibold)).lineLimit(2)
                }
            }
            Text(request.place).font(.footnote).foregroundStyle(.secondary)
            if let quoted = request.quoted, !quoted.isEmpty {
                Text(quoted).lineLimit(8).textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 9).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            if let why = request.why { (Text("Why  ").fontWeight(.semibold).foregroundStyle(.primary) + Text(why)).font(.footnote).foregroundStyle(.secondary) }
            state
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onChange(of: request.status) { _, _ in working = false }
    }

    @ViewBuilder private var state: some View {
        if request.pending && working {
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Sending to \(request.machineLabel)…") }.font(.subheadline).padding(.top, 2)
        } else if request.pending, let answer {
            HStack(spacing: 8) {
                Button { working = true; answer(false) } label: { Text("Decline").foregroundStyle(.primary).frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).tint(Color(.systemGray))
                Button { working = true; answer(true) } label: { Text("Approve").fontWeight(.semibold).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.large).padding(.top, 2)
            if let expires = request.expires {
                Text("Runs once · expires \(expires, format: .relative(presentation: .named))").font(.caption2).foregroundStyle(.tertiary).frame(maxWidth: .infinity)
            }
        } else {
            HStack(spacing: 6) {
                switch request.status {
                case "done":
                    Image(systemName: "checkmark").foregroundStyle(.green)
                    Text("Done").foregroundStyle(.primary)
                    if let decided = request.decided { Text(decided, format: .dateTime.hour().minute()).foregroundStyle(.secondary) }
                case "failed":
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.red)
                    Text(request.outcome ?? "It did not work").foregroundStyle(.secondary).lineLimit(2)
                case "declined":
                    Image(systemName: "xmark").foregroundStyle(.secondary); Text("Declined · nothing changed").foregroundStyle(.secondary)
                case "expired":
                    Image(systemName: "hourglass").foregroundStyle(.tertiary); Text("Expired").foregroundStyle(.tertiary)
                default:
                    Text("Waiting").foregroundStyle(.secondary)
                }
            }
            .font(.subheadline).padding(.top, 2)
        }
    }
}

/// A thread: its status at the top, the latest messages, what the agent asks, and a reply. Deeper work belongs in
/// T3 Code itself.
struct T3ThreadView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(T3CodeModel.self) private var t3
    let machine: T3Machine
    let thread: T3Thread
    @State private var read: T3ThreadRead?
    @State private var problem: String?
    @State private var questions: [T3QuestionSet] = []
    @State private var draft = ""
    @State private var sending = false
    @State private var notice: String?
    @State private var confirmStop = false
    @FocusState private var composing: Bool

    private var current: T3Thread { read?.thread.map { fresh in var merged = thread; merged.status = fresh.status; return merged } ?? thread }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if let read {
                        if read.messages.isEmpty { Text("No messages yet").foregroundStyle(.secondary) }
                        ForEach(read.messages) { message in
                            if message.fromOwner {
                                Text(message.text).lineLimit(14).textSelection(.enabled)
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 14).padding(.vertical, 9)
                                    .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                                    .frame(maxWidth: .infinity, alignment: .trailing).padding(.leading, 48)
                                    .id(message.position)
                            } else {
                                MarkdownView(message.text).textSelection(.enabled).id(message.position)
                            }
                        }
                        ForEach(questions) { set in
                            ForEach(set.questions) { question in
                                T3QuestionCard(question: question) { value in Task { await answer(set, question, value) } }
                            }
                        }
                        if current.status == "waiting" && questions.isEmpty {
                            Label("It may be waiting for a permission. Answer that in T3 Code.", systemImage: "hand.raised")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Color.clear.frame(height: 1).id("end")
                    } else if let problem {
                        ContentUnavailableView("Couldn't read the thread", systemImage: "exclamationmark.triangle", description: Text(problem))
                    } else {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 12)
            }
            .softScrollEdges()
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await load() }
            .task { await load(); proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: read?.messages.last?.position) { _, _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .overlay(alignment: .top) {
            if let notice {
                Text(notice).font(.footnote).padding(.horizontal, 12).padding(.vertical, 8).background(.thinMaterial, in: Capsule()).padding(.top, 4)
                    .task(id: notice) { try? await Task.sleep(for: .seconds(4)); self.notice = nil }
            }
        }
        .navigationTitle(thread.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if current.active {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) { confirmStop = true } label: { Image(systemName: "stop.fill").foregroundStyle(.red) }.accessibilityLabel("Stop thread")
                }
            }
        }
        .confirmationDialog("Stop this thread?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop", role: .destructive) { Task { await perform("stop") } }
        } message: { Text("Like T3 Code's Stop button: the running turn ends and queued messages wait.") }
        .disabled(!machine.connected)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(current.statusText).font(.caption.weight(.semibold)).foregroundStyle(current.tint)
                    .padding(.horizontal, 9).padding(.vertical, 4).background(current.tint.opacity(0.15), in: Capsule())
                Spacer()
                Text(machine.label).font(.caption).foregroundStyle(.secondary)
            }
            let place = [thread.project, thread.branch].compactMap { $0 }
            if !place.isEmpty { Text(place.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary).lineLimit(1) }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    /// A message to the thread's agent: it starts an idle thread, steers a running turn, or waits its turn.
    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Reply to the agent", text: $draft, axis: .vertical)
                .lineLimit(1...6).focused($composing)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            Button { Task { await perform("send") } } label: {
                Image(systemName: sending ? "ellipsis.circle.fill" : "arrow.up.circle.fill").font(.system(size: 32))
            }
            .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send to thread")
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    private func perform(_ kind: String) async {
        sending = true; defer { sending = false }
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await t3.act(store, machine: machine.id, thread: thread.threadId, kind: kind, message: kind == "send" ? message : nil)
            if kind == "send" { draft = ""; composing = false }
            notice = kind == "send" ? "Sent to \(machine.label)" : "Stopped"
            try? await Task.sleep(for: .seconds(2))
            await load()
            await t3.loadThreads(store)
        } catch {
            notice = (error as? LocalizedError)?.errorDescription ?? "It did not reach the machine."
        }
    }

    private func answer(_ set: T3QuestionSet, _ question: T3QuestionSet.Question, _ value: T3CodeModel.AnswerValue) async {
        do {
            try await t3.answer(store, machine: machine.id, thread: thread.threadId, question: set.requestId, answers: [question.id: value])
            questions.removeAll { $0.requestId == set.requestId }
            notice = "Answered"
            try? await Task.sleep(for: .seconds(2))
            await load()
            await t3.loadThreads(store)
        } catch { notice = (error as? LocalizedError)?.errorDescription ?? "The answer did not reach the machine." }
    }

    private func load() async {
        do {
            read = try await t3.read(store, machine: machine.id, thread: thread.threadId); problem = nil
            questions = current.status == "waiting" ? await t3.questions(store, machine: machine.id, thread: thread.threadId) : []
        } catch { problem = (error as? LocalizedError)?.errorDescription ?? "The machine did not answer." }
    }
}

/// What an agent asks, with its choices as plain rows: a tap answers. No frame, no colour: it reads as part of the thread.
struct T3QuestionCard: View {
    let question: T3QuestionSet.Question
    let answer: (T3CodeModel.AnswerValue) -> Void
    @State private var picked: Set<String> = []
    @State private var own = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("THE AGENT ASKS").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(question.question).font(.body.weight(.semibold))
            ForEach(question.options, id: \.label) { option in
                let value = option.value ?? option.label
                Button {
                    if question.multiSelect == true { if picked.contains(value) { picked.remove(value) } else { picked.insert(value) } }
                    else { answer(.one(value)) }
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label).foregroundStyle(.primary)
                            if let detail = option.description, !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        if question.multiSelect == true { Image(systemName: picked.contains(value) ? "checkmark.circle.fill" : "circle").foregroundStyle(picked.contains(value) ? Color.accentColor : .secondary) }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
            }
            if question.multiSelect == true {
                Button("Answer") { answer(.many(Array(picked))) }.buttonStyle(.borderedProminent).disabled(picked.isEmpty)
            }
            if question.allowCustomAnswer == true || question.options.isEmpty {
                HStack {
                    TextField("Your own answer", text: $own).textFieldStyle(.plain)
                    Button("Send") { answer(.one(own.trimmingCharacters(in: .whitespacesAndNewlines))) }.disabled(own.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
