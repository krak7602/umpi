import Foundation
import Observation

/// A T3 Code machine Umpi reads through T3 Connect, as the coordinator reports it (never its tokens).
struct T3Machine: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var label: String
    var host: String
    var status: String
    var addedAt: String
    var connectedAt: String?
    var expiresAt: String?
    var error: String?
    var environmentLabel: String?
    var threads: [T3Thread]?
    var problem: String?
    var kind: String?
    var asleep: Bool?

    var connected: Bool { status == "connected" }
    /// One of Umpi's cloud machines: a container per session that sleeps when idle.
    var cloud: Bool { kind == "cloud" }
    var name: String { cloud ? "☁︎ \(label)" : label }
    var expires: Date? { expiresAt.flatMap(T3Date.parse) }
    /// One line for the machine's state.
    var summary: String {
        if cloud { return asleep == true ? "Cloud · asleep, saved" : "Cloud · awake" }
        switch status {
        case "connected":
            guard let expires else { return "Connected" }
            let days = Int(ceil(expires.timeIntervalSinceNow / 86_400))
            return days <= 5 ? "Connected · approval ends in \(max(days, 0)) day\(days == 1 ? "" : "s")" : "Connected"
        case "pending": return "Waiting for approval on the machine"
        case "expired": return "Approval ended · approve again"
        default: return error ?? "Not connected"
        }
    }
}

struct T3Thread: Codable, Equatable, Identifiable, Sendable {
    var threadId: String
    var title: String
    var status: String
    var settled: Bool
    var projectId: String?
    var project: String?
    var createdAt: String?
    var updatedAt: String?
    var model: String?
    var branch: String?
    var subagent: Bool?
    var pullRequests: Int?
    var snippet: String?

    var id: String { threadId }
    var updated: Date? { updatedAt.flatMap(T3Date.parse) }
    /// Working now, or waiting on the owner.
    var active: Bool { ["preparing", "queued", "starting", "running", "waiting"].contains(status) }
    var symbol: String {
        switch status {
        case "running", "starting", "preparing", "queued": "circle.dotted.circle"
        case "waiting": "hand.raised"
        case "completed": "checkmark.circle"
        case "failed": "exclamationmark.triangle"
        case "interrupted", "cancelled", "rolled_back": "stop.circle"
        default: "circle"
        }
    }
    var statusText: String { status == "waiting" ? "Waiting on you" : status.replacingOccurrences(of: "_", with: " ").capitalized }
}

struct T3Message: Codable, Equatable, Identifiable, Sendable {
    var position: Int
    var type: String
    var by: String?
    var text: String
    var truncated: Bool?
    var at: String?
    var id: Int { position }
    var fromOwner: Bool { type == "user_message" || by == "user" }
}

struct T3ThreadRead: Codable, Sendable {
    var thread: T3Thread?
    var messages: [T3Message]
    var nextPosition: Int?
    var hasMore: Bool
}

/// An action Umpi decided on and asked the owner to approve, as its card shows it.
struct T3Request: Codable, Equatable, Identifiable, Sendable {
    struct Action: Codable, Equatable, Sendable {
        var kind: String
        var threadId: String?
        var message: String?
        var title: String?
        var project: String?
        var branch: String?
        var reason: String?
    }
    var id: String
    var machineLabel: String
    var action: Action
    var summary: String
    var threadTitle: String?
    var why: String?
    var status: String
    var createdAt: String
    var decidedAt: String?
    var expiresAt: String
    var outcome: String?

    var pending: Bool { status == "pending" }
    var expires: Date? { T3Date.parse(expiresAt) }
    var decided: Date? { decidedAt.flatMap(T3Date.parse) }
    /// One line saying what Umpi wants to do.
    var headline: String {
        let thread = threadTitle.map { "“\($0)”" } ?? "a thread"
        switch action.kind {
        case "send": return "Message \(thread)"
        case "start": return "Start “\(action.title ?? "a thread")”"
        case "stop": return "Stop \(thread)"
        case "answer": return "Answer \(thread)"
        default: return "Act on \(thread)"
        }
    }
    /// The words that would be sent, if any.
    var quoted: String? { action.kind == "stop" ? action.reason : action.message }
    var place: String { [machineLabel, action.project, action.branch].compactMap { $0 }.joined(separator: " · ") }
}

/// Questions an agent is waiting on; answers are keyed by question ID.
struct T3QuestionSet: Codable, Equatable, Identifiable, Sendable {
    struct Question: Codable, Equatable, Identifiable, Sendable {
        struct Option: Codable, Equatable, Sendable { var label: String; var description: String?; var value: String? }
        var id: String
        var header: String?
        var question: String
        var options: [Option]
        var multiSelect: Bool?
        var allowCustomAnswer: Bool?
    }
    var requestId: String
    var questions: [Question]
    var id: String { requestId }
}

enum T3Date {
    static func parse(_ value: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
    }
}

/// The owner's T3 Code machines and their recent threads. The last overview is kept on the phone, so Work shows it at once.
@MainActor @Observable
final class T3CodeModel {
    private(set) var machines: [T3Machine] = []
    private(set) var loading = false
    private(set) var problem: String?
    private(set) var requests: [T3Request] = []

    var pendingRequests: [T3Request] { requests.filter(\.pending) }
    /// Threads waiting on the owner, with their machine.
    var waitingThreads: [(machine: T3Machine, thread: T3Thread)] {
        machines.flatMap { machine in (machine.threads ?? []).filter { $0.status == "waiting" && $0.subagent != true }.map { (machine, $0) } }
    }
    /// What the Work badge counts: approvals and agents waiting on an answer.
    var needsYou: Int { pendingRequests.count + waitingThreads.count }

    private struct Requests: Decodable { var requests: [T3Request] }
    func loadRequests(_ store: CompanionStore) async {
        guard let transport = store.chatTransport,
              let data = try? await transport.send(path: "/api/device/t3/requests", method: "GET", body: nil),
              let list = try? JSONDecoder().decode(Requests.self, from: data) else { return }
        if list.requests != requests { requests = list.requests }
    }
    func request(_ id: String) -> T3Request? { requests.first { $0.id == id } }

    /// Approves or declines an action Umpi asked about; the card then shows what became of it.
    @discardableResult func decide(_ store: CompanionStore, _ id: String, approve: Bool) async -> String? {
        guard let transport = store.chatTransport else { return nil }
        struct Answer: Decodable { var text: String }
        let reply = try? await transport.send(path: "/api/device/t3/requests/\(id)/\(approve ? "approve" : "decline")", method: "POST", body: Data("{}".utf8))
        await loadRequests(store)
        return reply.flatMap { try? JSONDecoder().decode(Answer.self, from: $0) }?.text
    }

    private struct Questions: Decodable { var requests: [T3QuestionSet] }
    func questions(_ store: CompanionStore, machine: String, thread: String) async -> [T3QuestionSet] {
        guard let transport = store.chatTransport else { return [] }
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "machine", value: machine), URLQueryItem(name: "id", value: thread)]
        guard let data = try? await transport.send(path: "/api/device/t3/questions?\(query.percentEncodedQuery ?? "")", method: "GET", body: nil) else { return [] }
        return (try? JSONDecoder().decode(Questions.self, from: data))?.requests ?? []
    }

    /// The owner's answer to an agent's question.
    func answer(_ store: CompanionStore, machine: String, thread: String, question: String, answers: [String: AnswerValue]) async throws {
        guard let transport = store.chatTransport else { throw CompanionClientError.invalidServer }
        struct Body: Encodable { var machine: String; var requestId: String; var kind = "answer"; var threadId: String; var question: String; var answers: [String: AnswerValue] }
        _ = try await transport.send(path: "/api/device/t3/act", method: "POST",
                                     body: JSONEncoder().encode(Body(machine: machine, requestId: UUID().uuidString, threadId: thread, question: question, answers: answers)))
    }
    enum AnswerValue: Encodable, Sendable {
        case one(String), many([String])
        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self { case .one(let value): try container.encode(value); case .many(let values): try container.encode(values) }
        }
    }

    init() { machines = T3CodeModel.saved() }

    private struct List: Decodable { var machines: [T3Machine] }
    struct Started: Decodable { var machine: T3Machine; var authorizeUrl: String }

    /// Machines only: quick, no calls to the machines.
    func loadMachines(_ store: CompanionStore) async {
        guard let transport = store.chatTransport else { return }
        do {
            let list = try JSONDecoder().decode(List.self, from: try await transport.send(path: "/api/device/t3", method: "GET", body: nil))
            // Keep the threads already shown for machines that are still there.
            machines = list.machines.map { machine in
                var merged = machine
                if let shown = machines.first(where: { $0.id == machine.id }) { merged.threads = shown.threads; merged.problem = shown.problem }
                return merged
            }
            problem = nil
        } catch { problem = (error as? LocalizedError)?.errorDescription ?? "T3 Code machines could not be loaded." }
    }

    /// Machines and their recent threads; each connected machine is asked through T3 Connect.
    func loadThreads(_ store: CompanionStore) async {
        guard let transport = store.chatTransport, !loading else { return }
        loading = true; defer { loading = false }
        do {
            let list = try JSONDecoder().decode(List.self, from: try await transport.send(path: "/api/device/t3/threads", method: "GET", body: nil))
            machines = list.machines
            problem = nil
            T3CodeModel.save(machines)
        } catch { problem = (error as? LocalizedError)?.errorDescription ?? "T3 Code threads could not be loaded." }
    }

    /// Adds a machine and returns the approval page to open.
    func add(_ store: CompanionStore, url: String, label: String) async throws -> URL {
        guard let transport = store.chatTransport else { throw CompanionClientError.invalidServer }
        struct Body: Encodable { var url: String; var label: String? }
        let data = try await transport.send(path: "/api/device/t3/machines", method: "POST",
                                            body: JSONEncoder().encode(Body(url: url, label: label.isEmpty ? nil : label)))
        let started = try JSONDecoder().decode(Started.self, from: data)
        await loadMachines(store)
        guard let page = URL(string: started.authorizeUrl) else { throw CompanionClientError.invalidResponse }
        return page
    }

    /// Starts approval again (after 30 days, or when it did not finish).
    func approve(_ store: CompanionStore, _ machine: T3Machine) async throws -> URL {
        guard let transport = store.chatTransport else { throw CompanionClientError.invalidServer }
        let data = try await transport.send(path: "/api/device/t3/machines/\(machine.id)/connect", method: "POST", body: Data("{}".utf8))
        let started = try JSONDecoder().decode(Started.self, from: data)
        await loadMachines(store)
        guard let page = URL(string: started.authorizeUrl) else { throw CompanionClientError.invalidResponse }
        return page
    }

    func remove(_ store: CompanionStore, _ machine: T3Machine) async {
        guard let transport = store.chatTransport else { return }
        // A cloud machine is deleted with its saved state; a machine of the owner's is only forgotten.
        _ = try? await transport.send(path: machine.cloud ? "/api/device/cloud/\(machine.id)" : "/api/device/t3/machines/\(machine.id)", method: "DELETE", body: nil)
        machines.removeAll { $0.id == machine.id }
        T3CodeModel.save(machines)
    }

    /// The owner's own action on a thread: send a message or stop it. It runs at once.
    func act(_ store: CompanionStore, machine: String, thread: String, kind: String, message: String? = nil) async throws {
        guard let transport = store.chatTransport else { throw CompanionClientError.invalidServer }
        struct Body: Encodable { var machine: String; var requestId: String; var kind: String; var threadId: String; var message: String? }
        _ = try await transport.send(path: "/api/device/t3/act", method: "POST",
                                     body: JSONEncoder().encode(Body(machine: machine, requestId: UUID().uuidString, kind: kind, threadId: thread, message: message)))
    }

    /// Wakes a sleeping cloud machine, restoring its saved state.
    func wake(_ store: CompanionStore, _ machine: T3Machine) async throws {
        guard let transport = store.chatTransport else { throw CompanionClientError.invalidServer }
        _ = try await transport.send(path: "/api/device/cloud/\(machine.id)/wake", method: "POST", body: Data("{}".utf8))
        await loadMachines(store)
    }

    func read(_ store: CompanionStore, machine: String, thread: String) async throws -> T3ThreadRead {
        guard let transport = store.chatTransport else { throw CompanionClientError.invalidServer }
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "machine", value: machine), URLQueryItem(name: "id", value: thread)]
        let data = try await transport.send(path: "/api/device/t3/thread?\(query.percentEncodedQuery ?? "")", method: "GET", body: nil)
        return try JSONDecoder().decode(T3ThreadRead.self, from: data)
    }

    private static var savedURL: URL? {
        try? FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("t3-overview.json")
    }
    static func saved() -> [T3Machine] {
        guard let url = savedURL, let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([T3Machine].self, from: data)) ?? []
    }
    static func save(_ machines: [T3Machine]) {
        guard let url = savedURL, let data = try? JSONEncoder().encode(machines) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    static func path(for query: [URLQueryItem]) -> String { var parts = URLComponents(); parts.queryItems = query; return parts.percentEncodedQuery ?? "" }
    static func clearSaved() { if let url = savedURL { try? FileManager.default.removeItem(at: url) } }
}
