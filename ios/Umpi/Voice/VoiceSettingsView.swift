import AVFoundation
import SwiftUI

/// Umpi's voice: which installed voice, how fast, how high, and how voice mode takes turns.
struct VoiceSettingsView: View {
    @State private var settings = VoiceSettings.shared
    @State private var sample = AVSpeechSynthesizer()
    @State private var voices = VoiceCatalog.voices()
    @State private var personal = AVSpeechSynthesizer.personalVoiceAuthorizationStatus
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text("Speed"); Spacer(); Text(settings.speedLabel).foregroundStyle(.secondary) }
                    Slider(value: $settings.rate, in: VoiceSettings.normalRate * 0.85...VoiceSettings.normalRate * 1.4) { Text("Speed") }
                        minimumValueLabel: { Image(systemName: "tortoise") } maximumValueLabel: { Image(systemName: "hare") }
                        onEditingChanged: { editing in if !editing { play() } }
                }
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text("Pitch"); Spacer(); Text(settings.pitch < 0.97 ? "Lower" : settings.pitch > 1.03 ? "Higher" : "Normal").foregroundStyle(.secondary) }
                    Slider(value: $settings.pitch, in: 0.8...1.3) { Text("Pitch") }
                        onEditingChanged: { editing in if !editing { play() } }
                }
                Button { play() } label: { Label("Play a sample", systemImage: "play.circle") }
            }

            Section {
                Button { settings.voiceIdentifier = nil; play() } label: { row(name: "Automatic", detail: "The best voice for your language", selected: settings.voiceIdentifier == nil) }
                    .tint(.primary)
                ForEach(voices, id: \.identifier) { voice in
                    Button { settings.voiceIdentifier = voice.identifier; play() } label: {
                        row(name: voice.name, detail: "\(VoiceCatalog.accent(voice)) · \(VoiceCatalog.quality(voice))", selected: settings.voiceIdentifier == voice.identifier)
                    }
                    .tint(.primary)
                }
            } header: { Text("Voice") } footer: {
                Text("More natural Enhanced and Premium voices are a free download in Settings › Accessibility › Spoken Content › Voices. They appear here once installed.")
            }

            Section {
                if personal == .authorized {
                    Label("Your Personal Voice is listed above when it is set up", systemImage: "checkmark.circle")
                } else {
                    Button("Use my Personal Voice") {
                        AVSpeechSynthesizer.requestPersonalVoiceAuthorization { status in
                            Task { @MainActor in personal = status; voices = VoiceCatalog.voices() }
                        }
                    }
                }
            } footer: { Text("Set up a Personal Voice in Settings › Accessibility › Personal Voice, then allow Umpi to use it.") }

            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text("Wait before replying"); Spacer(); Text(String(format: "%.1f s", settings.pause)).monospacedDigit().foregroundStyle(.secondary) }
                    Slider(value: $settings.pause, in: 0.4...1.6, step: 0.1) { Text("Wait before replying") }
                }
                Toggle("Cut in by talking", isOn: $settings.cutIn)
            } header: { Text("Conversation") } footer: {
                Text("How long you can pause before Umpi takes your turn as finished. With cutting in on, talking over Umpi stops it.")
            }
        }
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .onDisappear {
            sample.stopSpeaking(at: .immediate)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func row(name: String, detail: String, selected: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(name).foregroundStyle(.primary)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if selected { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
        }
        .contentShape(Rectangle())
    }

    private func play() {
        sample.stopSpeaking(at: .immediate)
        // Plain spoken audio, as Siri plays it: no microphone, no echo cancellation.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        let utterance = AVSpeechUtterance(string: "Hi, I'm Umpi. This is how I'll sound when we talk.")
        utterance.voice = settings.voice
        utterance.rate = Float(settings.rate)
        utterance.pitchMultiplier = Float(settings.pitch)
        sample.speak(utterance)
    }
}
