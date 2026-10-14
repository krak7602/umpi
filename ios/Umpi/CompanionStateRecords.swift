import Foundation

struct FieldDraft: Codable, Equatable {
    var value: FieldValue
    var editID: String
}
struct WorkflowDraft: Codable, Equatable {
    var baseRevision: Int
    var fields: [String: FieldDraft]
}
struct MessageRequest: Codable, Equatable { var id: String; var text: String }
struct ActionRequest: Codable, Equatable {
    var id: String
    var capability: String
    var input: [String: FieldValue]
}
struct ActionAcknowledgment: Codable, Equatable { var status: String; var result: String? }
struct JobDecision: Codable, Equatable { var version: Int }
struct ChoiceAnswer: Codable, Equatable { var answer: String }

/// The encoded payload itself, not a closure, is retained for exact request replay.
enum OutboxPayload: Codable, Equatable {
    case mutation(CompanionMutation, edits: [String: String])
    case message(MessageRequest)
    case action(ActionRequest)
    case acknowledgment(actionID: String, ActionAcknowledgment)
    case job(id: String, decision: String, version: Int)
    case choice(id: String, answer: String)
}
struct OutboxEntry: Codable, Equatable, Identifiable {
    var id: String
    var payload: OutboxPayload
    var status: String = "queued"
    var error: String? = nil
}
struct CompanionDiskState: Codable {
    var deviceID: String? = nil
    var snapshot: DeviceSnapshot? = nil
    var drafts: [String: WorkflowDraft] = [:]
    var outbox: [OutboxEntry] = []
    var conflicts: [WorkflowConflict] = []
    var runs: [WorkflowRun] = []
    var localActions: [String: DeviceAction] = [:]
    var effectOutcomes: [String: DeviceEffectOutcome] = [:]
    var remoteEffectsAllowed = false
    var lastSyncedAt: Date? = nil
}
