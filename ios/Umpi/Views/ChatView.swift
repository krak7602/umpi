import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The owner's shared conversation: what was said in Telegram and here, and what Umpi sent on its own.
struct ChatView: View {
    @Environment(CompanionStore.self) private var store
    @State private var chat = ChatModel()
    @State private var draft = ""
    @FocusState private var composing: Bool
    @State private var attachment: PreparedAttachment?
    @State private var preparing: String?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var recorder = VoiceRecorder()

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
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: MediaPrep.maxImages, matching: .any(of: [.images, .videos]))
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            prepare("Preparing…") { try await PreparedAttachment.photos(items) }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: PreparedAttachment.fileTypes) { result in
            guard case .success(let url) = result else { return }
            prepare(url.pathExtension.isEmpty ? "Reading…" : "Reading \(url.lastPathComponent)…") { try await PreparedAttachment.file(url) }
        }
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

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachment != nil }

    private var composerRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let attachment {
                HStack {
                    Label(attachment.summary, systemImage: attachment.symbol).font(.footnote).lineLimit(1)
                    Spacer()
                    Button { self.attachment = nil } label: { Image(systemName: "xmark.circle.fill") }.foregroundStyle(.secondary).accessibilityLabel("Remove attachment")
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            if let preparing { Label(preparing, systemImage: "hourglass").font(.footnote).foregroundStyle(.secondary) }
            if recorder.isRecording { recordingBar } else { inputRow }
        }
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Menu {
                Button { showPhotos = true } label: { Label("Photos and videos", systemImage: "photo.on.rectangle") }
                Button { showFiles = true } label: { Label("Files and audio", systemImage: "doc") }
            } label: {
                Image(systemName: "plus.circle.fill").font(.system(size: 30)).symbolRenderingMode(.hierarchical)
            }
            .disabled(preparing != nil)
            .accessibilityIdentifier("chat.attach")
            .accessibilityLabel("Attach")
            TextField("Message Umpi", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composing)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                .accessibilityIdentifier("chat.input")
            if canSend {
                Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)) }
                    .disabled(preparing != nil)
                    .accessibilityIdentifier("chat.send")
                    .accessibilityLabel("Send")
            } else {
                Button { Task { await startRecording() } } label: { Image(systemName: "mic.circle.fill").font(.system(size: 32)).symbolRenderingMode(.hierarchical) }
                    .disabled(preparing != nil)
                    .accessibilityIdentifier("chat.record")
                    .accessibilityLabel("Record a voice note")
            }
        }
    }

    private var recordingBar: some View {
        HStack(spacing: 12) {
            Button { _ = recorder.stop(keep: false) } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 28)) }
                .foregroundStyle(.secondary).accessibilityLabel("Cancel recording")
            Image(systemName: "waveform").symbolEffect(.variableColor.iterative, isActive: true).foregroundStyle(.red)
            if let started = recorder.startedAt {
                Text(started, style: .timer).monospacedDigit().foregroundStyle(.secondary)
            }
            Spacer()
            Button { finishRecording() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)) }
                .accessibilityIdentifier("chat.record.send").accessibilityLabel("Send voice note")
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color(.secondarySystemBackground), in: Capsule())
    }

    private func send() {
        let text = [draft.trimmingCharacters(in: .whitespacesAndNewlines), attachment?.text ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
        let sending = attachment
        let previous = draft
        draft = ""; attachment = nil
        Task {
            if await store.sendChat(text: text, attachment: sending?.value) { await chat.refresh(store) } else { draft = previous; attachment = sending }
        }
    }
    private func prepare(_ label: String, _ work: @escaping @MainActor () async throws -> PreparedAttachment) {
        preparing = label
        Task {
            defer { preparing = nil }
            do { attachment = try await work() } catch { chat.show((error as? LocalizedError)?.errorDescription ?? "The attachment could not be read.") }
        }
    }
    private func startRecording() async {
        do { try await recorder.start() } catch { chat.show((error as? LocalizedError)?.errorDescription ?? "Recording could not start.") }
    }
    /// A voice note is transcribed on the phone and sent as its transcript, like a Telegram voice note.
    private func finishRecording() {
        guard let url = recorder.stop(keep: true) else { return }
        preparing = "Transcribing…"
        Task {
            defer { preparing = nil; try? FileManager.default.removeItem(at: url) }
            do {
                let transcript = try await MediaPrep.transcribe(url)
                if await store.sendChat(text: transcript, voice: true) { await chat.refresh(store) }
            } catch { chat.show((error as? LocalizedError)?.errorDescription ?? "The voice note could not be transcribed.") }
        }
    }
}

/// An attachment ready to send: what it shows in the composer, what it uploads, and text it adds (a transcript).
struct PreparedAttachment {
    var summary: String
    var symbol: String
    var value: OutgoingAttachment?
    var text: String?

    static let fileTypes: [UTType] = [.plainText, .text, .utf8PlainText, .commaSeparatedText, .json, .pdf, .audio, .movie]
        + ["net.daringfireball.markdown", "org.openxmlformats.wordprocessingml.document"].compactMap { UTType($0) }

    @MainActor static func photos(_ items: [PhotosPickerItem]) async throws -> PreparedAttachment {
        if let videoItem = items.first(where: { $0.supportedContentTypes.contains { $0.conforms(to: .movie) } }) {
            guard let movie = try await videoItem.loadTransferable(type: PickedMovie.self) else { throw MediaError.unreadable("The video could not be loaded.") }
            defer { try? FileManager.default.removeItem(at: movie.url) }
            return try await video(movie.url, name: "Video")
        }
        var images: [UIImage] = []
        for item in items {
            if let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) { images.append(image) }
        }
        guard !images.isEmpty else { throw MediaError.unreadable("The photos could not be loaded.") }
        return .init(summary: images.count == 1 ? "1 photo" : "\(images.count) photos", symbol: "photo", value: .init(images: try MediaPrep.images(images)))
    }

    @MainActor static func file(_ url: URL) async throws -> PreparedAttachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let type = UTType(filenameExtension: url.pathExtension) ?? .data
        if type.conforms(to: .movie) { return try await video(url, name: url.lastPathComponent) }
        if type.conforms(to: .audio) {
            let transcript = try await MediaPrep.transcribe(url)
            return .init(summary: "\(url.lastPathComponent), transcribed", symbol: "waveform", value: nil, text: "Audio file \"\(url.lastPathComponent)\", transcribed:\n\n\(transcript)")
        }
        return .init(summary: url.lastPathComponent, symbol: "doc.text", value: .init(file: try MediaPrep.file(at: url)))
    }

    /// Claude cannot watch video: it gets a few frames and a transcript of the speech.
    @MainActor static func video(_ url: URL, name: String) async throws -> PreparedAttachment {
        let frames = try await MediaPrep.frames(of: url)
        var transcript: String?, problem: String?
        if await MediaPrep.hasAudio(url) {
            do { transcript = try await MediaPrep.transcribe(url) } catch { problem = (error as? LocalizedError)?.errorDescription ?? "speech could not be transcribed" }
        }
        let note = "\(name): \(frames.count) frames from across the video are attached." + (transcript.map { " Its speech, transcribed:\n\n\($0)" } ?? " No speech was transcribed.")
        let summary = "\(name), \(frames.count) frames" + (transcript != nil ? " and transcript" : problem.map { " (no transcript: \($0))" } ?? "")
        return .init(summary: summary, symbol: "film", value: .init(images: try MediaPrep.images(frames)), text: note)
    }
}

/// A picked video, copied to a temporary file so it can be read and then removed.
struct PickedMovie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { SentTransferredFile($0.url) } importing: { received in
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).\(received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
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
    /// A message Umpi started (a reminder, the brief, an alert): full width like a reply, with a small label naming it.
    private var messageCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(cardTitle, systemImage: cardSymbol).font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
            MarkdownView(entry.text).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
