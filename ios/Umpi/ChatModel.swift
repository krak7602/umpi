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

    var fromOwner: Bool { role == "owner" }
    var date: Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(at)) ?? (try? Date.ISO8601FormatStyle().parse(at))
    }
}

struct ChatPage: Codable, Sendable {
    var entries: [ChatEntry]
    var latest: Int
    var more: Bool
}

/// The chat screen's state: history pages, newer entries announced by the socket, and Umpi's thinking state.
@MainActor @Observable
final class ChatModel {
    private(set) var entries: [ChatEntry] = []
    private(set) var hasOlder = false
    private(set) var isLoading = false
    private(set) var errorMessage: String?
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
    @ObservationIgnored private let session = URLSession(configuration: .ephemeral)

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
        if entries.isEmpty { isLoading = true }
        defer { isLoading = false }
        do {
            if entries.isEmpty || !refreshedOnce {
                // The first read after launch takes the newest page whole, so messages shown from the saved copy get
                // their current buttons; later reads only fetch what is new.
                let result = try await page(transport, query: "?limit=50")
                entries = entries.isEmpty ? result.entries : ChatModel.merge(entries, result.entries)
                hasOlder = result.more || (entries.first?.seq ?? 0) > (result.entries.first?.seq ?? 0); latest = result.latest
                refreshedOnce = true
            } else {
                var after = entries.last?.seq ?? 0
                while true {
                    let result = try await page(transport, query: "?after=\(after)&limit=100")
                    entries = ChatModel.merge(entries, result.entries); latest = result.latest
                    guard result.more, let last = result.entries.last?.seq else { break }
                    after = last
                }
            }
            errorMessage = nil
            ChatModel.save(entries)
        } catch {
            // With a saved copy on screen, a failed refresh is not worth a banner; the socket retries.
            if entries.isEmpty { errorMessage = (error as? LocalizedError)?.errorDescription ?? "Chat could not be loaded." }
        }
    }

    @ObservationIgnored private var refreshedOnce = false
    /// The first read since launch has finished, so what arrives next is new.
    var hasRefreshed: Bool { refreshedOnce }

    init() {
        // The last messages, kept on the phone, show at once; the first refresh brings them up to date.
        entries = ChatModel.saved()
        hasOlder = !entries.isEmpty
    }

    /// The newest 100 entries, kept in the app's caches (not backed up) for the next launch.
    private static var savedURL: URL? {
        try? FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("chat-recent.json")
    }
    static func saved() -> [ChatEntry] {
        guard let url = savedURL, let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([ChatEntry].self, from: data)) ?? []
    }
    static func save(_ entries: [ChatEntry]) {
        guard let url = savedURL, let data = try? JSONEncoder().encode(Array(entries.suffix(100))) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
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
        if let result = try? await page(transport, query: "?limit=50") { entries = ChatModel.merge(entries, result.entries); latest = result.latest; ChatModel.save(entries) }
    }

    func loadOlder(_ store: CompanionStore) async {
        guard let transport = store.chatTransport, let first = entries.first?.seq, hasOlder, !fetching else { return }
        fetching = true; defer { fetching = false }
        do {
            let result = try await page(transport, query: "?before=\(first)&limit=50")
            entries = ChatModel.merge(entries, result.entries); hasOlder = result.more
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
                    if case .string(let text) = message, let data = text.data(using: .utf8),
                       let change = try? JSONDecoder().decode(Change.self, from: data), change.type == "chat" {
                        // A newer position is new messages; the same one means a message changed, such as its buttons.
                        if change.latest > (entries.last?.seq ?? 0) { await refresh(store) } else { await refreshAll(store) }
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
    private struct Change: Decodable { var type: String; var latest: Int }

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
