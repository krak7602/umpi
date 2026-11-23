#if os(iOS)
import SafariServices
#endif
import os
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
    /// What is typed, and whether the field has the keyboard. Only the composer reads them while drawing, so typing
    /// and focus do not redraw the conversation.
    @State private var draft = ChatDraft()
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
    /// The rows derived from the chat and the outbox, and which of them show. Not observed: it is read and written
    /// while the chat is drawn.
    @State private var list = ChatList()
    /// Counts the times more rows were shown, to draw again with them.
    @State private var reveals = 0
    /// Takes a UI block's send button to `post`, the message field's own path.
    @State private var blockSend = ChatSendRelay()
    #if os(macOS)
    @State private var dropTargeted = false
    #endif

    /// With no model given, the chat has its own and keeps it live while it shows.
    init(chat: ChatModel? = nil) {
        _chat = State(initialValue: chat ?? ChatModel())
        ownsConnection = chat == nil
    }

    var body: some View {
        // Derived once for each change of the chat or the outbox, not at each drawing.
        // A reply that is being written is one row, added when its text begins; its text is read where it is drawn.
        let conversation = list.derive(entries: chat.entries, revision: chat.revision, sent: store.sentMessages, pending: store.pendingMessages, device: store.deviceID,
                                       writing: chat.live.writing, began: chat.live.began)
        let _ = reveals
        let _ = blockSend.send = { text in post(text, attachment: nil) }
        // The newest rows only: drawing a row parses, colours, and lays out its message. Older rows join when the owner
        // scrolls up to them, or asks for them.
        let rows = list.shown(conversation.rows)
        let _ = list.noteLayout(of: rows.count)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if list.window.hidden > 0 || chat.hasOlder {
                        Button("Load earlier messages") { loadEarlier() }
                            .font(.footnote).frame(maxWidth: .infinity)
                            .borderlessOnMac()
                    }
                    if conversation.rows.isEmpty && !chat.isLoading && chat.hasRestored {
                        ContentUnavailableView("No messages yet", systemImage: "bubble.left.and.bubble.right",
                            description: Text("Messages from Telegram and this app appear here as one conversation."))
                            .padding(.top, 60)
                    }
                    ForEach(rows) { row in
                        let entry = row.entry
                        // WhatsApp-style: a centred time starts each new stretch of conversation; consecutive messages
                        // from Umpi without one are parted by a thin line.
                        if let header = row.header {
                            Text(header).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.top, row.isFirst ? 0 : 6)
                                .id(ChatRowPlace(row: row.id, part: .top))
                                .transition(.opacity)
                        } else if row.divider {
                            Divider().padding(.horizontal, 40).opacity(0.6)
                                .id(ChatRowPlace(row: row.id, part: .top))
                        }
                        // Drawn again only when its entry or status changes (`ChatBubble` is `Equatable`), not whenever the
                        // conversation is.
                        ChatBubble(entry: entry, status: row.status) { [chat, store] data in Task { await chat.press(store, seq: entry.seq, data: data) } }
                            .equatable()
                            .id(ChatRowPlace(row: row.id, part: .bubble))
                            // A sent message grows out of the corner nearest the field, as in Messages and Telegram.
                            .transition(entry.fromOwner ? .scale(scale: 0.4, anchor: .bottomTrailing).combined(with: .opacity) : .opacity)
                    }
                    // The knot shows until a reply's first text arrives; the text then grows in its place.
                    if chat.isThinking(pending: conversation.waiting) && chat.live.writing.isEmpty {
                        ThinkingIndicator()
                            .transition(.opacity)
                        .accessibilityIdentifier("chat.thinking")
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .environment(chat.live)
                .environment(\.uiSend) { [blockSend] text in blockSend.send(text) }
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
                if new > old, let kept = list.takeKeptPlace() {
                    // Older rows joined above while the owner reads further up: the row that was the oldest stays
                    // where it was. If the scroll view has moved by about the added height already, it kept the place
                    // itself.
                    let grown = new - old
                    Task { @MainActor in
                        if list.offset - kept.offset < grown / 2 { proxy.scrollTo(kept.place, anchor: .top) }
                    }
                } else if pinned && new > old && !sendSettling {
                    Task { @MainActor in proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, offset in list.offset = offset }
            // At the top of the rows that show, the next older ones join.
            .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y <= 24 - $0.contentInsets.top } action: { _, atTop in
                if atTop { showEarlier(scrolled: userScrolling) }
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
            .simultaneousGesture(TapGesture().onEnded { draft.focused = false })
            #endif
            .softScrollEdges()
            .onChange(of: chat.entries.last?.seq) { old, _ in
                // A finished reply that took the place of the one being written is not a new message: the owner who
                // went up to read while it was written stays there.
                let replaced = list.takeReplacedWriting()
                // The first load jumps to the newest message; later ones scroll there.
                // Diagrams and photos size themselves after they render, so it settles once more a moment later.
                if old == nil { Task { @MainActor in
                    for delay in [50, 700] { try? await Task.sleep(for: .milliseconds(delay)); proxy.scrollTo("bottom", anchor: .bottom) }
                } }
                else if pinned || !replaced { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
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
        // Approval cards change in place: read the requests again whenever the chat's buttons change and it holds one.
        .task(id: chat.buttonsRevision) {
            if chat.entries.contains(where: { $0.id.hasPrefix("umpi:t3-request:") }) { await t3.loadRequests(store) }
            if chat.entries.contains(where: { $0.id.hasPrefix("umpi:memory:review:") }) { await MemoryReviewModel.shared.load(store) }
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
        .modifier(InAppBrowser())
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
            if draft.isEmpty { draft.set(text) }
            draft.focused = true
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

    /// Drawn in a body of its own: what it reads of the draft then redraws only the composer, not every message. It
    /// reads only what changes rarely (empty or not, sendable or not, focus), never the text: drawing the composer on
    /// each keystroke made SwiftUI check the layout of the whole conversation again, and typing lagged in a long one.
    private var composer: some View {
        SeparatelyDrawn {
            composerRow
                .padding(.horizontal).padding(.vertical, 8)
                #if os(macOS)
                // Lined up with the messages above it.
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                #endif
                .composerBackground()
        }
    }

    /// Inserts Markdown the owner would otherwise type by hand; the text stays plain Markdown.
    @ViewBuilder private var formatButtons: some View {
        Button { draft.set(draft.text + (draft.text.isEmpty || draft.text.hasSuffix(" ") || draft.text.hasSuffix("\n") ? "****" : " ****")) } label: { Label("Bold", systemImage: "bold") }
        Button { draft.set(draft.text + (draft.text.isEmpty || draft.text.hasSuffix("\n") ? "- " : "\n- ")) } label: { Label("List item", systemImage: "list.bullet") }
        Button { draft.set(draft.text + (draft.text.isEmpty || draft.text.hasSuffix("\n") ? "- [ ] " : "\n- [ ] ")) } label: { Label("Checklist item", systemImage: "checklist") }
        Button { draft.set(draft.text + (draft.text.isEmpty || draft.text.hasSuffix("\n") ? "```\n\n```" : "\n```\n\n```")) } label: { Label("Code block", systemImage: "chevron.left.forwardslash.chevron.right") }
    }

    /// Shows older rows: first the ones this device has and does not show yet, then a page from the coordinator, all
    /// of which shows at once.
    private func loadEarlier() {
        if list.window.hidden > 0 { showEarlier(scrolled: false); return }
        list.window.showAll()
        Task {
            await chat.loadOlder(store)
            list.window.loaded()
            reveals += 1
        }
    }

    /// Shows the next older rows this device has. While the owner reads further up, the row that was the oldest keeps
    /// its place; at the end of the conversation the list stays there, as for any content that grows.
    private func showEarlier(scrolled: Bool) {
        guard let former = list.showEarlier() else { return }
        if scrolled { pinned = false }
        if !pinned { list.keepPlace(of: former) }
        reveals += 1
    }

    /// A centred time before a message that starts a new stretch: the first one, a new day, or 10 minutes after the last.
    static func timeHeader(_ entry: ChatEntry, after previous: ChatEntry?) -> String? {
        timeHeader(entry.date, after: previous?.date)
    }

    /// The same from the two dates: `before` is nil when no message came before, or its time is not known.
    static func timeHeader(_ date: Date?, after before: Date?) -> String? {
        guard let date else { return nil }
        if let before, Calendar.current.isDate(before, inSameDayAs: date), date.timeIntervalSince(before) < 600 { return nil }
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
        draft.focused || !draft.isEmpty
        #endif
    }

    private var canSend: Bool { draft.hasWords || attachment != nil }

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
                // The Mac's field: Return sends, Shift-Return starts a new line. It takes the text as a binding, whose
                // value SwiftUI copies when this row is drawn. Reading `edits` draws the row on every change, so that copy
                // is never older than the field's own text.
                let _ = draft.edits
                ComposerTextView(text: Binding(get: { draft.text }, set: { draft.typed($0) }), focused: Bindable(draft).focused, placeholder: "Message Umpi", onReturn: { if canSend, preparing == nil { send() } }) { providers in
                    prepare("Adding what you pasted…") { try await PreparedAttachment.pasted(providers) }
                }
                #else
                // The phone's field reads the draft itself. `revision` and `focused` are passed so that SwiftUI updates
                // the field when the app changes either; typing changes neither.
                ComposerTextView(draft: draft, revision: draft.revision, focused: draft.focused, placeholder: "Message Umpi") { providers in
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
                        Button { draft.focused = false; talk() } label: { Image(systemName: "waveform").font(.system(size: 17, weight: .semibold)).frame(width: 34, height: ChatView.fieldHeight) }
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
        guard post(draft.text.trimmingCharacters(in: .whitespacesAndNewlines), attachment: attachment) else { return }
        draft.set(""); attachment = nil
    }

    /// Sends the owner's message: the field's text, or the label of a UI block's send button. One path for both, so a
    /// button's message shows in the chat, waits in the outbox when offline, and moves the list like any other.
    @discardableResult private func post(_ text: String, attachment sending: PreparedAttachment?) -> Bool {
        let queued = withAnimation(Self.sendAnimation) {
            store.queueChat(text: text, attachment: sending?.value, context: sending?.context, media: sending?.media, previews: sending?.previews)
        }
        guard queued else { return false }
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
        return true
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

/// The chat's message field: its text and whether it has the keyboard.
///
/// The field (the text view) owns what is typed and reports every change here at once with `typed`, so `text` is never
/// older than the field. Typing is not observed: SwiftUI draws again only when `isEmpty`, `hasWords`, or `focused`
/// changes, or when the app replaces the text with `set`, which counts up `revision`. The field takes `text` back only
/// when `revision` changed since it last did, so nothing can write an older text over what was just typed or pasted.
@MainActor @Observable final class ChatDraft {
    /// What the field holds, as it last reported, or what the app set.
    @ObservationIgnored private(set) var text = ""
    private(set) var isEmpty = true
    /// The text has something other than spaces and line breaks, so it can be sent.
    private(set) var hasWords = false
    /// Counts the times the app replaced the text (a formatting button, a send, a draft begun elsewhere). Typing
    /// does not change it.
    private(set) var revision = 0
    /// Counts every change, typed or set, for a field that takes the text as a binding (the Mac's).
    private(set) var edits = 0
    /// The field has, or should take, the keyboard. Setting the value it already has redraws nothing.
    var focused: Bool {
        get { keyboard }
        set { if newValue != keyboard { keyboard = newValue } }
    }
    private var keyboard = false

    /// The field reports its text after a keystroke, a paste, or dictation.
    func typed(_ text: String) {
        guard text != self.text else { return }
        self.text = text
        edits += 1
        settle()
    }
    /// The app replaces the text; the field takes it at its next update.
    func set(_ text: String) {
        self.text = text
        revision += 1
        edits += 1
        settle()
    }
    /// The observed flags change only when their value does, so text that stays non-empty redraws nothing.
    private func settle() {
        let empty = text.isEmpty
        if empty != isEmpty { isEmpty = empty }
        let words = text.unicodeScalars.contains { !CharacterSet.whitespacesAndNewlines.contains($0) }
        if words != hasWords { hasWords = words }
    }
}

/// Builds its content in its own body, so observed values the content reads redraw this view alone, not the view
/// that made it.
private struct SeparatelyDrawn<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View { content() }
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

    /// A memory update Umpi proposes, drawn as its card once the app has the review; until then, its text and buttons.
    private var memoryReview: MemoryReview? {
        entry.id.hasPrefix("umpi:memory:review:") ? MemoryReviewModel.shared.review(entry: entry.id) : nil
    }

    var body: some View {
        VStack(alignment: entry.fromOwner ? .trailing : .leading, spacing: 6) {
            if let approval {
                T3ApprovalCard(request: approval) { approve in Task { await t3.decide(store, approval.id, approve: approve) } }
            } else if let memoryReview {
                MemoryReviewCard(review: memoryReview) { approve in Task { await MemoryReviewModel.shared.decide(store, memoryReview.id, approve: approve) } }
            } else {
                if entry.fromOwner { ownerBubble } else if entry.kind == "message" { messageCard } else { reply }
                // UI blocks Umpi composed, under the text, in order. Each is as wide as the message; a wide table
                // scrolls inside its block.
                if let blocks = entry.ui, !entry.fromOwner {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in UIBlockView(block: block) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                }
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
        // Previews are looked for only when the message carried media; they are decoded once and kept.
        let local = entry.showsMedia ? entry.operationId.flatMap(LocalMedia.shown) : nil
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
        ChatReplyText(entry: entry, writing: status == .writing)
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

/// The text of Umpi's reply. For a reply that is still being written it draws what the socket has brought so far, and
/// under it what Umpi is doing while a tool runs. The finished entry is drawn by the same view in the same row, so the
/// blocks that did not change stay as they are and nothing moves.
private struct ChatReplyText: View {
    let entry: ChatEntry
    let writing: Bool
    @Environment(LiveReplies.self) private var live: LiveReplies?

    var body: some View {
        // Only a reply that is being written reads the growing text, so only its view is drawn again as text arrives.
        let growing = writing ? entry.operationId.flatMap { live?.shown[$0] } : nil
        VStack(alignment: .leading, spacing: 8) {
            MarkdownView(entry.text, growing: growing?.document).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            if let status = growing?.status {
                Text(status).font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("chat.reply.status")
            }
        }
    }
}

/// Holds the action of a UI block's send button. The environment's closure must be sendable; it reaches the chat's own
/// send through this object, which the chat sets each time it is drawn.
@MainActor final class ChatSendRelay {
    var send: (String) -> Void = { _ in }
}

/// A bubble shows its entry and status. Its button action differs only by the entry it presses for, so two bubbles
/// with the same entry and status are the same, and SwiftUI need not draw the second.
extension ChatBubble: @MainActor Equatable {
    static func == (a: ChatBubble, b: ChatBubble) -> Bool { a.entry == b.entry && a.status == b.status }
}

/// One row of the conversation: an entry of the chat log, or one of the owner's messages not in it yet. A message
/// keeps its row's identity from the moment it is sent, so its entry later takes its place without a redraw.
struct ChatRow: Identifiable {
    /// `writing`: Umpi's reply while it is written; the row has the ID of the entry that will hold the reply.
    enum Status { case logged, delivered, sending, failed, writing }
    var id: String
    var entry: ChatEntry
    var status: Status = .logged
    /// The centred time that starts a new stretch of the conversation at this row; set by `ChatView.arranged`.
    var header: String? = nil
    /// A thin line parts the row from the one before: both are Umpi's and no time stands between them.
    var divider = false
    /// The oldest row of the conversation.
    var isFirst = false
}

/// A place in the conversation that the list can scroll to: the top of a row (its time or line), or its bubble.
struct ChatRowPlace: Hashable {
    enum Part { case top, bubble }
    var row: String
    var part: Part
}

/// Which rows of the conversation show. The chat starts with the newest and adds older ones as the owner goes up, so
/// opening it draws a bounded number of messages however long the loaded conversation is. The window holds on to the
/// oldest row it shows: new messages add to it, and it loses nothing while the chat shows.
struct ChatRowWindow {
    /// The rows that show at first.
    static let first = 30
    /// The rows that each step up adds.
    static let more = 30

    /// The oldest row that shows.
    private(set) var oldest: String?
    private(set) var count = 0
    /// The rows older than `oldest`: loaded, not shown.
    private(set) var hidden = 0
    /// Every row shows, until the page that was asked for has been drawn.
    private var showsAll = false
    private var pageLoaded = false

    /// Where the rows that show start in `rows`.
    mutating func start(in rows: [ChatRow]) -> Int {
        guard !rows.isEmpty else { hidden = 0; count = 0; return 0 }
        var start = max(0, rows.count - max(count, ChatRowWindow.first))
        if showsAll { start = 0 }
        else if let oldest, let index = rows.firstIndex(where: { $0.id == oldest }) { start = index }
        if showsAll, pageLoaded { showsAll = false; pageLoaded = false }
        oldest = rows[start].id; hidden = start; count = rows.count - start
        return start
    }

    /// Adds the next older rows. Returns the row that was the oldest shown, or nil when every row shows already.
    mutating func showEarlier(in rows: [ChatRow]) -> ChatRow? {
        let shownFrom = start(in: rows)
        guard shownFrom > 0 else { return nil }
        let former = rows[shownFrom]
        let earlier = max(0, shownFrom - ChatRowWindow.more)
        oldest = rows[earlier].id; hidden = earlier; count = rows.count - earlier
        return former
    }

    /// Every row shows from now on, also rows a page brings; `loaded` ends that once the page is in.
    mutating func showAll() { showsAll = true; pageLoaded = false }
    mutating func loaded() { pageLoaded = true }
}

/// What the chat's body works out from the chat and the outbox, kept between drawings: the rows with their time
/// headers, which of them show, and where the list is scrolled. A plain object in the view's state, not observed, so
/// the body can write it while it draws.
@MainActor final class ChatList {
    struct Conversation {
        var rows: [ChatRow] = []
        /// The owner's messages that wait for the coordinator or for their entry.
        var waiting = 0
    }
    /// A row whose place is kept while older rows join above it.
    struct KeptPlace { var place: ChatRowPlace; var offset: CGFloat; var at: Date }

    var window = ChatRowWindow()
    /// The scroll view's content offset, as last reported.
    var offset: CGFloat = 0
    /// How often the rows were derived; a drawing with nothing changed derives nothing.
    private(set) var derivations = 0

    private var conversation = Conversation()
    private var key: Key?
    private var expires = Date.distantFuture
    private var keptPlace: KeptPlace?
    private var layoutNoted = false
    private var replacedWriting = false

    /// Whether a finished reply took the row of the one that was being written, since this was last asked.
    func takeReplacedWriting() -> Bool {
        defer { replacedWriting = false }
        return replacedWriting
    }

    private struct Key: Equatable {
        var revision: Int
        var count: Int
        var sent: [CompanionStore.SentMessage]
        var pending: [MessageRequest]
        var failed: [Bool]
        var device: String
        var writing: [String]
        /// The headers say "Today" and "Yesterday".
        var day: Date
    }

    /// The conversation's rows. They are derived again only when the entries (`revision`), the outbox, or the day
    /// changed, or when a sent message's two minutes ran out.
    func derive(entries: [ChatEntry], revision: Int, sent: [CompanionStore.SentMessage], pending: [(message: MessageRequest, failed: Bool)],
                device: String, writing: [String] = [], began: [String: Date] = [:], now: Date = Date()) -> Conversation {
        let key = Key(revision: revision, count: entries.count, sent: sent, pending: pending.map(\.message), failed: pending.map(\.failed),
                      device: device, writing: writing, day: Calendar.current.startOfDay(for: now))
        if key == self.key, now < expires { return conversation }
        self.key = key
        derivations += 1
        let wasWriting = Set(conversation.rows.lazy.filter { $0.status == .writing }.map(\.id))
        let rows = ChatView.rows(entries: entries, sent: sent, pending: pending, device: device, writing: writing, began: began, now: now)
        conversation = Conversation(rows: ChatView.arranged(rows), waiting: rows.count(where: { $0.status == .sending || $0.status == .delivered }))
        if !wasWriting.isEmpty, rows.contains(where: { $0.status == .logged && wasWriting.contains($0.id) }) { replacedWriting = true }
        // A sent message that the log does not show yet leaves the rows two minutes after it was sent.
        expires = rows.lazy.filter { $0.status == .delivered }.compactMap { row in sent.first { $0.message.id == row.id }?.at.addingTimeInterval(120) }.min() ?? .distantFuture
        return conversation
    }

    /// The rows that show: the newest, and the older ones the owner went up to.
    func shown(_ rows: [ChatRow]) -> ArraySlice<ChatRow> {
        rows[window.start(in: rows)...]
    }

    /// Adds the next older rows; see `ChatRowWindow.showEarlier`.
    func showEarlier() -> ChatRow? { window.showEarlier(in: conversation.rows) }

    /// Remembers where `row` is, to put it back there once the older rows are laid out.
    func keepPlace(of row: ChatRow) {
        keptPlace = KeptPlace(place: ChatRowPlace(row: row.id, part: row.header != nil || row.divider ? .top : .bubble), offset: offset, at: Date())
    }
    /// The place to keep, once; none when it was asked for more than a second ago.
    func takeKeptPlace() -> KeptPlace? {
        defer { keptPlace = nil }
        guard let keptPlace, Date().timeIntervalSince(keptPlace.at) < 1 else { return nil }
        return keptPlace
    }

    /// A signpost interval from the first drawing that has rows to the end of that turn of the run loop, when the
    /// rows are laid out.
    func noteLayout(of rows: Int) {
        guard !layoutNoted, rows > 0 else { return }
        layoutNoted = true
        let signpost = RenderSignposts.chat.beginInterval("first layout", "\(rows) rows")
        Task { @MainActor in RenderSignposts.chat.endInterval("first layout", signpost) }
    }
}

extension ChatView {
    /// The conversation as shown: the log's entries, then messages the coordinator accepted that the log does not
    /// show yet (for two minutes at most), then those still in the outbox.
    /// Last come the replies that are being written (`writing`, by operation), each as a row with the ID its finished
    /// entry will have, so that entry takes the row over when it arrives.
    static func rows(entries: [ChatEntry], sent: [CompanionStore.SentMessage], pending: [(message: MessageRequest, failed: Bool)],
                     device: String = "", writing: [String] = [], began: [String: Date] = [:], now: Date = Date()) -> [ChatRow] {
        // Each message's operation: from the coordinator's answer once sent, and worked out beforehand while sending,
        // as its entry can arrive first. Worked out once for each message: it is a SHA-256.
        let operations = pending.map { CompanionStore.appOperation(device: device, message: $0.message.id) }
        let expected = zip(operations, pending).compactMap { operation, item in operation.map { ($0, item.message.id) } }
        let local = Dictionary(sent.map { ($0.operationID, $0.message.id) } + expected, uniquingKeysWith: { $1 })
        // An approval's outcome note is for Telegram; here the card itself shows what became of it.
        // A memory review's outcome note is the same: its card shows the outcome.
        let shown = entries.filter { !($0.id.hasPrefix("umpi:t3-request:") && $0.id.hasSuffix(":outcome")) && !$0.id.hasPrefix("umpi:memory:outcome:") }
        var rows = shown.map { entry in
            ChatRow(id: entry.fromOwner ? entry.operationId.flatMap { local[$0] } ?? entry.id : entry.id, entry: entry)
        }
        let logged = Set(shown.compactMap(\.operationId))
        for sent in sent where !logged.contains(sent.operationID) && now.timeIntervalSince(sent.at) < 120 {
            rows.append(ChatRow(id: sent.message.id, entry: ownEntry(sent.message, operation: sent.operationID), status: .delivered))
        }
        for (operation, (message, failed)) in zip(operations, pending) where !logged.contains(operation ?? "") {
            rows.append(ChatRow(id: message.id, entry: ownEntry(message, operation: message.id), status: failed ? .failed : .sending))
        }
        for operation in writing {
            let id = ChatEntry.answerID(operation)
            guard !shown.contains(where: { $0.id == id }) else { continue }
            let entry = ChatEntry(seq: -1, id: id, at: (began[operation] ?? now).formatted(.iso8601), role: "umpi", surface: "app", kind: "reply", text: "", operationId: operation)
            rows.append(ChatRow(id: id, entry: entry, status: .writing))
        }
        return rows
    }

    /// The rows with what stands before each: a centred time where a new stretch of the conversation starts, or a
    /// thin line between two of Umpi's messages. Each entry's time is read once.
    static func arranged(_ rows: [ChatRow]) -> [ChatRow] {
        var rows = rows
        var previous: (fromOwner: Bool, date: Date?)?
        for index in rows.indices {
            let entry = rows[index].entry, date = entry.date
            rows[index].isFirst = index == 0
            rows[index].header = timeHeader(date, after: previous?.date)
            rows[index].divider = rows[index].header == nil && previous?.fromOwner == false && !entry.fromOwner
            previous = (entry.fromOwner, date)
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
    /// The previews this device keeps of what the message carried, already decoded.
    let local: ShownMedia?

    private var kind: String { entry.mediaKind }
    /// A voice note's recording is not kept, so it shows as its transcript only, with the "voice note" tag.
    var hasContent: Bool { entry.showsMedia }
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
        let images = local?.thumbnails ?? []
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
        if let image = local?.thumbnails.first {
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

#if os(iOS)
/// Web links in the chat open in a Safari sheet inside Umpi, so reading a page, or checking an address on an approval
/// card, does not leave the conversation. Other links (mail, phone, app links) go to the system as before.
private struct InAppBrowser: ViewModifier {
    @State private var page: BrowserPage?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return .systemAction }
                page = BrowserPage(url: url)
                return .handled
            })
            .sheet(item: $page) { SafariPage(url: $0.url).ignoresSafeArea() }
    }
}

private struct BrowserPage: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

private struct SafariPage: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
#endif
