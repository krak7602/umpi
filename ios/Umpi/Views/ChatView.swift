import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The owner's shared conversation: what was said in Telegram and here, and what Umpi sent on its own.
struct ChatView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(T3CodeModel.self) private var t3
    @Environment(\.openVoiceMode) private var openVoiceMode
    @State private var chat: ChatModel
    /// The chat keeps its own live connection; false when the app keeps one for every chat it shows (the Mac).
    private let ownsConnection: Bool
    @State private var draft = ""
    @State private var composing = false
    @State private var attachment: PreparedAttachment?
    @State private var preparing: String?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var pinned = true
    @State private var showModels = false
    @State private var userScrolling = false
    @State private var requests = ChatRequests.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var onScreen = false
    @State private var showVoice = false
    /// Counts sends, so the list scrolls to a new message in the same motion that brings it in.
    @State private var sends = 0
    /// While a sent message animates in, content growth does not jump the list to the end under it.
    @State private var sendSettling = false
    #if os(macOS)
    @State private var dropTargeted = false
    #endif

    /// With no model given, the chat has its own and keeps it live while it shows.
    init(chat: ChatModel? = nil) {
        _chat = State(initialValue: chat ?? ChatModel())
        ownsConnection = chat == nil
    }

    var body: some View {
        let rows = ChatView.rows(entries: chat.entries, sent: store.sentMessages, pending: store.pendingMessages, device: store.deviceID)
        let waiting = rows.filter { $0.status == .sending || $0.status == .delivered }.count
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if chat.hasOlder {
                        Button("Load earlier messages") { Task { await chat.loadOlder(store) } }
                            .font(.footnote).frame(maxWidth: .infinity)
                            .borderlessOnMac()
                    }
                    if rows.isEmpty && !chat.isLoading {
                        ContentUnavailableView("No messages yet", systemImage: "bubble.left.and.bubble.right",
                            description: Text("Messages from Telegram and this app appear here as one conversation."))
                            .padding(.top, 60)
                    }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        let entry = row.entry
                        let previous = index > 0 ? rows[index - 1].entry : nil
                        // WhatsApp-style: a centred time starts each new stretch of conversation; consecutive messages
                        // from Umpi without one are parted by a thin line.
                        if let header = ChatView.timeHeader(entry, after: previous) {
                            Text(header).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.top, index == 0 ? 0 : 6)
                                .transition(.opacity)
                        } else if let previous, !previous.fromOwner, !entry.fromOwner {
                            Divider().padding(.horizontal, 40).opacity(0.6)
                        }
                        ChatBubble(entry: entry, status: row.status) { data in Task { await chat.press(store, seq: entry.seq, data: data) } }
                            // A sent message grows out of the corner nearest the field, as in Messages and Telegram.
                            .transition(entry.fromOwner ? .scale(scale: 0.4, anchor: .bottomTrailing).combined(with: .opacity) : .opacity)
                    }
                    if chat.isThinking(pending: waiting) {
                        ThinkingIndicator()
                            .transition(.opacity)
                        .accessibilityIdentifier("chat.thinking")
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal)
                #if os(macOS)
                // The oldest message starts clear of the toolbar's edge; a wide Mac window keeps lines at a readable
                // length, centred.
                .padding(.top, 16).padding(.bottom, 8)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                #else
                .padding(.vertical, 8)
                #endif
            }
            .defaultScrollAnchor(.bottom)
            // Content that grows after layout (a diagram, a photo) keeps the newest message in view, unless the owner
            // had scrolled up to read.
            // Pinned to the newest message while content grows (history loading, a diagram drawing, a reply), until the
            // owner scrolls up; scrolling back near the end pins it again.
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { old, new in
                if pinned && new > old && !sendSettling { Task { @MainActor in proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 120
            } action: { _, nearEnd in
                if userScrolling { pinned = nearEnd }
            }
            .onScrollPhaseChange { _, phase in userScrolling = phase == .interacting || phase == .decelerating }
            .scrollDismissesKeyboard(.interactively)
            #if os(iOS)
            // A tap anywhere in the conversation puts the keyboard away; buttons and links in messages still work.
            .simultaneousGesture(TapGesture().onEnded { composing = false })
            #endif
            .softScrollEdges()
            .onChange(of: chat.entries.last?.seq) { old, _ in
                // The first load jumps to the newest message; later ones scroll there.
                // Diagrams and photos size themselves after they render, so it settles once more a moment later.
                if old == nil { Task { @MainActor in
                    for delay in [50, 700] { try? await Task.sleep(for: .milliseconds(delay)); proxy.scrollTo("bottom", anchor: .bottom) }
                } }
                else { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            // The list moves up with the same spring that brings the sent message in.
            .onChange(of: sends) { _, _ in
                pinned = true
                withAnimation(ChatView.sendAnimation) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            #if os(macOS)
            // The Mac's chat is already loaded when it shows, so the first load above has passed: it opens on the newest
            // message, and settles there again once diagrams and photos have sized themselves.
            .onAppear {
                pinned = true
                Task { @MainActor in
                    for delay in [0, 80, 400] { try? await Task.sleep(for: .milliseconds(delay)); proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            #endif
        }
        #if os(macOS)
        // A bar, not just an inset: the messages fade out under it instead of running through the field.
        .safeAreaBar(edge: .bottom) { composer }
        #else
        .safeAreaInset(edge: .bottom) { composer }
        #endif
        #if os(macOS)
        // Files and images dropped anywhere on the chat attach as if pasted.
        .onDrop(of: [.fileURL, .image, .movie], isTargeted: $dropTargeted) { providers in drop(providers) }
        .overlay { if dropTargeted { dropHighlight } }
        #endif
        .navigationTitle("Chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            #if os(iOS)
            // The connection shows only when something is wrong; the Mac shows it in its sidebar and panel header
            // instead of as a toolbar item that looks like a button.
            if chat.isOffline {
                ToolbarItem(placement: .topBarTrailing) {
                    Image(systemName: "wifi.slash")
                        .foregroundStyle(Color.secondary)
                        .accessibilityLabel("Not connected")
                }
            }
            // Likewise the voice models, only while they download or prepare (such as after an update).
            if VoiceModelStatus.shared.showing {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showModels = true } label: { VoiceModelIcon() }
                        .popover(isPresented: $showModels) { VoiceModelsPopover().presentationCompactAdaptation(.popover) }
                }
            }
            #endif
        }
        .overlay(alignment: .top) {
            if let message = chat.notice ?? chat.errorMessage {
                Text(message).font(.footnote).padding(.horizontal, 12).padding(.vertical, 8).background(.thinMaterial, in: Capsule()).padding(.top, 4)
                    .onTapGesture { chat.clearNotice() }
                    .task(id: message) { try? await Task.sleep(for: .seconds(4)); chat.clearNotice() }
                    .accessibilityIdentifier("chat.notice")
            }
        }
        .task { if ownsConnection { await chat.stayLive(store) } }
        // Approval cards change in place: read the requests again whenever the chat changes and holds one.
        .task(id: chat.entries.map(\.buttons).description.hashValue) {
            if chat.entries.contains(where: { $0.id.hasPrefix("umpi:t3-request:") }) { await t3.loadRequests(store) }
        }
        // On screen only when this tab shows and the app is in front; another tab keeps the view alive but hidden.
        .onAppear { onScreen = true; requests.chatVisible = scenePhase == .active }
        .onDisappear { onScreen = false; requests.chatVisible = false }
        .onChange(of: scenePhase) { old, phase in
            requests.chatVisible = onScreen && phase == .active
            // Back from the background: the connection may have died while the app was suspended.
            if ownsConnection, old == .background, phase != .background { chat.catchUp(store) }
        }
        .onChange(of: requests.talk, initial: true) { _, wanted in
            guard wanted else { return }
            requests.talk = false
            talk()
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $showVoice) {
            VoiceModeView().environment(store)
        }
        #else
        .sheet(isPresented: $showVoice) {
            VoiceModeView().environment(store).frame(minWidth: 420, minHeight: 600)
        }
        #endif
        .onChange(of: requests.draft, initial: true) { _, text in
            guard let text else { return }
            requests.draft = nil
            if draft.isEmpty { draft = text }
            composing = true
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
            #if os(macOS)
            // Lined up with the messages above it.
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
            #endif
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

    /// The button left of the field also formats: on the phone while the keyboard is up, on the Mac once something is
    /// typed, since the Mac's field is usually focused and its attach button should stay a +.
    private var formatting: Bool {
        #if os(macOS)
        !draft.isEmpty
        #else
        composing || !draft.isEmpty
        #endif
    }

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachment != nil }

    private var composerRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let attachment {
                HStack {
                    Label(attachment.summary, systemImage: attachment.symbol).font(.footnote).lineLimit(1)
                    Spacer()
                    Button { self.attachment = nil } label: { Image(systemName: "xmark.circle.fill") }.foregroundStyle(.secondary).accessibilityLabel("Remove attachment")
                        .borderlessOnMac()
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            if let preparing { Label(preparing, systemImage: "hourglass").font(.footnote).foregroundStyle(.secondary) }
            inputRow
        }
    }

    /// Messages-style: attach on the left; send or talk inside the field, so the text takes the whole width.
    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            // One button, like Messages: attach when empty; while typing it also formats (Aa), with no floating bar.
            Menu {
                if formatting {
                    Section("Format") { formatButtons }
                }
                Section("Attach") {
                    Button { showPhotos = true } label: { Label("Photos and videos", systemImage: "photo.on.rectangle") }
                    Button { showFiles = true } label: { Label("Files and audio", systemImage: "doc") }
                }
            } label: {
                Image(systemName: formatting ? "textformat" : "plus").font(.system(size: 17, weight: .semibold)).frame(width: ChatView.fieldHeight, height: ChatView.fieldHeight)
                    .contentTransition(.symbolEffect(.replace))
                    .glassOrFill(in: Circle())
            }
            .tint(.primary)
            .disabled(preparing != nil)
            #if os(macOS)
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            #endif
            .accessibilityIdentifier("chat.attach")
            .accessibilityLabel("Attach")
            ZStack(alignment: .bottomTrailing) {
                // A UIKit text view, so pasted photos, videos, and files arrive as attachments. Its insets keep the
                // measured centring: a little more space above the text, and one line as tall as the + button.
                #if os(macOS)
                // The Mac's field: Return sends, Shift-Return starts a new line.
                ComposerTextView(text: $draft, focused: $composing, placeholder: "Message Umpi", onReturn: { if canSend, preparing == nil { send() } }) { providers in
                    prepare("Adding what you pasted…") { try await PreparedAttachment.pasted(providers) }
                }
                #else
                ComposerTextView(text: $draft, focused: $composing, placeholder: "Message Umpi") { providers in
                    prepare("Adding what you pasted…") { try await PreparedAttachment.pasted(providers) }
                }
                #endif
                Group {
                    if canSend {
                        Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)).frame(width: 34, height: ChatView.fieldHeight) }
                            .disabled(preparing != nil)
                            .accessibilityIdentifier("chat.send")
                            .accessibilityLabel("Send")
                    } else {
                        // With nothing typed, the button opens voice mode: a spoken conversation with Umpi.
                        Button { composing = false; talk() } label: { Image(systemName: "waveform").font(.system(size: 17, weight: .semibold)).frame(width: 34, height: ChatView.fieldHeight) }
                            .tint(.primary)
                            .accessibilityIdentifier("chat.voiceMode")
                            .accessibilityLabel("Talk to Umpi")
                    }
                }
                // The button is as tall as one line of the field, so it is centred on a single line and stays on the
                // last line as the text grows.
                .padding(.trailing, 4)
                #if os(macOS)
                .buttonStyle(.borderless)
                #endif
            }
            .glassOrFill(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }

    /// Opens voice mode: over the chat, or where the app shows it instead (the Mac's floating panel).
    private func talk() {
        if let openVoiceMode { openVoiceMode() } else { showVoice = true }
    }

    static let sendAnimation = Animation.spring(duration: 0.35, bounce: 0.15)

    /// The message joins the conversation at once, animated, and then goes out; one that cannot be queued stays in
    /// the field.
    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let sending = attachment
        let queued = withAnimation(Self.sendAnimation) {
            store.queueChat(text: text, attachment: sending?.value, context: sending?.context, media: sending?.media, previews: sending?.previews)
        }
        guard queued else { return }
        draft = ""; attachment = nil
        sendSettling = true
        sends += 1
        Task {
            try? await Task.sleep(for: .milliseconds(450))
            sendSettling = false
        }
        Task {
            await store.deliverQueued()
            await chat.refresh(store)
        }
    }
    #if os(macOS)
    /// What was dropped, read the way a paste is: Finder files as files, images without text as photos.
    private func drop(_ providers: [NSItemProvider]) -> Bool {
        guard preparing == nil else { return false }
        let fromPasteboard = ComposerNSTextView.mediaProviders(NSPasteboard(name: .drag))
        let items = fromPasteboard.isEmpty ? providers : fromPasteboard
        guard !items.isEmpty else { return false }
        prepare("Adding what you dropped…") { try await PreparedAttachment.pasted(items) }
        return true
    }

    private var dropHighlight: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
            .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                Label("Drop to attach", systemImage: "paperclip")
                    .font(.headline).foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
            }
            .padding(8)
            .allowsHitTesting(false)
    }
    #endif

    private func prepare(_ label: String, _ work: @escaping @MainActor () async throws -> PreparedAttachment) {
        preparing = label
        Task {
            defer { preparing = nil }
            do { attachment = try await work() } catch { chat.show((error as? LocalizedError)?.errorDescription ?? "The attachment could not be read.") }
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

    /// Pasted items: a video, photos (up to four), or a file, in that order of preference.
    @MainActor static func pasted(_ providers: [NSItemProvider]) async throws -> PreparedAttachment {
        if let video = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.movie.identifier) }) {
            let url = try await copy(video, type: .movie)
            defer { try? FileManager.default.removeItem(at: url) }
            return try await self.video(url, name: nil)
        }
        let imageProviders = providers.filter { $0.canLoadObject(ofClass: PlatformImage.self) }
        if !imageProviders.isEmpty {
            var images: [PlatformImage] = []
            for provider in imageProviders.prefix(MediaPrep.maxImages) {
                if let image = try? await withCheckedThrowingContinuation({ (continuation: CheckedContinuation<PlatformImage?, Error>) in
                    _ = provider.loadObject(ofClass: PlatformImage.self) { object, error in
                        if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: object as? PlatformImage) }
                    }
                }) { images.append(image) }
            }
            guard !images.isEmpty else { throw MediaError.unreadable("The pasted image could not be read.") }
            return .init(summary: images.count == 1 ? "1 photo" : "\(images.count) photos", symbol: "photo", value: .init(images: try MediaPrep.images(images)),
                         media: MediaInfo(kind: "photos", count: images.count), previews: LocalMedia(thumbnails: images.compactMap(LocalMedia.thumbnail)))
        }
        if let fileProvider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.data.identifier) }) {
            let type = fileProvider.registeredContentTypes.first ?? .data
            let url = try await copy(fileProvider, type: type)
            defer { try? FileManager.default.removeItem(at: url) }
            return try await file(url)
        }
        throw MediaError.unreadable("Only photos, videos, and files can be pasted here.")
    }

    /// Copies a pasted item to a temporary file named like the original, for reading.
    @MainActor private static func copy(_ provider: NSItemProvider, type: UTType) async throws -> URL {
        let suggested = provider.suggestedName
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, error in
                continuation.resume(with: Result { try copyOut(url, error, suggested, directory) })
            }
        }
    }
    /// The provider's file lasts only for its callback, so it is copied out there.
    nonisolated private static func copyOut(_ url: URL?, _ error: Error?, _ suggested: String?, _ directory: URL) throws -> URL {
        guard let url else { throw error ?? MediaError.unreadable("The pasted item could not be read.") }
        let name = suggested.map { "\($0).\(url.pathExtension)" } ?? url.lastPathComponent
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let copy = directory.appendingPathComponent(name)
        try FileManager.default.copyItem(at: url, to: copy)
        return copy
    }

    @MainActor static func photos(_ items: [PhotosPickerItem]) async throws -> PreparedAttachment {
        if let videoItem = items.first(where: { $0.supportedContentTypes.contains { $0.conforms(to: .movie) } }) {
            guard let movie = try await videoItem.loadTransferable(type: PickedMovie.self) else { throw MediaError.unreadable("The video could not be loaded.") }
            defer { try? FileManager.default.removeItem(at: movie.url) }
            return try await video(movie.url, name: nil)
        }
        var images: [PlatformImage] = []
        for item in items {
            if let data = try await item.loadTransferable(type: Data.self), let image = PlatformImage(data: data) { images.append(image) }
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
    @Environment(CompanionStore.self) private var store
    @Environment(T3CodeModel.self) private var t3
    let entry: ChatEntry
    var status: ChatRow.Status = .logged
    let press: (String) -> Void
    /// "Sending…" shows only when sending takes a while, so a quick send changes nothing under the bubble.
    @State private var slow = false

    /// A T3 Code action Umpi asks about, drawn as its card once the app has the request.
    private var approval: T3Request? {
        guard entry.id.hasPrefix("umpi:t3-request:") else { return nil }
        return t3.request(String(entry.id.dropFirst("umpi:t3-request:".count)))
    }

    var body: some View {
        VStack(alignment: entry.fromOwner ? .trailing : .leading, spacing: 6) {
            if let approval {
                T3ApprovalCard(request: approval) { approve in Task { await t3.decide(store, approval.id, approve: approve) } }
            } else {
                if entry.fromOwner { ownerBubble } else if entry.kind == "message" { messageCard } else { reply }
                if let rows = entry.buttons { buttons(rows) }
            }
            // Under a bubble, lined up with the bubble's text rather than its rounded edge.
            if !caption.isEmpty { Text(caption).font(.caption2).foregroundStyle(.tertiary).padding(.horizontal, entry.fromOwner ? 14 : 0) }
            if status == .failed {
                Text("Not sent — see Settings › Queued changes").font(.caption2).foregroundStyle(.red).padding(.horizontal, 14)
            } else if slow {
                Text("Sending…").font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 14).transition(.opacity)
            }
        }
        // Shown and hidden only through `slow`, always animated: hiding it the moment the message was accepted made
        // the conversation below jump up by its height.
        .task(id: status) {
            guard status == .sending else {
                if slow { withAnimation(.easeOut(duration: 0.25)) { slow = false } }
                return
            }
            try? await Task.sleep(for: .seconds(1.5))
            if !Task.isCancelled { withAnimation(.easeOut(duration: 0.25)) { slow = true } }
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
            if !caption.isEmpty {
                MarkdownView(caption, onOwnerTint: true).textSelection(.enabled)
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

/// One row of the conversation: an entry of the chat log, or one of the owner's messages not in it yet. A message
/// keeps its row's identity from the moment it is sent, so its entry later takes its place without a redraw.
struct ChatRow: Identifiable {
    enum Status { case logged, delivered, sending, failed }
    var id: String
    var entry: ChatEntry
    var status: Status = .logged
}

extension ChatView {
    /// The conversation as shown: the log's entries, then messages the coordinator accepted that the log does not
    /// show yet (for two minutes at most), then those still in the outbox.
    static func rows(entries: [ChatEntry], sent: [CompanionStore.SentMessage], pending: [(message: MessageRequest, failed: Bool)],
                     device: String = "", now: Date = Date()) -> [ChatRow] {
        // Each message's operation: from the coordinator's answer once sent, and worked out beforehand while sending,
        // as its entry can arrive first.
        let expected = pending.compactMap { item in CompanionStore.appOperation(device: device, message: item.message.id).map { ($0, item.message.id) } }
        let local = Dictionary(sent.map { ($0.operationID, $0.message.id) } + expected, uniquingKeysWith: { $1 })
        // An approval's outcome note is for Telegram; here the card itself shows what became of it.
        let shown = entries.filter { !($0.id.hasPrefix("umpi:t3-request:") && $0.id.hasSuffix(":outcome")) }
        var rows = shown.map { entry in
            ChatRow(id: entry.fromOwner ? entry.operationId.flatMap { local[$0] } ?? entry.id : entry.id, entry: entry)
        }
        let logged = Set(shown.compactMap(\.operationId))
        for sent in sent where !logged.contains(sent.operationID) && now.timeIntervalSince(sent.at) < 120 {
            rows.append(ChatRow(id: sent.message.id, entry: ownEntry(sent.message, operation: sent.operationID), status: .delivered))
        }
        for (message, failed) in pending where !logged.contains(CompanionStore.appOperation(device: device, message: message.id) ?? "") {
            rows.append(ChatRow(id: message.id, entry: ownEntry(message, operation: message.id), status: failed ? .failed : .sending))
        }
        return rows
    }

    /// An owner's message drawn as the log will have it. Its attachment's preview is kept under the operation's ID once
    /// sent, and under the message's before.
    static func ownEntry(_ message: MessageRequest, operation: String) -> ChatEntry {
        ChatEntry(seq: -1, id: message.id, at: message.sentAt ?? Date().formatted(.iso8601), role: "owner", surface: "app",
                  kind: message.voice == true ? "voice" : "text", text: message.text, media: message.media, operationId: operation)
    }
}

extension View {
    /// The system's soft fade where content scrolls under the bars (iOS 26 and later).
    @ViewBuilder func softScrollEdges() -> some View {
        #if os(macOS)
        // A Mac window's toolbar is not floating glass: messages stop cleanly under it instead of showing through. At
        // the bottom they pass under the glass field with only the system's light dimming: a solid or faded band
        // behind the field looked heavier than the glass itself.
        self.scrollEdgeEffectStyle(.soft, for: .bottom).scrollEdgeEffectStyle(.hard, for: .top)
        #else
        if #available(iOS 26.0, *) { self.scrollEdgeEffectStyle(.soft, for: .all) } else { self }
        #endif
    }
    /// The system's Liquid Glass on iOS 26 and the Mac, like Messages' composer; a filled shape on earlier systems.
    @ViewBuilder func glassOrFill<S: Shape>(in shape: S) -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *) { self.glassEffect(.regular.interactive(), in: shape) }
        else { self.background(Color(.secondarySystemBackground), in: shape) }
        #else
        // Glass, not the faint fill the Mac had: messages scrolled under the field showed straight through that.
        self.glassEffect(.regular.interactive(), in: shape)
        #endif
    }
    /// On iOS 26 and the Mac the composer floats over the softly faded content; earlier iOS gets the bar material.
    @ViewBuilder func composerBackground() -> some View {
        #if os(macOS)
        self
        #else
        if #available(iOS 26.0, *) { self } else { self.background(.bar) }
        #endif
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
    /// A voice note's recording is not kept, so it shows as its transcript only, with the "voice note" tag.
    var hasContent: Bool { !kind.isEmpty && kind != "voice" }
    var isVisual: Bool { (kind == "photos" || kind == "video") && !(local?.thumbnails.isEmpty ?? true) }

    static func duration(_ seconds: Int) -> String { String(format: "%d:%02d", seconds / 60, seconds % 60) }

    var body: some View {
        switch kind {
        case "photos": photos
        case "video": video
        case "file": fileCard
        case "audio": audio
        default: EmptyView()
        }
    }

    @ViewBuilder private var photos: some View {
        let images = (local?.thumbnails ?? []).compactMap(PlatformImage.init(data:))
        if images.isEmpty {
            chip(entry.images.map { $0 == 1 ? "Photo" : "\($0) photos" } ?? "Photo", symbol: "photo")
        } else if images.count == 1 {
            Image(platformImage: images[0]).resizable().scaledToFill().frame(maxWidth: 274, maxHeight: 320).clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
        } else {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 2), GridItem(.flexible(), spacing: 2)], spacing: 2) {
                ForEach(Array(images.prefix(4).enumerated()), id: \.offset) { _, image in
                    Color.clear.aspectRatio(1, contentMode: .fit).overlay(Image(platformImage: image).resizable().scaledToFill()).clipped()
                }
            }
            .frame(width: 274)
            .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
        }
    }

    @ViewBuilder private var video: some View {
        let seconds = entry.media?.seconds ?? local?.seconds
        if let data = local?.thumbnails.first, let image = PlatformImage(data: data) {
            Image(platformImage: image).resizable().scaledToFill().frame(width: 274, height: 200).clipped()
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

    /// An audio file is sent as its transcript; its name and length say what it was.
    private var audio: some View {
        let seconds = entry.media?.seconds ?? local?.seconds
        return chip((entry.media?.name ?? "Audio") + (seconds.map { " · \(Self.duration($0))" } ?? ""), symbol: "waveform")
    }

    private func chip(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol).font(.footnote.weight(.semibold)).padding(.horizontal, 14).padding(.top, 10)
    }
}


extension EnvironmentValues {
    /// Opens voice mode somewhere other than over the chat, such as the Mac's floating panel. Nil on the phone, where
    /// the chat opens voice mode itself.
    @Entry var openVoiceMode: (@MainActor () -> Void)? = nil
}
