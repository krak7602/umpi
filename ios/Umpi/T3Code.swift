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

    var connected: Bool { status == "connected" }
    var expires: Date? { expiresAt.flatMap(T3Date.parse) }
    /// One line for the machine's state.
    var summary: String {
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
        _ = try? await transport.send(path: "/api/device/t3/machines/\(machine.id)", method: "DELETE", body: nil)
        machines.removeAll { $0.id == machine.id }
        T3CodeModel.save(machines)
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
    static func clearSaved() { if let url = savedURL { try? FileManager.default.removeItem(at: url) } }
}
