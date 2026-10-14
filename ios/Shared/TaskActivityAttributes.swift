import ActivityKit
import Foundation

/// Keep ContentState in sync with companion-push.ts. Never put command text in a Live Activity.
struct TaskActivityAttributes: ActivityAttributes, Sendable {
    struct ContentState: Codable, Hashable, Sendable {
        var title: String
        var status: String

        var isTerminal: Bool {
            ["succeeded", "failed", "cancelled", "uncertain"].contains(status)
        }

        var statusLabel: String {
            switch status {
            case "pending_approval": "Needs approval"
            case "queued": "Queued"
            case "running": "Running"
            case "succeeded": "Succeeded"
            case "failed": "Failed"
            case "cancelled": "Cancelled"
            case "uncertain": "Outcome uncertain"
            default: "Unknown status"
            }
        }

        var symbol: String {
            switch status {
            case "pending_approval": "hand.raised"
            case "queued": "clock"
            case "running": "gearshape.2"
            case "succeeded": "checkmark.circle"
            case "failed": "exclamationmark.circle"
            case "cancelled": "xmark.circle"
            default: "questionmark.circle"
            }
        }
    }

    var jobId: String
}
