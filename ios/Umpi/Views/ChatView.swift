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
    @State private var pinned = true
    @State private var userScrolling = false
    /// The recording was started from the capture control: it is an idea to file in the notes.
    @State private var capturing = false

    var body: some View {
        let pending = store.pendingMessages
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if chat.hasOlder {
                        Button("Load earlier messages") { Task { await chat.loadOlder(store) } }
                            .font(.footnote).frame(maxWidth: .infinity)
                    }
                    if chat.entries.isEmpty && pending.isEmpty && !chat.isLoading {
                        ContentUnavailableView("No messages yet", systemImage: "bubble.left.and.bubble.right",
                            description: Text("Messages from Telegram and this app appear here as one conversation."))
                            .padding(.top, 60)
                    }
                    ForEach(Array(chat.entries.enumerated()), id: \.element.id) { index, entry in
                        let previous = index > 0 ? chat.entries[index - 1] : nil
                        // WhatsApp-style: a centred time starts each new stretch of conversation; consecutive messages
                        // from Umpi without one are parted by a thin line.
                        if let header = ChatView.timeHeader(entry, after: previous) {
                            Text(header).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.top, index == 0 ? 0 : 6)
                        } else if let previous, !previous.fromOwner, !entry.fromOwner {
                            Divider().padding(.horizontal, 40).opacity(0.6)
                        }
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
            // Content that grows after layout (a diagram, a photo) keeps the newest message in view, unless the owner
            // had scrolled up to read.
            // Pinned to the newest message while content grows (history loading, a diagram drawing, a reply), until the
            // owner scrolls up; scrolling back near the end pins it again.
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { old, new in
                if pinned && new > old { Task { @MainActor in proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 120
            } action: { _, nearEnd in
                if userScrolling { pinned = nearEnd }
            }
            .onScrollPhaseChange { _, phase in userScrolling = phase == .interacting || phase == .decelerating }
            .scrollDismissesKeyboard(.interactively)
            // A tap anywhere in the conversation puts the keyboard away; buttons and links in messages still work.
            .simultaneousGesture(TapGesture().onEnded { composing = false })
            .softScrollEdges()
            .onChange(of: chat.entries.last?.seq) { old, _ in
                // The first load jumps to the newest message; later ones scroll there.
                // Diagrams and photos size themselves after they render, so it settles once more a moment later.
                if old == nil { Task { @MainActor in
                    for delay in [50, 700] { try? await Task.sleep(for: .milliseconds(delay)); proxy.scrollTo("bottom", anchor: .bottom) }
                } }
                else { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .onChange(of: pending.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle("Chat")
        .navigationBarTitleDisplayMode(.inline)
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
        .onReceive(NotificationCenter.default.publisher(for: .umpiCaptureIdea)) { _ in
            guard !recorder.isRecording else { return }
            capturing = true
            Task { await startRecording() }
        }
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
        composerRow
            .padding(.horizontal).padding(.vertical, 8)
            .composerBackground()
    }

    /// Inserts Markdown the owner would otherwise type by hand; the text stays plain Markdown.
    @ViewBuilder private var formatButtons: some View {
        Button { draft += draft.isEmpty || draft.hasSuffix(" ") || draft.hasSuffix("\n") ? "****" : " ****" } label: { Label("Bold", systemImage: "bold") }
        Button { draft += draft.isEmpty || draft.hasSuffix("\n") ? "- " : "\n- " } label: { Label("List item", systemImage: "list.bullet") }
        Button { draft += draft.isEmpty || draft.hasSuffix("\n") ? "- [ ] " : "\n- [ ] " } label: { Label("Checklist item", systemImage: "checklist") }
        Button { draft += draft.isEmpty || draft.hasSuffix("\n") ? "```\n\n```" : "\n```\n\n```" } label: { Label("Code block", systemImage: "chevron.left.forwardslash.chevron.right") }
    }

    /// A centred time before a message that starts a new stretch: the first one, a new day, or 10 minutes after the last.
    static func timeHeader(_ entry: ChatEntry, after previous: ChatEntry?) -> String? {
        guard let date = entry.date else { return nil }
        if let previous, let before = previous.date, Calendar.current.isDate(before, inSameDayAs: date), date.timeIntervalSince(before) < 600 { return nil }
        let time = date.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDateInToday(date) { return "Today \(time)" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday \(time)" }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) + " " + time
    }

    /// One line of the message field: body text plus its vertical padding.
    static let fieldHeight: CGFloat = 40

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

    /// Messages-style: attach on the left; send or record inside the field, so the text takes the whole width.
    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            // One button, like Messages: attach when empty; while typing it also formats (Aa), with no floating bar.
            Menu {
                if composing || !draft.isEmpty {
                    Section("Format") { formatButtons }
                }
                Section("Attach") {
                    Button { showPhotos = true } label: { Label("Photos and videos", systemImage: "photo.on.rectangle") }
                    Button { showFiles = true } label: { Label("Files and audio", systemImage: "doc") }
                }
            } label: {
                Image(systemName: composing || !draft.isEmpty ? "textformat" : "plus").font(.system(size: 17, weight: .semibold)).frame(width: ChatView.fieldHeight, height: ChatView.fieldHeight)
                    .contentTransition(.symbolEffect(.replace))
                    .glassOrFill(in: Circle())
            }
            .tint(.primary)
            .disabled(preparing != nil)
            .accessibilityIdentifier("chat.attach")
            .accessibilityLabel("Attach")
            ZStack(alignment: .bottomTrailing) {
                TextField("Message Umpi", text: $draft, axis: .vertical)
                    .lineLimit(1...8)
                    .focused($composing)
                    .padding(.leading, 14).padding(.trailing, 42).padding(.vertical, 9)
                    .frame(minHeight: ChatView.fieldHeight)
                    .accessibilityIdentifier("chat.input")
                Group {
                    if canSend {
                        Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)).frame(width: 34, height: ChatView.fieldHeight) }
                            .disabled(preparing != nil)
                            .accessibilityIdentifier("chat.send")
                            .accessibilityLabel("Send")
                    } else {
                        Button { Task { await startRecording() } } label: { Image(systemName: "mic.fill").font(.system(size: 17, weight: .medium)).frame(width: 34, height: ChatView.fieldHeight) }
                            .tint(.secondary)
                            .disabled(preparing != nil)
                            .accessibilityIdentifier("chat.record")
                            .accessibilityLabel("Record a voice note")
                    }
                }
                // The button is as tall as one line of the field, so it is centred on a single line and stays on the
                // last line as the text grows.
                .padding(.trailing, 4)
            }
            .glassOrFill(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }

    private var recordingBar: some View {
        HStack(spacing: 12) {
            Button { _ = recorder.stop(keep: false); capturing = false } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 28)) }
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
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let sending = attachment
        let previous = draft
        draft = ""; attachment = nil
        Task {
            if await store.sendChat(text: text, attachment: sending?.value, context: sending?.context, media: sending?.media, previews: sending?.previews) {
                await chat.refresh(store)
            } else { draft = previous; attachment = sending }
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
        let seconds = recorder.startedAt.map { Int(Date().timeIntervalSince($0).rounded()) }
        guard let url = recorder.stop(keep: true) else { return }
        preparing = "Transcribing…"
        Task {
            defer { preparing = nil; try? FileManager.default.removeItem(at: url) }
            do {
                let transcript = try await MediaPrep.transcribe(url)
                let idea = capturing ? "Captured with the quick-capture button: this is an idea. File it in today's daily note (notes section) with add_to_daily_note, then confirm in one short line." : nil
                capturing = false
                if await store.sendChat(text: transcript, voice: true, context: idea, media: MediaInfo(kind: "voice", seconds: seconds), previews: LocalMedia(seconds: seconds)) {
                    await chat.refresh(store)
                }
            } catch { chat.show((error as? LocalizedError)?.errorDescription ?? "The voice note could not be transcribed.") }
        }
    }
}

/// An attachment ready to send: how the composer shows it, what it uploads, text for Umpi only, and its preview.
struct PreparedAttachment {
    var summary: String
    var symbol: String
    var value: OutgoingAttachment?
    var context: String?
    var media: MediaInfo
    var previews: LocalMedia

    static let fileTypes: [UTType] = [.plainText, .text, .utf8PlainText, .commaSeparatedText, .json, .pdf, .audio, .movie]
        + ["net.daringfireball.markdown", "org.openxmlformats.wordprocessingml.document"].compactMap { UTType($0) }

    @MainActor static func photos(_ items: [PhotosPickerItem]) async throws -> PreparedAttachment {
        if let videoItem = items.first(where: { $0.supportedContentTypes.contains { $0.conforms(to: .movie) } }) {
            guard let movie = try await videoItem.loadTransferable(type: PickedMovie.self) else { throw MediaError.unreadable("The video could not be loaded.") }
            defer { try? FileManager.default.removeItem(at: movie.url) }
            return try await video(movie.url, name: nil)
        }
        var images: [UIImage] = []
        for item in items {
            if let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) { images.append(image) }
        }
        guard !images.isEmpty else { throw MediaError.unreadable("The photos could not be loaded.") }
        return .init(summary: images.count == 1 ? "1 photo" : "\(images.count) photos", symbol: "photo", value: .init(images: try MediaPrep.images(images)),
                     media: MediaInfo(kind: "photos", count: images.count), previews: LocalMedia(thumbnails: images.compactMap(LocalMedia.thumbnail)))
    }

    @MainActor static func file(_ url: URL) async throws -> PreparedAttachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let type = UTType(filenameExtension: url.pathExtension) ?? .data
        let name = url.lastPathComponent
        if type.conforms(to: .movie) { return try await video(url, name: name) }
        if type.conforms(to: .audio) {
            let transcript = try await MediaPrep.transcribe(url)
            let seconds = await MediaPrep.seconds(of: url)
            return .init(summary: "\(name), transcribed", symbol: "waveform", value: nil, context: "Audio file \"\(name)\", transcribed:\n\n\(transcript)",
                         media: MediaInfo(kind: "audio", name: name, seconds: seconds), previews: LocalMedia(seconds: seconds))
        }
        let file = try MediaPrep.file(at: url)
        let bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? nil
        return .init(summary: name, symbol: "doc.text", value: .init(file: file), media: MediaInfo(kind: "file", name: name), previews: LocalMedia(bytes: bytes))
    }

    /// Claude cannot watch video: it gets a few frames and a transcript of the speech, as text for Umpi only.
    @MainActor static func video(_ url: URL, name: String?) async throws -> PreparedAttachment {
        let frames = try await MediaPrep.frames(of: url)
        let seconds = await MediaPrep.seconds(of: url)
        var transcript: String?, problem: String?
        if await MediaPrep.hasAudio(url) {
            do { transcript = try await MediaPrep.transcribe(url) } catch { problem = (error as? LocalizedError)?.errorDescription ?? "speech could not be transcribed" }
        }
        let label = name.map { "Video \"\($0)\"" } ?? "A video"
        let context = "\(label)\(seconds.map { " of \($0) seconds" } ?? ""): \(frames.count) frames from across it are attached in order."
            + (transcript.map { " Its speech, transcribed:\n\n\($0)" } ?? " No speech was transcribed.")
        let summary = "Video" + (seconds.map { " · \(ChatMediaView.duration($0))" } ?? "") + (transcript != nil ? " · transcribed" : problem.map { " · no transcript: \($0)" } ?? "")
        return .init(summary: summary, symbol: "film", value: .init(images: try MediaPrep.images(frames)), context: context,
                     media: MediaInfo(kind: "video", name: name, seconds: seconds, count: frames.count),
                     previews: LocalMedia(thumbnails: frames.prefix(1).compactMap(LocalMedia.thumbnail), seconds: seconds))
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
            if !caption.isEmpty { Text(caption).font(.caption2).foregroundStyle(.tertiary) }
        }
        .frame(maxWidth: .infinity, alignment: entry.fromOwner ? .trailing : .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.entry.\(entry.seq)")
    }

    /// The owner's message: a Messages-style tinted bubble on the right; media sits at its top, like Telegram.
    private var ownerBubble: some View {
        let local = entry.operationId.flatMap(LocalMedia.load)
        let caption = entry.text == "[Image without a caption]" || entry.text == "[File without a caption]" ? "" : entry.text
        let media = ChatMediaView(entry: entry, local: local)
        return VStack(alignment: .leading, spacing: 0) {
            if media.hasContent {
                media.padding(media.isVisual ? 3 : 0)
            }
            if !caption.isEmpty && entry.kind != "voice" || entry.kind == "voice" {
                MarkdownView(caption, onOwnerTint: true).textSelection(.enabled)
                    .font(entry.kind == "voice" ? .callout : .body)
                    .padding(.horizontal, 14).padding(.vertical, 9)
            }
        }
        .foregroundStyle(.white)
        .tint(.white)
        .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .frame(maxWidth: media.isVisual ? 280 : .infinity, alignment: .trailing)
        .padding(.leading, 48)
    }
    /// Umpi's reply reads like a note: full width, no bubble.
    private var reply: some View {
        MarkdownView(entry.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
    /// A message Umpi started (a reminder, the brief, an alert): full width like a reply, with a small label naming it.
    private var messageCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Only a label that says something: a reminder, a question, an approval. Plain messages need none.
            if cardTitle != "Umpi" { Label(cardTitle, systemImage: cardSymbol).font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor) }
            MarkdownView(entry.text).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
    /// Where a message came from, when that matters; times are shown as centred headers instead.
    private var caption: String {
        var parts: [String] = []
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

extension View {
    /// The system's soft fade where content scrolls under the bars (iOS 26 and later).
    @ViewBuilder func softScrollEdges() -> some View {
        if #available(iOS 26.0, *) { self.scrollEdgeEffectStyle(.soft, for: .all) } else { self }
    }
    /// The system's Liquid Glass on iOS 26, like Messages' composer; a filled shape on earlier systems.
    @ViewBuilder func glassOrFill<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26.0, *) { self.glassEffect(.regular.interactive(), in: shape) }
        else { self.background(Color(.secondarySystemBackground), in: shape) }
    }
    /// On iOS 26 the composer floats over the softly faded content; earlier systems get the bar material.
    @ViewBuilder func composerBackground() -> some View {
        if #available(iOS 26.0, *) { self } else { self.background(.bar) }
    }
}

/// What an owner message carried, drawn the way messaging apps do: photos as thumbnails, a video as its first frame with
/// a play badge and length, a file as a card, a voice note or audio as a waveform with its length. Previews exist only
/// on the phone that sent them; elsewhere a compact label stands in.
struct ChatMediaView: View {
    let entry: ChatEntry
    let local: LocalMedia?

    private var kind: String {
        if let kind = entry.media?.kind { return kind }
        if entry.kind == "voice" { return "voice" }
        if entry.file != nil { return "file" }
        if entry.images != nil { return "photos" }
        return ""
    }
    var hasContent: Bool { !kind.isEmpty }
    var isVisual: Bool { (kind == "photos" || kind == "video") && !(local?.thumbnails.isEmpty ?? true) }

    static func duration(_ seconds: Int) -> String { String(format: "%d:%02d", seconds / 60, seconds % 60) }

    var body: some View {
        switch kind {
        case "photos": photos
        case "video": video
        case "file": fileCard
        case "voice", "audio": audio
        default: EmptyView()
        }
    }

    @ViewBuilder private var photos: some View {
        let images = (local?.thumbnails ?? []).compactMap(UIImage.init(data:))
        if images.isEmpty {
            chip(entry.images.map { $0 == 1 ? "Photo" : "\($0) photos" } ?? "Photo", symbol: "photo")
        } else if images.count == 1 {
            Image(uiImage: images[0]).resizable().scaledToFill().frame(maxWidth: 274, maxHeight: 320).clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
        } else {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 2), GridItem(.flexible(), spacing: 2)], spacing: 2) {
                ForEach(Array(images.prefix(4).enumerated()), id: \.offset) { _, image in
                    Color.clear.aspectRatio(1, contentMode: .fit).overlay(Image(uiImage: image).resizable().scaledToFill()).clipped()
                }
            }
            .frame(width: 274)
            .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
        }
    }

    @ViewBuilder private var video: some View {
        let seconds = entry.media?.seconds ?? local?.seconds
        if let data = local?.thumbnails.first, let image = UIImage(data: data) {
            Image(uiImage: image).resizable().scaledToFill().frame(width: 274, height: 200).clipped()
                .overlay { Image(systemName: "play.fill").font(.title2).foregroundStyle(.white).padding(14).background(.black.opacity(0.45), in: Circle()) }
                .overlay(alignment: .bottomLeading) {
                    if let seconds {
                        Text(Self.duration(seconds)).font(.caption2.weight(.semibold).monospacedDigit()).foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 3).background(.black.opacity(0.5), in: Capsule()).padding(8)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                .accessibilityLabel("Video" + (seconds.map { ", \(Self.duration($0))" } ?? ""))
        } else {
            chip("Video" + (seconds.map { " · \(Self.duration($0))" } ?? ""), symbol: "play.rectangle")
        }
    }

    private var fileCard: some View {
        let name = entry.media?.name ?? entry.file ?? "File"
        let ext = (name as NSString).pathExtension.uppercased()
        return HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.white.opacity(0.22)).frame(width: 40, height: 46)
                Text(ext.isEmpty ? "FILE" : String(ext.prefix(4))).font(.caption2.weight(.bold))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.subheadline.weight(.semibold)).lineLimit(2)
                if let bytes = local?.bytes { Text(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)).font(.caption).opacity(0.8) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 2)
    }

    private var audio: some View {
        let seconds = entry.media?.seconds ?? local?.seconds
        return HStack(spacing: 10) {
            Image(systemName: kind == "voice" ? "mic.fill" : "waveform").font(.callout.weight(.semibold))
                .frame(width: 34, height: 34).background(.white.opacity(0.22), in: Circle())
            WaveformBars(seed: entry.seq).frame(height: 22)
            if let seconds { Text(Self.duration(seconds)).font(.caption.monospacedDigit()).opacity(0.85) }
        }
        .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 0)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel((kind == "voice" ? "Voice note" : entry.media?.name ?? "Audio") + (seconds.map { ", \(Self.duration($0))" } ?? "") + ", transcribed")
    }

    private func chip(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol).font(.footnote.weight(.semibold)).padding(.horizontal, 14).padding(.top, 10)
    }
}

/// A fixed, decorative waveform, the same for a message every time it is drawn.
private struct WaveformBars: View {
    let seed: Int
    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(0..<24, id: \.self) { index in
                Capsule().frame(width: 2.5, height: Self.height(index, seed))
            }
        }
        .opacity(0.9)
    }
    private static func height(_ index: Int, _ seed: Int) -> CGFloat {
        let first = sin(Double(index * 7 + seed * 13) * 0.61) * 0.7
        let second = sin(Double(index + seed) * 1.7) * 0.3
        return max(4, 22 * CGFloat(abs(first + second)))
    }
}

