import Foundation

struct FieldDraft: Codable, Equatable {
    var value: FieldValue
    var editID: String
}
struct WorkflowDraft: Codable, Equatable {
    var baseRevision: Int
    var fields: [String: FieldDraft]
}
struct MessageRequest: Codable, Equatable {
    var id: String
    var text: String
    var sentAt: String? = nil
    /// The text is a voice note's transcript.
    var voice: Bool? = nil
    /// Images or a file stored in `AttachmentFiles` under this message's ID.
    var hasAttachment: Bool? = nil
    /// Text for Umpi only, such as a video's frames note and transcript.
    var context: String? = nil
    /// What the attachment was, for the history to show.
    var media: MediaInfo? = nil
}
struct MediaInfo: Codable, Equatable, Sendable {
    var kind: String
    var name: String? = nil
    var seconds: Int? = nil
    var count: Int? = nil
}
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
    /// The owner answered a knock: done, snooze, or later.
    case knock(id: String, version: Int, action: String)
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

extension DeviceSnapshot {
    /// The same state as `other`, whenever each was read: `serverTime` and the device's `lastSeenAt` differ on every
    /// read and nothing in the app shows them. The revision also moves for coordinator fields that are not sent to
    /// the app, so it is not part of the content.
    func hasSameContent(as other: DeviceSnapshot) -> Bool {
        var copy = self
        copy.serverTime = other.serverTime
        copy.device.lastSeenAt = other.device.lastSeenAt
        copy.revision = other.revision
        return copy == other
    }
}

/// One read of the coordinator's state: the snapshot, or word that the revision the app asked about is still current.
/// Decoding a snapshot and comparing it with the app's copy both take time for some hundred kilobytes, so `init` is
/// meant to run off the main actor.
enum StateRead: Sendable {
    case unchanged(revision: Int)
    /// `same`: the snapshot shows what the app's copy shows. `widgetStamp` changes when the widgets' content does.
    case snapshot(DeviceSnapshot, same: Bool, widgetStamp: String?)

    private struct Reply: Decodable {
        struct Extra: Decodable { var widget: String? }
        enum Keys: String, CodingKey { case unchanged, revision, extra }
        var unchanged: Int?
        var snapshot: DeviceSnapshot?
        var widgetStamp: String?

        init(from decoder: Decoder) throws {
            let keyed = try decoder.container(keyedBy: Keys.self)
            if try keyed.decodeIfPresent(Bool.self, forKey: .unchanged) == true {
                unchanged = try keyed.decode(Int.self, forKey: .revision)
                return
            }
            // The same decoder: the reply is parsed once.
            snapshot = try DeviceSnapshot(from: decoder)
            widgetStamp = try? keyed.decodeIfPresent(Extra.self, forKey: .extra)?.widget
        }
    }

    init(data: Data, held: DeviceSnapshot?) throws {
        let reply = try JSONDecoder().decode(Reply.self, from: data)
        if let revision = reply.unchanged { self = .unchanged(revision: revision); return }
        guard let snapshot = reply.snapshot else { throw CompanionClientError.invalidResponse }
        self = .snapshot(snapshot, same: held?.hasSameContent(as: snapshot) == true, widgetStamp: reply.widgetStamp)
    }
}
