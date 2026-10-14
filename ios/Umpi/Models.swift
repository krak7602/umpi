import Foundation

/// The only values accepted by the bounded workflow protocol.
enum FieldValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let number = try? value.decode(Double.self), number.isFinite { self = .number(number) }
        else { self = .string(try value.decode(String.self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String {
        switch self {
        case .string(let value): value
        case .number(let value): String(value)
        case .bool(let value): value ? "true" : "false"
        case .null: ""
        }
    }
    var boolValue: Bool { if case .bool(let value) = self { value } else { false } }
    var numberValue: Double? { if case .number(let value) = self { value } else { nil } }
}

struct FieldOption: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String
}
struct FieldDefinition: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String
    var kind: String
    var options: [FieldOption]? = nil
}
struct BindingValue: Codable, Equatable, Sendable {
    var fieldId: String? = nil
    var value: FieldValue? = nil
}
struct WorkflowCondition: Codable, Equatable, Sendable {
    var fieldId: String
    var equals: FieldValue
}
struct WorkflowStep: Codable, Equatable, Sendable {
    var kind: String
    var fieldId: String? = nil
    var value: FieldValue? = nil
    var capability: String? = nil
    var input: [String: BindingValue]? = nil
    var text: String? = nil
    var when: WorkflowCondition? = nil
}
struct WorkflowButton: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var title: String
    var steps: [WorkflowStep]
}
struct WorkflowDefinition: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var title: String
    var description: String? = nil
    var fields: [FieldDefinition]
    var actions: [WorkflowButton]
}
struct Workflow: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var revision: Int
    var definition: WorkflowDefinition
    var values: [String: FieldValue]
    var archived: Bool
    var updatedAt: String
}
struct CompanionMutation: Codable, Equatable, Sendable {
    var operationId: String
    var workflowId: String
    var expectedRevision: Int
    var kind: String
    var definition: WorkflowDefinition? = nil
    var values: [String: FieldValue]? = nil
}
struct RemovedWorkflow: Codable, Equatable, Sendable {
    var id: String
    var revision: Int
    var removed: Bool
    var updatedAt: String
}
struct Capability: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var version: Int = 1
    var status: String
    var reason: String? = nil
}
struct Device: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String
    var capabilities: [Capability]
    var lastSeenAt: String
    var revoked: Bool
}
struct DeviceAction: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var deviceId: String
    var capability: String
    var input: [String: FieldValue]
    var status: String
    var createdAt: String
    var updatedAt: String
    var result: String? = nil
    /// Local metadata, never sent to or trusted from the server.
    var isLocal: Bool = false

    enum CodingKeys: String, CodingKey {
        case id, deviceId, capability, input, status, createdAt, updatedAt, result
    }
}
struct DeviceEffectOutcome: Codable, Equatable, Sendable {
    var status: String
    var result: String? = nil
    /// Local receipt metadata. Only true when no OS operation was started.
    var retryableWithoutEffect: Bool? = nil
}
struct JobCompletion: Codable, Equatable, Sendable {
    var executorId: String
    var jobId: String
    var status: String
    var exitCode: Int?
    var output: String
    var truncated: Bool
}
struct Job: Codable, Equatable, Sendable, Identifiable {
    var jobId: String
    var command: String
    var cwd: String
    var timeoutMs: Int
    var createdAt: String
    var channel: String
    var sessionId: String
    var version: Int
    var status: String
    var cancelRequested: Bool
    var executorId: String? = nil
    var approvedAt: String? = nil
    var startedAt: String? = nil
    var completion: JobCompletion? = nil
    var id: String { jobId }
    var isTerminal: Bool { ["succeeded", "failed", "cancelled", "uncertain"].contains(status) }
}
struct Reminder: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var version: Int
    var text: String
    var dueAt: String
    var channel: String
    var status: String
    var createdAt: String
}
struct Choice: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var question: String
    var options: [String]
    var channel: String
    var sessionId: String
    var status: String
    var answer: String? = nil
    var createdAt: String
}
struct Operation: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var requestId: String
    var channel: String
    var sessionId: String
    var text: String
    var status: String
    var createdAt: String
    var result: String? = nil
    var error: String? = nil
}
struct DeviceSnapshot: Codable, Equatable, Sendable {
    var protocolVersion: Int
    var revision: Int
    var serverTime: String
    var device: Device
    var workflows: [Workflow]
    var actions: [DeviceAction]
    var jobs: [Job]
    var reminders: [Reminder]
    var choices: [Choice]
    var operations: [Operation]
}
struct ActivityToken: Codable, Equatable, Sendable {
    var jobId: String
    var token: String
}
struct DeviceRegistration: Codable, Equatable, Sendable {
    var capabilities: [Capability]
    var apnsToken: String? = nil
    var apnsEnvironment: String? = nil
    var activityTokens: [ActivityToken]? = nil
    var activityJobIds: [String]? = nil
}
struct WorkflowConflict: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var workflowID: String
    var localValues: [String: FieldValue]
    var current: Workflow?
    var message: String
    var kind: String
}
struct WorkflowRun: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var workflowID: String
    var buttonID: String
    var title: String
    var nextStep: Int
    var steps: [WorkflowStep]
    var status: String
    var error: String? = nil
    var revision: Int
    var stepIDs: [String]
    var waitingOperationID: String? = nil
}

struct QueuedChange: Identifiable, Equatable {
    var id: String
    var kind: String
    var target: String
    var status: String
    var error: String?
}

struct OrphanedWorkflowDraft: Identifiable, Equatable {
    var id: String
    var values: [String: FieldValue]
}

// Optional Codable synthesis treats explicit JSON null as absence. A null
// workflow value is an intentional clear, not an omitted step argument.
extension BindingValue {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        fieldId = try container.decodeIfPresent(String.self, forKey: .fieldId)
        value = container.contains(.value) ? try container.decode(FieldValue.self, forKey: .value) : nil
    }
}
extension WorkflowStep {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        fieldId = try container.decodeIfPresent(String.self, forKey: .fieldId)
        value = container.contains(.value) ? try container.decode(FieldValue.self, forKey: .value) : nil
        capability = try container.decodeIfPresent(String.self, forKey: .capability)
        input = try container.decodeIfPresent([String: BindingValue].self, forKey: .input)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        when = try container.decodeIfPresent(WorkflowCondition.self, forKey: .when)
    }
}

/// Mirrors the action wire boundary before a durable queue entry or OS call.
enum DeviceActionValidation {
    static func identifier(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\\z", options: .regularExpression) != nil
    }

    static func text(_ value: String, limit: Int, allowEmpty: Bool = false) -> Bool {
        (allowEmpty || !value.isEmpty) && value.utf16.count <= limit && !value.contains("\0")
    }

    static func instant(_ value: String) -> Date? {
        guard text(value, limit: 64),
              value.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})\z"#,
                          options: .regularExpression) != nil else { return nil }
        if !value.hasSuffix("Z") {
            let offset = Array(value.suffix(5).utf8)
            guard let hours = Int(String(decoding: offset[0..<2], as: UTF8.self)),
                  let minutes = Int(String(decoding: offset[3..<5], as: UTF8.self)),
                  hours <= 23, minutes <= 59 else { return nil }
        }
        let parts = Array(value.prefix(19).utf8)
        func number(_ range: Range<Int>) -> Int { Int(String(decoding: parts[range], as: UTF8.self)) ?? -1 }
        let year = number(0..<4), month = number(5..<7), day = number(8..<10)
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        guard (1...12).contains(month), (1...days[month - 1]).contains(day),
              number(11..<13) <= 23, number(14..<16) <= 59, number(17..<19) <= 59 else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static func valid(id: String, deviceID: String, capability: String, input: [String: FieldValue]) -> Bool {
        guard identifier(id), identifier(deviceID) else { return false }
        let keys: Set<String>
        switch capability {
        case "alarm.schedule": keys = ["alarmId", "title", "date"]
        case "alarm.cancel": keys = ["alarmId"]
        case "notification.schedule": keys = ["notificationId", "title", "body", "date"]
        case "notification.cancel": keys = ["notificationId"]
        case "activity.track": keys = ["jobId"]
        default: return false
        }
        guard Set(input.keys) == keys else { return false }
        for (key, field) in input {
            guard case .string(let value) = field else { return false }
            switch key {
            case "alarmId":
                guard value.utf16.count == 36, UUID(uuidString: value) != nil else { return false }
            case "notificationId", "jobId":
                guard identifier(value) else { return false }
            case "date":
                guard instant(value) != nil else { return false }
            case "title":
                guard text(value, limit: 256) else { return false }
            case "body":
                guard text(value, limit: 4_096, allowEmpty: true) else { return false }
            default: return false
            }
        }
        return true
    }
}
