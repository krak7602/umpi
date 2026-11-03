import SwiftUI

/// The owner's shared conversation: what was said in Telegram and here, and what Umpi sent on its own.
struct ChatView: View {
    @Environment(CompanionStore.self) private var store
    @State private var chat = ChatModel()
    @State private var draft = ""
    @FocusState private var composing: Bool

    var body: some View {
        let pending = store.pendingMessages
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if chat.hasOlder {
                        Button("Load earlier messages") { Task { await chat.loadOlder(store) } }
                            .font(.footnote).frame(maxWidth: .infinity)
                    }
                    if chat.entries.isEmpty && pending.isEmpty && !chat.isLoading {
                        ContentUnavailableView("No messages yet", systemImage: "bubble.left.and.bubble.right",
                            description: Text("Messages from Telegram and this app appear here as one conversation."))
                            .padding(.top, 60)
                    }
                    ForEach(chat.entries) { entry in
                        ChatBubble(entry: entry) { data in Task { await chat.press(store, seq: entry.seq, data: data) } }.id(entry.seq)
                    }
                    ForEach(pending, id: \.id) { message in
                        PendingBubble(text: message.text, failed: message.failed)
                    }
                    if chat.isThinking(pending: pending.filter { !$0.failed }.count) {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("Umpi is thinking…").font(.footnote).foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier("chat.thinking")
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: chat.entries.last?.seq) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: pending.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle("Chat")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Image(systemName: chat.isLive ? "dot.radiowaves.left.and.right" : "wifi.slash")
                    .foregroundStyle(chat.isLive ? Color.green : Color.secondary)
                    .accessibilityLabel(chat.isLive ? "Live" : "Not connected")
            }
        }
        .overlay(alignment: .top) {
            if let message = chat.notice ?? chat.errorMessage {
                Text(message).font(.footnote).padding(.horizontal, 12).padding(.vertical, 8).background(.thinMaterial, in: Capsule()).padding(.top, 4)
                    .onTapGesture { chat.clearNotice() }
                    .task(id: message) { try? await Task.sleep(for: .seconds(4)); chat.clearNotice() }
                    .accessibilityIdentifier("chat.notice")
            }
        }
        .task { await chat.stayLive(store) }
        .refreshable { await chat.refresh(store) }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if composing { formatBar }
            composerRow
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }

    /// Inserts Markdown the owner would otherwise type by hand; the text stays plain Markdown.
    private var formatBar: some View {
        HStack(spacing: 18) {
            Button { draft += draft.isEmpty || draft.hasSuffix(" ") || draft.hasSuffix("\n") ? "****" : " ****" } label: { Image(systemName: "bold") }
                .accessibilityLabel("Bold")
            Button { draft += draft.isEmpty || draft.hasSuffix("\n") ? "- " : "\n- " } label: { Image(systemName: "list.bullet") }
                .accessibilityLabel("List item")
            Button { draft += draft.isEmpty || draft.hasSuffix("\n") ? "- [ ] " : "\n- [ ] " } label: { Image(systemName: "checklist") }
                .accessibilityLabel("Checkbox")
            Button { draft += draft.isEmpty || draft.hasSuffix("\n") ? "```\n\n```" : "\n```\n\n```" } label: { Image(systemName: "chevron.left.forwardslash.chevron.right") }
                .accessibilityLabel("Code block")
            Spacer()
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message Umpi", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composing)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                .accessibilityIdentifier("chat.input")
            Button {
                let text = draft
                draft = ""
                Task {
                    if await store.requestAgent(text: text) { await chat.refresh(store) } else { draft = text }
                }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("chat.send")
            .accessibilityLabel("Send")
        }
    }
}

private struct ChatBubble: View {
    let entry: ChatEntry
    let press: (String) -> Void

    var body: some View {
        VStack(alignment: entry.fromOwner ? .trailing : .leading, spacing: 6) {
            if entry.fromOwner { ownerBubble } else if entry.kind == "message" { messageCard } else { reply }
            if let rows = entry.buttons { buttons(rows) }
            Text(caption).font(.caption2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: entry.fromOwner ? .trailing : .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.entry.\(entry.seq)")
    }

    /// The owner's message: a Messages-style tinted bubble on the right.
    private var ownerBubble: some View {
        VStack(alignment: .leading, spacing: 6) {
            attachments
            MarkdownView(entry.text, onOwnerTint: true).textSelection(.enabled)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .foregroundStyle(.white)
        .tint(.white)
        .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .padding(.leading, 48)
    }
    /// Umpi's reply reads like a note: full width, no bubble.
    private var reply: some View {
        MarkdownView(entry.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
    /// A message Umpi started (a reminder, the brief, an alert): a card, so it stands apart from the conversation.
    private var messageCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(cardTitle, systemImage: cardSymbol).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            MarkdownView(entry.text).textSelection(.enabled)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
    @ViewBuilder private var attachments: some View {
        if let file = entry.file { Label(file, systemImage: "doc.text").font(.footnote.weight(.semibold)) }
        if let images = entry.images { Label(images == 1 ? "Photo" : "\(images) photos", systemImage: "photo").font(.footnote.weight(.semibold)) }
    }
    private func buttons(_ rows: [[ChatEntry.Button]]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 8) {
                    ForEach(row, id: \.data) { button in
                        Button(button.label) { press(button.data) }
                            .buttonStyle(.bordered).buttonBorderShape(.capsule)
                            .accessibilityIdentifier("chat.button.\(entry.seq).\(button.label)")
                    }
                }
            }
        }
    }

    private var cardTitle: String {
        let id = entry.id
        if id.hasPrefix("umpi:reminder:") { return "Reminder" }
        if id.hasPrefix("umpi:approval:") || id.hasPrefix("umpi:coding-approval:") { return "Needs your approval" }
        if id.hasPrefix("umpi:choice:") { return "Question" }
        if id.hasPrefix("umpi:alert:") { return "Coming up" }
        if id.hasPrefix("umpi:memory:") { return "Memory" }
        return "Umpi"
    }
    private var cardSymbol: String {
        switch cardTitle {
        case "Reminder": "bell"
        case "Needs your approval": "checkmark.shield"
        case "Question": "questionmark.bubble"
        case "Coming up": "calendar"
        case "Memory": "brain"
        default: "sparkles"
        }
    }
    private var caption: String {
        var parts: [String] = []
        if let date = entry.date { parts.append(date.formatted(date: .omitted, time: .shortened)) }
        // Umpi's own messages belong to both places; only what was said in Telegram is marked.
        if entry.surface == "telegram" && entry.kind != "message" { parts.append("Telegram") }
        if entry.kind == "voice" { parts.append("voice note") }
        return parts.joined(separator: " · ")
    }
}

private struct PendingBubble: View {
    let text: String
    let failed: Bool

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            MarkdownView(text, onOwnerTint: true)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .foregroundStyle(.white)
                .background(Color.accentColor.opacity(0.6), in: RoundedRectangle(cornerRadius: 18))
            Text(failed ? "Not sent — see Settings › Queued changes" : "Sending…").font(.caption2).foregroundStyle(failed ? .red : .secondary)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 40)
    }
}
