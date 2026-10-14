import SwiftUI

struct QueuedChangesView: View {
    @Environment(CompanionStore.self) private var store
    @State private var discardID: String?

    var body: some View {
        List {
            ConnectionStatusSection()
            if store.queuedChanges.isEmpty {
                ContentUnavailableView("No queued changes", systemImage: "checkmark.circle", description: Text("There are no pending local requests in the durable queue."))
            }
            ForEach(store.queuedChanges) { change in
                Section(change.kind) {
                    LabeledContent("Target") { Text(change.target).textSelection(.enabled) }
                    LabeledContent("Status", value: change.status)
                    if let error = change.error { Label(error, systemImage: "exclamationmark.triangle") }
                    if change.kind.hasPrefix("job") && (change.status == "failed" || change.status == "conflict") {
                        Text("Return to Activity and review the latest exact command before making another decision. A stale approval cannot be retried here.")
                    } else if change.status == "conflict" {
                        NavigationLink("Review workflow conflicts") { ConflictListView() }
                    } else if change.status == "failed" {
                        Button("Retry this change") { Task { await store.retryQueuedChange(id: change.id) } }
                            .accessibilityIdentifier("queue.retry.\(change.id)")
                    }
                    Button("Discard queued request", role: .destructive) { discardID = change.id }
                        .accessibilityIdentifier("queue.discard.\(change.id)")
                }
            }
            Section {
                Text("Queued is not completed. Discarding a local request does not undo a change that may already have reached the coordinator or reverse a device effect.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Queued changes")
        .refreshable { await store.synchronize() }
        .confirmationDialog("Discard this queued request?", isPresented: Binding(get: { discardID != nil }, set: { if !$0 { discardID = nil } }), titleVisibility: .visible) {
            Button("Discard queued request", role: .destructive) {
                if let id = discardID { store.discardQueuedChange(id: id) }
                discardID = nil
            }
        } message: {
            Text("This removes the local pending request. It does not undo completed effects. Separate local form drafts remain available for review.")
        }
    }
}
