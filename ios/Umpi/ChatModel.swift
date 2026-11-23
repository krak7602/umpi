import Foundation
import Observation
import os

/// One entry of the owner's shared conversation, as the coordinator's chat log returns it.
struct ChatEntry: Codable, Equatable, Identifiable, Sendable {
    struct Button: Codable, Equatable, Sendable { var label: String; var data: String }
    var seq: Int
    var id: String
    var at: String
    var role: String
    var surface: String
    var kind: String
    var text: String
    var images: Int?
    var file: String?
    var media: MediaInfo?
    var operationId: String?
    var buttons: [[Button]]?
    /// UI blocks Umpi composed for this reply, one component tree for each, drawn under the text. Nil without blocks.
    var ui: [JSONValue]?

    /// The entry that holds the finished reply to an operation.
    static func answerID(_ operation: String) -> String { "umpi:answer:\(operation)" }

    var fromOwner: Bool { role == "owner" }
    /// When the entry was written. The text is parsed once and the date kept: the chat asks for it at each drawing.
    var date: Date? {
        if let kept = ChatEntry.dates[at] { return kept }
        let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(at)) ?? (try? Date.ISO8601FormatStyle().parse(at))
        ChatEntry.dates.set(date, for: at)
        return date
    }
    private static let dates = RecentCache<String, Date?>(limit: 2_000)

    /// What an owner message carried, as the chat draws it: "photos", "video", "file", "audio", "voice", or nothing.
    var mediaKind: String {
        if let kind = media?.kind { return kind }
        if kind == "voice" { return "voice" }
        if file != nil { return "file" }
        if images != nil { return "photos" }
        return ""
    }
    /// The message shows media, so previews of it may be kept on this device. A voice note shows as its transcript only.
    var showsMedia: Bool { !mediaKind.isEmpty && mediaKind != "voice" }
}

struct ChatPage: Codable, Sendable {
    var entries: [ChatEntry]
    var latest: Int
    var more: Bool
}

/// The chat screen's state: history pages, newer entries announced by the socket, and Umpi's thinking state.
///
/// Making a model does no work: the chat view makes one each time the app's root view is drawn and keeps only the
/// first. The saved copy of the conversation is read, off the main actor, when `entries` is first read.
@MainActor @Observable
final class ChatModel {
    /// The conversation, oldest first. The first read starts restoring the saved copy; `hasRestored` says when that
    /// is done. Observed by hand, because the read has that effect and a write happens only when the entries changed.
    var entries: [ChatEntry] {
        access(keyPath: \.entries)
        restoreSaved()
        return log
    }
    @ObservationIgnored private var log: [ChatEntry] = []
    /// Counts the changes of `entries`, so what is derived from them is derived once for each change.
    @ObservationIgnored private(set) var revision = 0
    /// Counts the changes of the entries' buttons, or of how many entries there are.
    @ObservationIgnored private(set) var buttonsRevision = 0
    private(set) var hasOlder = false
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    /// The saved copy has been read (or there was none), so an empty conversation is known to be empty.
    private(set) var hasRestored = false
    private(set) var isLive = false {
        didSet { if isLive != oldValue { settleOffline() } }
    }
    /// The socket has been down for a while, not just reconnecting: the only connection state the app shows. It turns
    /// on 2 seconds after the socket closes and off once a new one has stayed open for 3 seconds, so an ordinary
    /// reconnect, or a retry that fails at once, does not flash it.
    private(set) var isOffline = false
    @ObservationIgnored private var offlineTimer: Task<Void, Never>?

    @ObservationIgnored private var latest = 0
    @ObservationIgnored private var fetching = false
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private lazy var session = URLSession(configuration: .ephemeral)
    /// Replies that are still being written, as the socket's frames bring them. They are kept apart from `entries`:
    /// text that grows changes neither the entries nor what is derived from them.
    let live = LiveReplies()

    /// Changes the entries, and tells observers, only when they differ. Reads call it; so do tests.
    func setEntries(_ entries: [ChatEntry]) {
        guard entries != log else { return }
        let buttonsChanged = !entries.elementsEqual(log) { $0.buttons == $1.buttons }
        withMutation(keyPath: \.entries) { log = entries }
        revision += 1
        if buttonsChanged { buttonsRevision += 1 }
        // A finished reply takes the place of what the frames showed, in the same update.
        live.settle(answered: { id in entries.contains { $0.id == id } })
    }

    /// One frame of the chat socket. Tells what to read: "new" entries after a newer position, "changed" ones for the
    /// same position, or nothing. A `reply` frame goes to the growing replies; a `speech` frame is voice mode's and is
    /// not shown here.
    enum SocketNews: Equatable { case new, changed, none }
    func receive(socketText text: String) -> SocketNews {
        guard let data = text.data(using: .utf8), let frame = try? JSONDecoder().decode(LiveReplies.Frame.self, from: data) else { return .none }
        switch frame.type {
        case "chat":
            guard let latest = frame.latest else { return .none }
            // A newer position is new messages; the same one means a message changed, such as its buttons.
            return latest > (log.last?.seq ?? 0) ? .new : .changed
        case "reply":
            // The finished entry is here already: frames that come late show nothing.
            if let operation = frame.operationId, log.contains(where: { $0.id == ChatEntry.answerID(operation) }) { return .none }
            live.receive(frame)
            return .none
        default: return .none
        }
    }

    /// An app message without Umpi's reply yet, sent within the last ten minutes.
    func isThinking(now: Date = Date(), pending: Int = 0) -> Bool {
        if pending > 0 { return true }
        guard let last = entries.last(where: { $0.fromOwner && $0.surface == "app" }), let operation = last.operationId else { return false }
        let answered = entries.contains { !$0.fromOwner && $0.operationId == operation }
        return !answered && (last.date.map { now.timeIntervalSince($0) < 600 } ?? false)
    }

    static func merge(_ current: [ChatEntry], _ incoming: [ChatEntry]) -> [ChatEntry] {
        var bySeq = Dictionary(current.map { ($0.seq, $0) }, uniquingKeysWith: { $1 })
        for entry in incoming { bySeq[entry.seq] = entry }
        return bySeq.values.sorted { $0.seq < $1.seq }
    }

    private func page(_ transport: any CompanionTransport, query: String) async throws -> ChatPage {
        let data = try await transport.send(path: "/api/device/chat\(query)", method: "GET", body: nil)
        return try JSONDecoder().decode(ChatPage.self, from: data)
    }

    /// Reads the newest page, or what is new since the last read.
    func refresh(_ store: CompanionStore) async {
        guard let transport = store.chatTransport, !fetching else { return }
        fetching = true; defer { fetching = false }
        await restoreSaved().value
        if log.isEmpty { isLoading = true }
        defer { if isLoading { isLoading = false } }
        do {
            if log.isEmpty || !refreshedOnce {
                // The first read after launch takes the newest page whole, so messages shown from the saved copy get
                // their current buttons; later reads only fetch what is new.
                let result = try await page(transport, query: "?limit=50")
                await show(log.isEmpty ? result.entries : ChatModel.merge(log, result.entries))
                let older = result.more || (log.first?.seq ?? 0) > (result.entries.first?.seq ?? 0)
                if older != hasOlder { hasOlder = older }
                latest = result.latest
                refreshedOnce = true
            } else {
                var after = log.last?.seq ?? 0
                while true {
                    let result = try await page(transport, query: "?after=\(after)&limit=100")
                    await show(ChatModel.merge(log, result.entries)); latest = result.latest
                    guard result.more, let last = result.entries.last?.seq else { break }
                    after = last
                }
            }
            if errorMessage != nil { errorMessage = nil }
            save(store)
        } catch {
            // With a saved copy on screen, a failed refresh is not worth a banner; the socket retries.
            if log.isEmpty { errorMessage = (error as? LocalizedError)?.errorDescription ?? "Chat could not be loaded." }
        }
    }

    /// Makes `entries` the conversation. The newest of them, which the chat draws first, are prepared off the main
    /// actor before the chat sees them. Only one read runs at a time (`fetching`), so nothing else changes the entries
    /// while this waits.
    private func show(_ entries: [ChatEntry], preparing count: Int = ChatRowWindow.first) async {
        guard entries != log else { return }
        await ChatPreparation.prepare(entries.suffix(count))
        setEntries(entries)
    }

    @ObservationIgnored private var refreshedOnce = false
    /// The first read since launch has finished, so what arrives next is new.
    var hasRefreshed: Bool { refreshedOnce }

    init() {}

    deinit {
        // A model that showed a conversation takes what was kept for drawing it along, so nothing of a pairing that
        // ended stays in memory. A model that was never read kept nothing.
        guard let restoring else { return }
        restoring.cancel()
        ChatPreparation.forget()
    }

    @ObservationIgnored private var restoring: Task<Void, Never>?

    /// Starts reading the saved copy, once. The last messages, kept on the device, show as soon as they are read and
    /// prepared; the first refresh waits for them and then brings them up to date.
    @discardableResult private func restoreSaved() -> Task<Void, Never> {
        if let restoring { return restoring }
        let task = Task { [weak self] in
            let saved = await ChatModel.restored()
            guard let self, !Task.isCancelled else { return }
            if !saved.isEmpty, self.log.isEmpty {
                self.setEntries(saved)
                self.hasOlder = true
                self.lastSaved = Array(saved.suffix(ChatModel.savedCount))
                self.savedRevision = self.revision
            }
            self.hasRestored = true
            ChatPreparation.prepareLater(saved.dropLast(ChatRowWindow.first))
        }
        restoring = task
        return task
    }

    /// The saved copy, read and prepared for drawing off the main actor.
    nonisolated private static func restored() async -> [ChatEntry] {
        await Task.detached(priority: .userInitiated) {
            let entries = saved()
            ChatPreparation.run(entries.suffix(ChatRowWindow.first))
            return entries
        }.value
    }

    /// The newest 100 entries, kept in the app's caches (not backed up) for the next launch.
    nonisolated static let savedCount = 100
    nonisolated static let savedCopy = ChatSavedCopy(url: try? FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("chat-recent.json"))
    nonisolated static func saved() -> [ChatEntry] { savedCopy.read() }

    /// What the saved copy holds, and the revision it was compared at.
    @ObservationIgnored private var lastSaved: [ChatEntry] = []
    @ObservationIgnored private var savedRevision = 0

    /// Saves the newest entries when they differ from the saved copy; the file is written off the main actor. Nothing
    /// is written after a disconnect, which removes the copy.
    private func save(_ store: CompanionStore) {
        guard store.isPaired, revision != savedRevision else { return }
        savedRevision = revision
        let recent = Array(log.suffix(ChatModel.savedCount))
        guard recent != lastSaved else { return }
        lastSaved = recent
        ChatModel.savedCopy.write(recent)
    }

    private(set) var notice: String?
    @ObservationIgnored private var pressing: Set<String> = []

    /// Presses a button on one of Umpi's messages; the server runs the same handler as Telegram's.
    func press(_ store: CompanionStore, seq: Int, data: String) async {
        guard let transport = store.chatTransport, !pressing.contains("\(seq):\(data)") else { return }
        pressing.insert("\(seq):\(data)"); defer { pressing.remove("\(seq):\(data)") }
        struct Press: Encodable { var seq: Int; var data: String }
        struct Answer: Decodable { var text: String }
        do {
            let reply = try await transport.send(path: "/api/device/chat/press", method: "POST", body: JSONEncoder().encode(Press(seq: seq, data: data)))
            notice = (try? JSONDecoder().decode(Answer.self, from: reply))?.text
        } catch {
            notice = (error as? LocalizedError)?.errorDescription ?? "The button could not be pressed."
        }
        await refreshAll(store)
    }
    func clearNotice() { notice = nil }
    func show(_ message: String) { notice = message }

    /// Reads the newest page again, so changed buttons on recent messages show.
    func refreshAll(_ store: CompanionStore) async {
        guard let transport = store.chatTransport, !fetching else { return }
        fetching = true; defer { fetching = false }
        await restoreSaved().value
        if let result = try? await page(transport, query: "?limit=50") { await show(ChatModel.merge(log, result.entries)); latest = result.latest; save(store) }
    }

    func loadOlder(_ store: CompanionStore) async {
        guard let transport = store.chatTransport, let first = log.first?.seq, hasOlder, !fetching else { return }
        fetching = true; defer { fetching = false }
        do {
            let result = try await page(transport, query: "?before=\(first)&limit=50")
            // The chat shows every entry of the page at once, so all of them are prepared.
            await ChatPreparation.prepare(result.entries)
            setEntries(ChatModel.merge(log, result.entries))
            if hasOlder != result.more { hasOlder = result.more }
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Older messages could not be loaded."
        }
    }

    /// Keeps the socket open while the chat is visible; each "chat changed" reads the new entries.
    func stayLive(_ store: CompanionStore) async {
        var delay: UInt64 = 1
        while !Task.isCancelled {
            guard let request = store.chatSocketRequest() else { return }
            let task = session.webSocketTask(with: request)
            socket = task
            task.resume()
            isLive = true
            await refresh(store)
            // A connection can die without closing (the Mac sleeps, the network changes), leaving the socket waiting
            // for ever: a ping that gets no answer closes it, and the loop connects again and reads what was missed.
            let heartbeat = Task { [weak task] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(25))
                    guard let task, !Task.isCancelled else { return }
                    if await !ChatModel.ping(task, within: 10) {
                        ChatModel.log.notice("chat socket: no answer to a ping; connecting again")
                        task.cancel(with: .goingAway, reason: nil)
                        return
                    }
                }
            }
            do {
                while !Task.isCancelled {
                    let message = try await task.receive()
                    delay = 1
                    if case .string(let text) = message {
                        switch receive(socketText: text) {
                        case .new: await refresh(store)
                        case .changed: await refreshAll(store)
                        case .none: break
                        }
                    }
                }
            } catch {
                // Closed, offline, or revoked: wait and reconnect while the chat is open.
                ChatModel.log.notice("chat socket closed (\(error.localizedDescription, privacy: .public)); connecting again in \(delay) s")
            }
            heartbeat.cancel()
            isLive = false
            task.cancel(with: .goingAway, reason: nil)
            // Waits before trying again, unless asked to connect at once (the app came back to the front).
            for _ in 0..<delay where !hurry && !Task.isCancelled { try? await Task.sleep(for: .seconds(1)) }
            if hurry { hurry = false; delay = 1 } else { delay = min(delay * 2, 30) }
        }
        socket?.cancel(with: .goingAway, reason: nil)
        isLive = false
        // The chat stopped watching (it left the screen); that is not being offline.
        offlineTimer?.cancel()
        isOffline = false
    }

    private static let log = Logger(subsystem: "umpi.chat", category: "socket")

    /// Catches up at once and opens a new socket, which reads what was missed: when the app comes back to the front
    /// or the Mac wakes, as the old connection may have died while it was away.
    func catchUp(_ store: CompanionStore) {
        hurry = true
        socket?.cancel(with: .goingAway, reason: nil)
        Task { await refresh(store) }
    }
    @ObservationIgnored private var hurry = false

    /// Whether the coordinator answers a ping within `seconds`.
    nonisolated private static func ping(_ task: URLSessionWebSocketTask, within seconds: Double) async -> Bool {
        let answered = OSAllocatedUnfairLock(initialState: false)
        return await withCheckedContinuation { continuation in
            // Whichever comes first, the answer or the time limit, resumes it.
            let finish: @Sendable (Bool) -> Void = { ok in
                if answered.withLock({ done in defer { done = true }; return !done }) { continuation.resume(returning: ok) }
            }
            task.sendPing { error in finish(error == nil) }
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { finish(false) }
        }
    }

    private func settleOffline() {
        offlineTimer?.cancel()
        let live = isLive
        offlineTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(live ? 3 : 2))
            guard !Task.isCancelled, let self, self.isLive == live else { return }
            self.isOffline = !live
        }
    }
}

/// The saved copy of the conversation: a file that is written off the main actor, one write after another. `remove`
/// (a disconnect) deletes the file and drops every write that was queued before it, so a write that was waiting cannot
/// bring the copy back.
final class ChatSavedCopy: @unchecked Sendable {
    private let url: URL?
    private let queue: DispatchQueue
    private let lock = NSLock()
    /// Counts removals. A write runs only if none came after it was queued.
    private var removals = 0

    init(url: URL?, queue: DispatchQueue = DispatchQueue(label: "umpi.chat.save", qos: .utility)) {
        self.url = url
        self.queue = queue
    }

    func read() -> [ChatEntry] {
        guard let url, let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([ChatEntry].self, from: data)) ?? []
    }

    /// Queues a write of the newest entries.
    func write(_ entries: [ChatEntry]) {
        let queued = lock.withLock { removals }
        queue.async { [self] in
            guard let url, let data = try? JSONEncoder().encode(Array(entries.suffix(ChatModel.savedCount))) else { return }
            // The check and the write are one step for `remove`: it waits for a write that has started, and stops
            // one that has not.
            lock.withLock {
                guard removals == queued else { return }
                try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        }
    }

    /// Deletes the copy. Writes queued before this call do nothing.
    func remove() {
        lock.withLock {
            removals += 1
            if let url { try? FileManager.default.removeItem(at: url) }
        }
    }

    /// Returns when the writes queued so far have run.
    func flush() { queue.sync {} }
}

/// Replies that are still being written. The coordinator sends a typed turn's reply over the chat socket as it is
/// written: text for a part (one model message of the answer), the name of a tool that started, and the end. The chat
/// shows such a reply in the place its finished entry will take, and the entry replaces it when it arrives.
///
/// Frames can come many times a second. They are gathered here and shown at most ten times a second; each showing
/// parses only the end of the text (`MarkdownDocument.growing`). A reply with no frame for two minutes, and no entry,
/// is removed. A dropped socket removes nothing: what was shown stays until the entry arrives or the two minutes pass.
@MainActor @Observable
final class LiveReplies {
    /// A frame of the chat socket. `chat` frames have `latest`; `reply` and `speech` frames have the rest.
    struct Frame: Decodable, Equatable {
        var type: String
        var latest: Int? = nil
        var operationId: String? = nil
        var part: Int? = nil
        var text: String? = nil
        var working: String? = nil
        var done: Bool? = nil
    }

    /// A reply as the chat draws it.
    struct Reply: Equatable {
        var document: MarkdownDocument
        /// What Umpi is doing while a tool runs after some text, as a short phrase; nil while it writes.
        var status: String?
    }

    static let showInterval: TimeInterval = 0.1
    static let quietLimit: TimeInterval = 120

    /// The replies that have text, by operation, as last shown.
    private(set) var shown: [String: Reply] = [:]
    /// The operations whose replies have text, in the order their text began. It changes only when a reply starts
    /// to show or stops, so the chat derives its rows again only then.
    private(set) var writing: [String] = []
    /// When each reply's text began, for the place of its row.
    @ObservationIgnored private(set) var began: [String: Date] = [:]
    /// How often `shown` was updated.
    @ObservationIgnored private(set) var showings = 0

    private struct Gathered {
        var parts: [Int: String] = [:]
        var working: String?
        var lastFrame: Date
        var changed = true
    }
    @ObservationIgnored private var gathered: [String: Gathered] = [:]
    /// Operations whose entry arrived, so frames that come late for them show nothing.
    @ObservationIgnored private var settled: [String] = []
    @ObservationIgnored private var lastShowing = Date.distantPast
    @ObservationIgnored private var pendingShow: Task<Void, Never>?
    @ObservationIgnored private var pendingPrune: Task<Void, Never>?
    @ObservationIgnored private let now: @MainActor () -> Date

    init(now: @escaping @MainActor () -> Date = { Date() }) { self.now = now }

    /// Takes a `reply` frame. Any other frame, such as voice mode's `speech`, is not for the chat.
    func receive(_ frame: Frame) {
        guard frame.type == "reply", let operation = frame.operationId, !settled.contains(operation) else { return }
        var reply = gathered[operation] ?? Gathered(lastFrame: now())
        reply.lastFrame = now()
        if frame.done == true {
            reply.working = nil
        } else if let part = frame.part, let text = frame.text {
            reply.parts[part, default: ""] += text
            reply.working = nil
        } else if frame.part != nil, let working = frame.working {
            reply.working = working
        } else {
            return
        }
        reply.changed = true
        gathered[operation] = reply
        scheduleShow()
        schedulePrune()
    }

    /// Shows what was gathered, now.
    func show() {
        pendingShow?.cancel(); pendingShow = nil
        lastShowing = now()
        var next = shown, order = writing
        for (operation, reply) in gathered where reply.changed {
            gathered[operation]?.changed = false
            // Parts are separate messages of the answer: a blank line parts them.
            let text = reply.parts.keys.sorted().compactMap { reply.parts[$0] }.filter { !$0.isEmpty }.joined(separator: "\n\n")
            guard !text.isEmpty else { continue }
            if next[operation] == nil { order.append(operation); began[operation] = began[operation] ?? now() }
            next[operation] = Reply(document: .growing(text, after: next[operation]?.document), status: reply.working.map(LiveReplies.phrase))
        }
        guard next != shown else { return }
        showings += 1
        shown = next
        if order != writing { writing = order }
    }

    /// Removes the replies whose entry arrived; `answered` tells whether an entry with that ID is in the chat.
    func settle(answered: (String) -> Bool) {
        guard !gathered.isEmpty else { return }
        for operation in Array(gathered.keys) where answered(ChatEntry.answerID(operation)) {
            settled.append(operation)
            remove(operation)
        }
        if settled.count > 50 { settled.removeFirst(settled.count - 50) }
    }

    /// Removes the replies that had no frame for two minutes.
    func prune() {
        let time = now()
        for (operation, reply) in gathered where time.timeIntervalSince(reply.lastFrame) >= LiveReplies.quietLimit { remove(operation) }
    }

    private func remove(_ operation: String) {
        gathered[operation] = nil
        began[operation] = nil
        if shown[operation] != nil { shown[operation] = nil }
        if writing.contains(operation) { writing.removeAll { $0 == operation } }
    }

    /// At most one showing in each interval: the first frame after a pause shows at once, the next ones together.
    private func scheduleShow() {
        let wait = LiveReplies.showInterval - now().timeIntervalSince(lastShowing)
        guard wait > 0 else { show(); return }
        guard pendingShow == nil else { return }
        pendingShow = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled else { return }
            self?.pendingShow = nil
            self?.show()
        }
    }

    private func schedulePrune() {
        pendingPrune?.cancel()
        pendingPrune = Task { [weak self] in
            try? await Task.sleep(for: .seconds(LiveReplies.quietLimit + 1))
            guard !Task.isCancelled else { return }
            self?.prune()
        }
    }

    /// A tool's name as a short phrase for the owner.
    static func phrase(_ tool: String) -> String {
        switch tool {
        case "web_search": "Searching the web…"
        case "read_web_page": "Reading a page…"
        case "read_calendar": "Checking your calendar…"
        case "mail", "read_mail_follow_through": "Checking your mail…"
        case "create_reminder", "list_reminders", "cancel_reminder": "Looking at your reminders…"
        case "read_history", "read_activity": "Looking back…"
        case "show_ui": "Laying it out…"
        default: "Working…"
        }
    }
}

/// What a message's row needs before it is drawn, worked out off the main actor: its Markdown parsed, its code
/// colored, and the previews of what it carried decoded. A row that is drawn without it works it out then.
enum ChatPreparation {
    /// Prepares the entries and returns when they are ready.
    static func prepare(_ entries: some Sequence<ChatEntry>) async {
        let entries = Array(entries).filter(needs)
        guard !entries.isEmpty else { return }
        await Task.detached(priority: .userInitiated) { run(entries) }.value
    }

    /// Prepares the entries in the background: older messages, which show only when the owner scrolls up to them.
    static func prepareLater(_ entries: some Sequence<ChatEntry>) {
        let entries = Array(entries).filter(needs)
        guard !entries.isEmpty else { return }
        Task.detached(priority: .utility) { run(entries) }
    }

    private static func needs(_ entry: ChatEntry) -> Bool {
        !MarkdownCache.has(entry.text) || (entry.fromOwner && entry.showsMedia && entry.operationId != nil)
    }

    /// Prepares the entries now, newest first, on the caller's thread. Code is colored after this returns: a view
    /// draws code plain until its colours are ready.
    static func run(_ entries: some BidirectionalCollection<ChatEntry>) {
        for entry in entries.reversed() {
            var code: [(language: String?, text: String)] = []
            for block in MarkdownCache.document(entry.text).blocks { block.content.code(into: &code) }
            for block in code { SyntaxHighlighter.shared.warm(block.text, language: block.language) }
            if entry.fromOwner, entry.showsMedia, let key = entry.operationId { _ = LocalMedia.shown(key) }
        }
    }

    /// Forgets everything kept for drawing messages.
    static func forget() {
        MarkdownCache.removeAll()
        SyntaxHighlighter.shared.removeAll()
        LocalMedia.forgetShown()
        MermaidView.known.removeAll()
    }
}

/// What the chat should do when it appears or is already showing: open voice mode, or begin a draft. Kept here
/// rather than sent as a notification, so a chat screen that does not exist yet still gets it.
@MainActor @Observable
final class ChatRequests {
    static let shared = ChatRequests()
    /// Open voice mode.
    var talk = false
    var draft: String?
    /// The chat is the screen in front, so its messages need no notification.
    var chatVisible = false
}
