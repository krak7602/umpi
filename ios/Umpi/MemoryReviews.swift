import Observation
import SwiftUI

/// A change Umpi proposes to what it remembers, as its card shows it: what changes and why first, the whole topic on
/// request. Nothing is saved until the owner approves; the coordinator holds the exact text that would be saved.
struct MemoryReview: Codable, Equatable, Identifiable, Sendable {
    struct Change: Codable, Equatable, Sendable {
        /// `remove` or `add`.
        var op: String
        var text: String
    }
    var id: String
    var kind: String
    var status: String
    var topic: String
    var source: String
    var category: String
    var reason: String
    var before: String
    var after: String
    /// Nil when the topic is too long to compare line by line.
    var changes: [Change]?
    var createdAt: String
    var decidedAt: String?
    /// The chat entry of the review's card.
    var entry: String

    var pending: Bool { status == "pending" }
    var headline: String { kind == "restore" ? "Restore “\(topic)”" : "Update “\(topic)”" }
    /// What became of a decided review, in a few words.
    var outcome: String {
        switch status {
        case "approved": "Approved · saved to memory"
        case "rejected": "Rejected · nothing changed"
        case "stale": "Out of date · memory changed first, nothing was applied"
        default: "Waiting for you"
        }
    }
}

/// The memory reviews the coordinator lists: every one that waits for the owner, then the latest decided ones. Read
/// when the app comes to the front and when the chat holds a review card, so cards change in place.
@MainActor @Observable final class MemoryReviewModel {
    static let shared = MemoryReviewModel()

    private(set) var reviews: [MemoryReview] = []
    /// The last decision could not be made; shown under the card.
    private(set) var problem: String?

    var pending: [MemoryReview] { reviews.filter(\.pending) }
    func review(_ id: String) -> MemoryReview? { reviews.first { $0.id == id } }
    /// The review whose card is this chat entry.
    func review(entry: String) -> MemoryReview? { reviews.first { $0.entry == entry } }

    private struct List: Decodable { var reviews: [MemoryReview] }

    func load(_ store: CompanionStore) async {
        guard let transport = store.chatTransport,
              let data = try? await transport.send(path: "/api/device/memory/reviews", method: "GET", body: nil),
              let list = try? JSONDecoder().decode(List.self, from: data) else { return }
        if list.reviews != reviews { reviews = list.reviews }
    }

    /// Approves or rejects through the review card's own button on the coordinator; the card then shows the outcome.
    func decide(_ store: CompanionStore, _ id: String, approve: Bool) async {
        guard let transport = store.chatTransport else { problem = "Not connected to Umpi."; return }
        do {
            _ = try await transport.send(path: "/api/device/memory/reviews/\(id)/\(approve ? "approve" : "reject")", method: "POST", body: Data("{}".utf8))
            problem = nil
        } catch {
            problem = (error as? LocalizedError)?.errorDescription ?? "The decision could not be sent. Nothing was changed."
        }
        await load(store)
    }
}

/// A memory review as a card: the topic, why, the lines removed and added, the whole topic on request, and Reject and
/// Approve. The same card is in the chat and in Work, and changes in place once decided.
struct MemoryReviewCard: View {
    let review: MemoryReview
    /// Approve (true) or reject; nil where the card cannot be answered.
    var answer: ((Bool) -> Void)?
    @State private var working = false
    @State private var showsWhole = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "brain").font(.system(size: 14, weight: .semibold)).foregroundStyle(.orange)
                    .frame(width: 30, height: 30).background(Color.orange.opacity(0.16), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(review.pending ? "MEMORY · NEEDS YOUR OK" : "MEMORY").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Text(review.headline).font(.body.weight(.semibold)).lineLimit(2)
                }
            }
            if !review.reason.isEmpty {
                (Text("Why  ").fontWeight(.semibold).foregroundStyle(.primary) + Text(review.reason)).font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            changes
            DisclosureGroup(isExpanded: $showsWhole) {
                VStack(alignment: .leading, spacing: 8) {
                    whole("Before", review.before)
                    whole("After", review.after)
                    Text("\(review.source) · \(review.category)").font(.caption2).foregroundStyle(.tertiary)
                }
                .padding(.top, 6)
            } label: {
                Text("Whole topic, before and after").font(.footnote)
            }
            .tint(.secondary)
            state
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onChange(of: review.status) { _, _ in working = false }
        .onChange(of: MemoryReviewModel.shared.problem) { _, problem in if problem != nil { working = false } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory.review.\(review.id)")
    }

    /// The removed and added lines, each on its own tinted row. Colour is doubled by the − and + marks.
    @ViewBuilder private var changes: some View {
        if let lines = review.changes {
            if lines.isEmpty {
                Text("Only spacing changes.").font(.footnote).foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(lines.prefix(MemoryReviewCard.shownChanges).enumerated()), id: \.offset) { _, line in
                        let removed = line.op == "remove"
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(removed ? "−" : "+").font(.body.monospaced().weight(.semibold)).foregroundStyle(removed ? Color.red : Color.green)
                                .accessibilityLabel(removed ? "Removed" : "Added")
                            Text(line.text).strikethrough(removed, color: .secondary).foregroundStyle(removed ? .secondary : .primary)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background((removed ? Color.red : Color.green).opacity(0.10), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    }
                    if lines.count > MemoryReviewCard.shownChanges {
                        Text("\(lines.count - MemoryReviewCard.shownChanges) more changed lines · open the whole topic").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        } else {
            Text("This topic is long. Open the whole topic to read it before and after.").font(.footnote).foregroundStyle(.secondary)
        }
    }

    /// How many changed lines the card lists before it points to the whole topic.
    static let shownChanges = 12

    private func whole(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(text.isEmpty ? "(Empty)" : text).font(.footnote).textSelection(.enabled)
                .padding(.horizontal, 10).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    @ViewBuilder private var state: some View {
        if review.pending && working {
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Saving your decision…") }.font(.subheadline).padding(.top, 2)
        } else if review.pending, let answer {
            #if os(macOS)
            HStack(spacing: 8) {
                Spacer()
                Button { working = true; answer(false) } label: { Text("Reject").frame(minWidth: 64) }
                    .buttonStyle(.bordered)
                Button { working = true; answer(true) } label: { Text("Approve").frame(minWidth: 64) }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.regular).padding(.top, 2)
            #else
            HStack(spacing: 8) {
                Button { working = true; answer(false) } label: { Text("Reject").foregroundStyle(.primary).frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).tint(Color(.systemGray))
                Button { working = true; answer(true) } label: { Text("Approve").fontWeight(.semibold).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.large).padding(.top, 2)
            #endif
            Text("Only this topic changes. Approve saves the text under After.").font(.caption2).foregroundStyle(.tertiary).frame(maxWidth: .infinity)
            if let problem = MemoryReviewModel.shared.problem { Text(problem).font(.caption).foregroundStyle(.red) }
        } else {
            HStack(spacing: 6) {
                Image(systemName: review.status == "approved" ? "checkmark.circle.fill" : review.status == "rejected" ? "xmark.circle" : "clock.badge.exclamationmark")
                    .foregroundStyle(review.status == "approved" ? Color.green : Color.secondary)
                Text(review.outcome)
            }
            .font(.subheadline).foregroundStyle(.secondary).padding(.top, 2)
        }
    }
}

/// One memory review, full screen: the same card as in the chat.
struct MemoryReviewView: View {
    @Environment(CompanionStore.self) private var store
    let id: String
    var body: some View {
        ScrollView {
            if let review = MemoryReviewModel.shared.review(id) {
                MemoryReviewCard(review: review) { approve in
                    Task { await MemoryReviewModel.shared.decide(store, id, approve: approve) }
                }
                .padding(20)
            } else {
                ProgressView().padding(.top, 80)
            }
        }
        .readableWidth()
        .navigationTitle("Memory update")
        .navigationBarTitleDisplayMode(.inline)
        .task { await MemoryReviewModel.shared.load(store) }
    }
}
