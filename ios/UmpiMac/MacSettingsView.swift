import AppKit
import SwiftUI

/// The Mac's settings: the phone's settings that apply to a Mac (connection, voice, T3 Code machines, pairing another
/// device), plus the shortcuts, opening at login, and notifications. Alarms, knocks, and widgets stay on the phone.
struct MacSettingsView: View {
    @Environment(MacApp.self) private var app
    @Environment(CompanionStore.self) private var store
    @Environment(DeviceCapabilities.self) private var effects
    @Environment(\.openURL) private var openURL
    @State private var confirmDisconnect = false
    @State private var disconnecting = false
    @State private var testAlert: String?

    var body: some View {
        Form {
            ConnectionStatusSection()
            if !store.queuedChanges.isEmpty {
                Section {
                    NavigationLink("Review \(store.queuedChanges.count) unsent changes") { QueuedChangesView() }
                }
            }
            Section {
                ForEach(ShortcutSettings.Action.allCases, id: \.self) { action in
                    // Centred with the taller keycap field rather than on its text baseline.
                    HStack {
                        Text(action.title)
                        Spacer()
                        ShortcutRecorder(action: action)
                    }
                    if app.refusedShortcuts.contains(action) {
                        Label("macOS did not accept this shortcut. Another app may use it; choose another.", systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            } header: { Text("Shortcuts") } footer: {
                Text("They work from any app, also over full-screen apps. Press one to open the floating chat or to start talking; press it again or Esc to hide it. Click a shortcut to change it.")
            }
            Section {
                Toggle("Open Umpi at login", isOn: Binding(get: { app.launchAtLogin }, set: { app.setLaunchAtLogin($0) }))
                if let problem = app.launchAtLoginProblem { Text(problem).font(.footnote).foregroundStyle(.secondary) }
            } header: { Text("General") } footer: {
                Text("Closing the window keeps Umpi in the menu bar, connected and listening for its shortcuts. Quit it from the menu bar item.")
            }
            Section {
                LabeledContent("Notifications") {
                    if effects.notificationsAllowed == true { Text("On").foregroundStyle(.secondary) }
                    else {
                        Button("Turn on") { Task { await effects.requestNotificationPermission() } }
                        Button("Open System Settings") {
                            if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { openURL(url) }
                        }
                    }
                }
                Button(testAlert ?? "Send a test message") {
                    Task {
                        testAlert = "Sending…"
                        let sent = (try? await store.chatTransport?.send(path: "/api/device/chat/test-alert", method: "POST", body: Data("{}".utf8))) != nil
                        testAlert = sent ? "Sent. Switch to another app to see it announced." : "Could not send. Check the connection."
                    }
                }
                .disabled(effects.notificationsAllowed != true)
                if let error = effects.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .help(effects.errorDetail ?? "")
                }
            } header: { Text("Alerts") } footer: {
                Text("While Umpi runs, a new message from it shows as a notification unless the chat is on screen. The Mac has no push; reminders knock on the phone.")
            }
            Section {
                NavigationLink { VoiceSettingsView() } label: {
                    LabeledContent("Voice", value: VoiceSettings.shared.voiceName)
                }
            } header: { Text("Voice mode") } footer: {
                Text("How Umpi sounds when you talk to it: the voice, its speed and pitch, and how long it waits before replying.")
            }
            T3MachinesSection()
            Section("Server") {
                LabeledContent("Address") { Text(store.serverURL).textSelection(.enabled) }
                Button("Sync now") { Task { await app.synchronize() } }
                    .disabled(store.isRefreshing)
                NavigationLink("Pair another device") { PairAnotherDeviceView() }
                DisclosureGroup("Details") {
                    LabeledContent("Device ID") { Text(store.deviceID).font(.caption).textSelection(.enabled) }
                    Text(effects.pushStatus).font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                Button(disconnecting ? "Disconnecting…" : "Disconnect this Mac", role: .destructive) { confirmDisconnect = true }
                    .disabled(disconnecting)
            } footer: {
                Text("Removes this Mac from Umpi and clears its local data.")
            }
        }
        .formStyle(.grouped)
        .readableWidth()
        .navigationTitle("Settings")
        .task { _ = await effects.refreshCapabilities() }
        .confirmationDialog("Disconnect this Mac?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) {
                disconnecting = true
                Task { await store.disconnect(); disconnecting = false }
            }
        } message: { Text("Unsent changes on this Mac are removed. Nothing else is deleted.") }
    }
}

/// Shows a shortcut; click it, then press the new keys. Esc cancels, Delete turns the shortcut off.
struct ShortcutRecorder: View {
    let action: ShortcutSettings.Action
    @Environment(MacApp.self) private var app
    @State private var recording = false
    @State private var monitor: Any?
    @State private var current: Shortcut?
    @State private var hint: String?
    @State private var conflict = false

    var body: some View {
        HStack(spacing: 6) {
            // Drawn as a field holding the keys, outlined in the accent colour while it records.
            Button { recording ? stop() : start() } label: {
                Group {
                    if recording { Text(hint ?? "Type the shortcut…").foregroundStyle(.secondary) }
                    else if let current { Keycaps(shortcut: current) }
                    else { Text("Off").foregroundStyle(.secondary) }
                }
                .font(.callout)
                .frame(minWidth: 132, minHeight: 28)
                .padding(.horizontal, 4)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.primary.opacity(0.04)))
                .overlay {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .strokeBorder(recording ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: recording ? 2 : 1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(recording ? "Press the new shortcut. Esc cancels; Delete turns it off." : "Click to change this shortcut")
            .accessibilityLabel(action.title)
            .accessibilityValue(recording ? "Recording" : (current?.spaced ?? "Off"))
            if !recording, current != action.fallback {
                Button("Default") { save(action.fallback) }.buttonStyle(.link)
            }
            if conflict { Text("Used by the other shortcut").font(.footnote).foregroundStyle(.secondary) }
        }
        .onAppear { current = ShortcutSettings.shortcut(for: action) }
        .onDisappear { stop() }
    }

    private func start() {
        recording = true
        hint = nil
        conflict = false
        app.recordingShortcut(true)
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            MainActor.assumeIsolated {
                switch event.keyCode {
                case 53: stop()                       // Esc: keep the shortcut as it was.
                case 51, 117: save(nil)               // Delete: off.
                default:
                    if let shortcut = Shortcut(keyCode: event.keyCode, flags: event.modifierFlags) { save(shortcut) }
                    else { hint = "Add ⌃, ⌥, or ⌘" }
                }
            }
            return nil
        }
    }

    private func save(_ shortcut: Shortcut?) {
        stop()
        // One combination for both would leave one of them unreachable.
        if let shortcut, ShortcutSettings.Action.allCases.contains(where: { $0 != action && ShortcutSettings.shortcut(for: $0) == shortcut }) {
            conflict = true
            return
        }
        app.setShortcut(shortcut, for: action)
        current = shortcut
    }

    private func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        if recording { app.recordingShortcut(false) }
        recording = false
    }
}

/// A shortcut as separate keycaps, the way Mac menus and System Settings set keys apart: "⌥" "⇧" "Space".
struct Keycaps: View {
    let shortcut: Shortcut

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(shortcut.keycaps.enumerated()), id: \.offset) { _, key in
                Text(key)
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, key.count > 1 ? 6 : 0)
                    .frame(minWidth: 22, minHeight: 20)
                    .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Color.primary.opacity(0.16)))
                    .shadow(color: .black.opacity(0.10), radius: 0, y: 1)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(shortcut.spaced)
    }
}
