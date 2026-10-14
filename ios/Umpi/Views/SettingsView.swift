import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(DeviceCapabilities.self) private var effects
    @Environment(\.openURL) private var openURL
    @State private var confirmDisconnect = false
    @State private var confirmRemoteEffects = false
    @State private var disconnecting = false

    var body: some View {
        Form {
            ConnectionStatusSection()
            if !store.queuedChanges.isEmpty {
                Section {
                    NavigationLink("Review \(store.queuedChanges.count) queued changes") { QueuedChangesView() }
                        .accessibilityIdentifier("settings.queue")
                }
            }
            Section("Paired coordinator") {
                LabeledContent("Server") { Text(store.serverURL).textSelection(.enabled) }
                LabeledContent("Device ID") { Text(store.deviceID).font(.caption).textSelection(.enabled) }
                Button("Synchronize now") {
                    Task {
                        _ = await effects.refreshCapabilities()
                        await store.synchronize()
                    }
                }
                .disabled(store.isRefreshing)
                .accessibilityIdentifier("settings.synchronize")
            }
            Section {
                Text(effects.permissionSummary)
                Text(effects.pushStatus).font(.footnote).foregroundStyle(.secondary)
                Text(effects.backgroundStatus).font(.footnote).foregroundStyle(.secondary)
                Button("Request alarm permission") { Task { await effects.requestAlarmPermission() } }
                    .accessibilityIdentifier("settings.alarmPermission")
                Button("Request notification permission") { Task { await effects.requestNotificationPermission() } }
                    .accessibilityIdentifier("settings.notificationPermission")
                Button("Open system settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
                if let error = effects.errorMessage { Label(error, systemImage: "exclamationmark.triangle") }
            } header: { Text("System permissions") } footer: {
                Text("Alarms require iOS 26 or later and AlarmKit authorization. Notifications and Live Activities also depend on system settings. Granting permission does not by itself allow remote effects.")
            }
            Section {
                Toggle("Allow remote device effects", isOn: Binding(get: { store.remoteEffectsAllowed }, set: { allowed in
                    if allowed { confirmRemoteEffects = true } else { store.remoteEffectsAllowed = false }
                }))
                .accessibilityIdentifier("settings.remoteEffects")
                if !effects.pendingReview.isEmpty {
                    ForEach(effects.pendingReview) { action in
                        NavigationLink("Review \(action.capability)") { DeviceActionReviewView(action: action) }
                    }
                }
            } header: { Text("Your device consent") } footer: {
                Text("When off, remote actions require individual review. When on, your paired coordinator may request supported alarms, notifications, and Live Activities without a separate review for each action. System permissions still apply. Disabling consent does not cancel existing alarms or notifications.")
            }
            Section("Reported capabilities") {
                if store.capabilities.isEmpty { Text("Capabilities have not been registered yet.").foregroundStyle(.secondary) }
                ForEach(store.capabilities) { capability in
                    VStack(alignment: .leading) {
                        Text(capability.id)
                        Text(capability.status.replacingOccurrences(of: "_", with: " ")).font(.subheadline).foregroundStyle(.secondary)
                        if let reason = capability.reason { Text(reason).font(.footnote).foregroundStyle(.secondary) }
                    }
                }
            }
            Section {
                Button(disconnecting ? "Disconnecting…" : "Disconnect this device", role: .destructive) { confirmDisconnect = true }
                    .disabled(disconnecting)
                    .accessibilityIdentifier("settings.disconnect")
            } footer: {
                Text("Disconnect attempts to revoke this device at the coordinator, then removes its local session and cached data. If offline, also revoke this device with the coordinator's owner controls. Existing scheduled OS effects may remain.")
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Allow remote device effects?", isPresented: $confirmRemoteEffects, titleVisibility: .visible) {
            Button("Allow remote device effects") {
                store.remoteEffectsAllowed = true
                Task { await store.synchronize() }
            }
        } message: { Text("Your paired coordinator can request supported effects on this phone when system permission allows. This is separate from command approval, which always requires exact-command review.") }
        .confirmationDialog("Disconnect this device?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect and clear local data", role: .destructive) {
                disconnecting = true
                Task { await store.disconnect(); disconnecting = false }
            }
        } message: { Text("Unsynchronized edits on this device will be removed. Other devices and coordinator workflows are not deleted.") }
    }
}
