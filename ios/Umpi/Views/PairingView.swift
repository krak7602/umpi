import SwiftUI

struct PairingView: View {
    @Environment(CompanionStore.self) private var store
    @Binding var server: String
    @Binding var code: String
    @State private var isPairing = false
    @State private var confirmingAbandon = false

    var body: some View {
        Form {
            Section {
                Text("Connect this device to your Umpi coordinator. Create a one-use pairing code with your coordinator's owner controls.")
                TextField("Server URL", text: $server)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("pairing.server")
                SecureField("Pairing code", text: $code)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("pairing.code")
            } header: {
                Text("Your coordinator")
            } footer: {
                Text("Use an HTTPS server you trust. The code grants this device access to workflows and command approval. Pairing links only fill this form; they never connect automatically.")
            }
            .disabled(isPairing || store.hasPendingPairing)
            if let error = store.errorMessage {
                Section { Label(error, systemImage: "exclamationmark.triangle").accessibilityIdentifier("pairing.error") }
            }
            Section {
                Button {
                    isPairing = true
                    Task {
                        await store.pair(server: server.trimmingCharacters(in: .whitespacesAndNewlines), code: code.trimmingCharacters(in: .whitespacesAndNewlines))
                        isPairing = false
                        if store.isPaired { code = "" }
                    }
                } label: {
                    if isPairing { ProgressView("Connecting…") } else { Text("Pair this device") }
                }
                .disabled(isPairing || store.hasPendingPairing || server.isEmpty || code.isEmpty)
                .accessibilityIdentifier("pairing.connect")
                if store.hasPendingPairing {
                    Button("Recover pending pairing") {
                        isPairing = true
                        Task {
                            await store.recoverPendingPairing()
                            isPairing = false
                            if store.isPaired { code = "" }
                        }
                    }
                    .disabled(isPairing)
                    Button("Abandon pending pairing", role: .destructive) { confirmingAbandon = true }
                        .disabled(isPairing)
                        .accessibilityIdentifier("pairing.abandon")
                    Text("A previous claim may have reached the coordinator. Recovery uses the same securely stored device credential.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Pair Umpi")
        .confirmationDialog("Abandon this pending pairing?", isPresented: $confirmingAbandon, titleVisibility: .visible) {
            Button("Abandon pending pairing", role: .destructive) {
                isPairing = true
                Task {
                    await store.disconnect()
                    code = ""
                    isPairing = false
                }
            }
            Button("Keep for recovery", role: .cancel) {}
        } message: {
            Text("This removes the saved claim from this device so you can use another code. The coordinator may already have accepted it. Revocation will be attempted, but if it cannot be confirmed, revoke the old device through your trusted owner controls.")
        }
    }
}

struct ConnectionStatusSection: View {
    @Environment(CompanionStore.self) private var store

    var body: some View {
        Section("Connection") {
            if store.isRefreshing { ProgressView("Synchronizing…") }
            Text(store.statusMessage).accessibilityIdentifier("connection.status")
            if let date = store.lastSyncedAt {
                LabeledContent("Last synchronized") { Text(date, style: .relative) }
            } else {
                Text("No synchronized snapshot yet.").foregroundStyle(.secondary)
            }
            if store.queuedCount > 0 {
                Text("\(store.queuedCount) pending changes. Local edits remain on this device until synchronized.")
            }
            if let error = store.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle")
                    .accessibilityIdentifier("connection.error")
                Button("Dismiss error") { store.clearError() }
            }
        }
    }
}

struct AskUmpiView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What would you like Umpi to do?", text: $text, axis: .vertical)
                        .lineLimit(5...12)
                        .accessibilityIdentifier("ask.message")
                        .disabled(sending)
                } footer: {
                    Text("Your request is sent to the coordinator. Commands still require a separate exact-command review. View request progress in Activity.")
                }
                if let error = store.errorMessage { Section { Text(error) } }
            }
            .navigationTitle("Ask Umpi")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(sending) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        sending = true
                        Task {
                            store.clearError()
                            let accepted = await store.requestAgent(text: text.trimmingCharacters(in: .whitespacesAndNewlines))
                            sending = false
                            if accepted { dismiss() }
                        }
                    }
                    .disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("ask.send")
                }
            }
            .interactiveDismissDisabled(sending)
        }
    }
}
