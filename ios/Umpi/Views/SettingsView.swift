import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
import WidgetKit

struct SettingsView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(DeviceCapabilities.self) private var effects
    @Environment(\.openURL) private var openURL
    @State private var confirmDisconnect = false
    @State private var confirmRemoteEffects = false
    @State private var disconnecting = false

    @State private var notify: String?
    @State private var testAlert: String?
    @State private var widgetActions: [String] = WidgetAction.defaults
    @State private var notifyVersion = 1

    private func status(_ id: String) -> String? { effects.descriptors.first { $0.id == id }?.status }
    private var notificationsAllowed: Bool { status("notification.schedule") == "available" }

    var body: some View {
        Form {
            ConnectionStatusSection()
            if !store.queuedChanges.isEmpty {
                Section {
                    NavigationLink("Review \(store.queuedChanges.count) unsent changes") { QueuedChangesView() }
                        .accessibilityIdentifier("settings.queue")
                }
            }
            Section {
                LabeledContent("Notifications") {
                    if notificationsAllowed { Text("On").foregroundStyle(.secondary) }
                    else { Button("Turn on") { Task { await effects.requestNotificationPermission(); _ = await effects.refreshCapabilities() } } }
                }
                .accessibilityIdentifier("settings.notificationPermission")
                LabeledContent("Reminder knocks") {
                    Text(notificationsAllowed ? "On this phone" : "Needs notifications").foregroundStyle(.secondary)
                }
                Button(testAlert ?? "Send a test alert") {
                    Task {
                        testAlert = "Sending…"
                        let sent = (try? await store.chatTransport?.send(path: "/api/device/chat/test-alert", method: "POST", body: Data("{}".utf8))) != nil
                        testAlert = sent ? "Sent. Lock the phone to see it arrive." : "Could not send. Check the connection."
                    }
                }
                .disabled(!notificationsAllowed)
                if let notify {
                    Picker("Umpi's messages alert on", selection: Binding(get: { notify }, set: { value in Task { await setNotify(value) } })) {
                        Text("Telegram").tag("telegram")
                        Text("This app").tag("app")
                    }
                }
                LabeledContent("Wake-up alarms") {
                    if status("alarm.schedule") == "available" { Text("On").foregroundStyle(.secondary) }
                    else if status("alarm.schedule") == "unsupported" { Text("Needs iOS 26").foregroundStyle(.secondary) }
                    else { Button("Turn on") { Task { await effects.requestAlarmPermission(); _ = await effects.refreshCapabilities() } } }
                }
                .accessibilityIdentifier("settings.alarmPermission")
                if let error = effects.errorMessage { Label(error, systemImage: "exclamationmark.triangle") }
            } header: { Text("Alerts") } footer: {
                Text("Reminders knock on this phone, even offline. Switch Umpi's messages to this app once a test alert has arrived; Telegram then stays as a silent record.")
            }
            Section {
                ForEach(0..<4, id: \.self) { slot in
                    Picker(slot == 0 ? "First button" : "Button \(slot + 1)", selection: Binding(
                        get: { widgetActions.indices.contains(slot) ? widgetActions[slot] : "" },
                        set: { value in Task { await setWidgetButton(slot, value) } })) {
                        if slot > 0 { Text("None").tag("") }
                        ForEach(WidgetAction.all) { action in Label(action.label, systemImage: action.symbol).tag(action.id) }
                    }
                }
            } header: { Text("Widget") } footer: {
                Text("The small widget shows the first button; medium and large show all of them. Umpi can change these too when you ask.")
            }
            Section {
                NavigationLink { VoiceSettingsView() } label: {
                    LabeledContent("Voice", value: VoiceSettings.shared.summary)
                }
            } header: { Text("Voice mode") } footer: {
                Text("How Umpi sounds when you talk to it: the voice, its speed and pitch, and how long it waits before replying.")
            }
            T3MachinesSection()
            Section {
                Toggle("Let Umpi act on this phone", isOn: Binding(get: { store.remoteEffectsAllowed }, set: { allowed in
                    if allowed { confirmRemoteEffects = true } else { store.remoteEffectsAllowed = false }
                }))
                .accessibilityIdentifier("settings.remoteEffects")
                ForEach(effects.pendingReview) { action in
                    NavigationLink("Review \(action.capability)") { DeviceActionReviewView(action: action) }
                }
            } header: { Text("Permissions") } footer: {
                Text("When on, Umpi can set alarms and notifications without asking each time. Commands on your Mac always need your review.")
            }
            Section("Server") {
                LabeledContent("Address") { Text(store.serverURL).textSelection(.enabled) }
                Button("Sync now") {
                    Task {
                        _ = await effects.refreshCapabilities()
                        await store.synchronize()
                    }
                }
                .disabled(store.isRefreshing)
                .accessibilityIdentifier("settings.synchronize")
                NavigationLink("Pair another device") { PairAnotherDeviceView() }
                DisclosureGroup("Details") {
                    LabeledContent("Device ID") { Text(store.deviceID).font(.caption).textSelection(.enabled) }
                    Text(effects.pushStatus).font(.footnote).foregroundStyle(.secondary)
                    Text(effects.backgroundStatus).font(.footnote).foregroundStyle(.secondary)
                    ForEach(store.capabilities) { capability in
                        LabeledContent(capability.id) { Text(capability.status.replacingOccurrences(of: "_", with: " ")).font(.footnote) }
                    }
                    #if os(iOS)
                    Button("Open iOS Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }
                    #endif
                }
            }
            Section {
                Button(disconnecting ? "Disconnecting…" : "Disconnect this phone", role: .destructive) { confirmDisconnect = true }
                    .disabled(disconnecting)
                    .accessibilityIdentifier("settings.disconnect")
            } footer: {
                Text("Removes this phone from Umpi and clears its local data. Alarms and notifications already set may remain.")
            }
        }
        .task { await loadNotify(); await loadWidget() }
        .softScrollEdges()
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Let Umpi act on this phone?", isPresented: $confirmRemoteEffects, titleVisibility: .visible) {
            Button("Allow") {
                store.remoteEffectsAllowed = true
                Task { await store.synchronize() }
            }
        } message: { Text("Umpi can set alarms and notifications here when iOS allows it. Commands on your Mac still need your review each time.") }
        .confirmationDialog("Disconnect this phone?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) {
                disconnecting = true
                Task { await store.disconnect(); disconnecting = false }
            }
        } message: { Text("Unsent changes on this phone are removed. Nothing else is deleted.") }
    }

    private func loadWidget() async {
        guard let transport = store.chatTransport, let data = try? await transport.send(path: "/api/device/widget", method: "GET", body: nil),
              let content = try? JSONDecoder().decode(WidgetContent.self, from: data) else { return }
        widgetActions = content.actions ?? WidgetAction.defaults
    }
    /// Changes one button; an emptied slot closes the gap. The widget refreshes right away.
    private func setWidgetButton(_ slot: Int, _ value: String) async {
        var next = widgetActions
        if value.isEmpty { if next.indices.contains(slot) { next.remove(at: slot) } }
        else if next.indices.contains(slot) { next[slot] = value } else { next.append(value) }
        var seen = Set<String>(); next = next.filter { seen.insert($0).inserted }
        guard !next.isEmpty, let transport = store.chatTransport else { return }
        struct Change: Encodable { var actions: [String] }
        guard (try? await transport.send(path: "/api/device/widget/actions", method: "PUT", body: JSONEncoder().encode(Change(actions: next)))) != nil else { await loadWidget(); return }
        widgetActions = next
        if let data = try? await transport.send(path: "/api/device/widget", method: "GET", body: nil), let content = try? JSONDecoder().decode(WidgetContent.self, from: data) {
            content.save(); WidgetCenter.shared.reloadAllTimelines()
        }
    }

    private struct ChatSettings: Codable { var notify: String; var version: Int }
    private func loadNotify() async {
        guard let transport = store.chatTransport, let data = try? await transport.send(path: "/api/device/chat/settings", method: "GET", body: nil),
              let settings = try? JSONDecoder().decode(ChatSettings.self, from: data) else { return }
        notify = settings.notify; notifyVersion = settings.version
    }
    private func setNotify(_ value: String) async {
        struct Change: Encodable { var expectedVersion: Int; var notify: String }
        guard let transport = store.chatTransport, let body = try? JSONEncoder().encode(Change(expectedVersion: notifyVersion, notify: value)) else { return }
        if let data = try? await transport.send(path: "/api/device/chat/settings", method: "PUT", body: body),
           let settings = try? JSONDecoder().decode(ChatSettings.self, from: data) {
            notify = settings.notify; notifyVersion = settings.version
        } else { await loadNotify() }
    }
}

/// A one-use code for pairing another device, such as the Mac app, with this phone's server: no Telegram needed.
struct PairAnotherDeviceView: View {
    @Environment(CompanionStore.self) private var store
    @State private var code: String?
    @State private var expires: Date?
    @State private var error: String?
    @State private var copied: String?

    var body: some View {
        Form {
            Section {
                LabeledContent("Server") { Text(store.serverURL).textSelection(.enabled) }
                Button { copy(store.serverURL, "Server") } label: { Label(copied == "Server" ? "Copied" : "Copy server", systemImage: "doc.on.doc") }
                if let code {
                    LabeledContent("Code") { Text(code).font(.footnote.monospaced()).textSelection(.enabled).lineLimit(2) }
                    Button { copy(code, "Code") } label: { Label(copied == "Code" ? "Copied" : "Copy code", systemImage: "doc.on.doc") }
                    if let expires { Text("Works once, until \(expires.formatted(date: .omitted, time: .shortened)).").font(.footnote).foregroundStyle(.secondary) }
                } else if let error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            } footer: {
                Text("On the other device, open Umpi and enter this server and code. Copied text can be pasted on a Mac signed in to the same Apple Account.")
            }
            Section { Button("New code") { Task { await create() } } }
        }
        .readableWidth()
        .navigationTitle("Pair another device")
        .navigationBarTitleDisplayMode(.inline)
        .task { await create() }
    }

    private func copy(_ text: String, _ what: String) {
        Clipboard.copy(text)
        copied = what
    }

    private func create() async {
        code = nil; error = nil
        struct Pairing: Decodable { var code: String; var expiresAt: String }
        do {
            guard let transport = store.chatTransport else { error = "This phone is not paired."; return }
            let data = try await transport.send(path: "/api/device/pairings", method: "POST", body: Data("{}".utf8))
            let pairing = try JSONDecoder().decode(Pairing.self, from: data)
            code = pairing.code
            expires = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(pairing.expiresAt)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "A code could not be made."
        }
    }
}
