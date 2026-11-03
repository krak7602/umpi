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
                LazyVStack(alignment: .leading, spacing: 10) {
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
                        ChatBubble(entry: entry).id(entry.seq)
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
            if let error = chat.errorMessage {
                Text(error).font(.footnote).padding(8).background(.thinMaterial, in: Capsule()).padding(.top, 4)
            }
        }
        .task { await chat.stayLive(store) }
        .refreshable { await chat.refresh(store) }
    }

    private var composer: some View {
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
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }
}

private struct ChatBubble: View {
    let entry: ChatEntry

    var body: some View {
        VStack(alignment: entry.fromOwner ? .trailing : .leading, spacing: 4) {
            VStack(alignment: .leading, spacing: 6) {
                if let file = entry.file { Label(file, systemImage: "doc").font(.footnote.weight(.semibold)) }
                if let images = entry.images { Label(images == 1 ? "Image" : "\(images) images", systemImage: "photo").font(.footnote.weight(.semibold)) }
                Text(rendered).textSelection(.enabled)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .foregroundStyle(entry.fromOwner ? Color.white : Color.primary)
            .background(entry.fromOwner ? Color.accentColor : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
            if let rows = entry.buttons {
                // Buttons are shown for reference until they can be answered here; Telegram still takes the answer.
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack { ForEach(row, id: \.data) { button in Text(button.label).font(.footnote).padding(.horizontal, 10).padding(.vertical, 5).overlay(Capsule().stroke(.tertiary)) } }
                }
            }
            Text(caption).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: entry.fromOwner ? .trailing : .leading)
        .padding(entry.fromOwner ? .leading : .trailing, 40)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.entry.\(entry.seq)")
    }

    private var rendered: AttributedString {
        (try? AttributedString(markdown: entry.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(entry.text)
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
            Text(text)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .foregroundStyle(.white)
                .background(Color.accentColor.opacity(0.6), in: RoundedRectangle(cornerRadius: 18))
            Text(failed ? "Not sent — see Settings › Queued changes" : "Sending…").font(.caption2).foregroundStyle(failed ? .red : .secondary)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 40)
    }
}
