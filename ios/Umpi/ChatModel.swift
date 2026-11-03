import Foundation
import Observation

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
    private(set) var isLive = false

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
            if entries.isEmpty {
                let result = try await page(transport, query: "?limit=50")
                entries = result.entries; hasOlder = result.more; latest = result.latest
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
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Chat could not be loaded."
        }
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
            do {
                while !Task.isCancelled {
                    let message = try await task.receive()
                    delay = 1
                    if case .string(let text) = message, let data = text.data(using: .utf8),
                       let change = try? JSONDecoder().decode(Change.self, from: data), change.type == "chat", change.latest > (entries.last?.seq ?? 0) {
                        await refresh(store)
                    }
                }
            } catch {
                // Closed, offline, or revoked: wait and reconnect while the chat is open.
            }
            isLive = false
            task.cancel(with: .goingAway, reason: nil)
            try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            delay = min(delay * 2, 30)
        }
        socket?.cancel(with: .goingAway, reason: nil)
        isLive = false
    }
    private struct Change: Decodable { var type: String; var latest: Int }
}
