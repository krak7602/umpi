import AVFoundation
import SwiftUI

/// Umpi's voice: which installed voice, how fast, how high, and how voice mode takes turns.
struct VoiceSettingsView: View {
    @State private var settings = VoiceSettings.shared
    @State private var sample = AVSpeechSynthesizer()
    @State private var voices = VoiceCatalog.voices()
    @State private var personal = AVSpeechSynthesizer.personalVoiceAuthorizationStatus
    /// The models' downloads and preparation, as they report them.
    private let status = VoiceModelStatus.shared
    private var kokoro: KokoroVoice.State { status.kokoro }
    private var phonon: PhononTranscriber.State { status.phonon }
    @State private var natural = PCMPlayer()
    @Environment(\.dismiss) private var dismiss
    /// Shown as a sheet over voice mode, with a Done button; pushed from Settings, without one.
    var inSheet = false

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text("Speed"); Spacer(); Text(settings.speedLabel).foregroundStyle(.secondary) }
                    Slider(value: $settings.rate, in: VoiceSettings.normalRate * 0.85...VoiceSettings.normalRate * 1.4) { Text("Speed") }
                        minimumValueLabel: { Image(systemName: "tortoise") } maximumValueLabel: { Image(systemName: "hare") }
                        onEditingChanged: { editing in if !editing { play() } }
                }
                // The natural voice has no pitch control; its speed follows the slider above.
                if settings.kokoroVoice == nil {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack { Text("Pitch"); Spacer(); Text(settings.pitch < 0.97 ? "Lower" : settings.pitch > 1.03 ? "Higher" : "Normal").foregroundStyle(.secondary) }
                        // Steps, so Normal is exactly 1: any other pitch makes iOS reprocess the voice, which can warble.
                        Slider(value: $settings.pitch, in: 0.8...1.3, step: 0.05) { Text("Pitch") }
                            onEditingChanged: { editing in if !editing { play() } }
                    }
                } else {
                    LabeledContent("Pitch") { Text("Set by the voice").foregroundStyle(.secondary) }
                }
                Button { play() } label: { Label("Play a sample", systemImage: "play.circle") }
            }

            Section {
                ForEach(KokoroVoice.voices, id: \.id) { voice in
                    Button { chooseNatural(voice.id) } label: {
                        row(name: voice.name, detail: naturalDetail(voice.detail), selected: settings.kokoroVoice == voice.id, progress: Self.progress(kokoro))
                    }
                    .tint(.primary)
                    .shapedButton()
                    .allowsHitTesting(!Self.busy(kokoro))
                }
                if KokoroVoice.downloaded {
                    Button("Remove the natural voice from this \(ThisDevice.noun)", role: .destructive) {
                        Task { await KokoroVoice.shared.remove(); if settings.kokoroVoice != nil { settings.voiceIdentifier = nil } }
                    }
                }
            } header: { Text("Natural voice") } footer: {
                Text("Made on this \(ThisDevice.noun) by Kokoro, an open voice model; nothing is sent anywhere. The first use downloads its files once.")
            }

            Section {
                Button { settings.voiceIdentifier = nil; play() } label: { row(name: "Automatic", detail: "The best voice for your language", selected: settings.voiceIdentifier == nil) }
                    .tint(.primary)
                    .shapedButton()
                ForEach(voices, id: \.identifier) { voice in
                    Button { settings.voiceIdentifier = voice.identifier; play() } label: {
                        row(name: voice.name, detail: "\(VoiceCatalog.accent(voice)) · \(VoiceCatalog.quality(voice))", selected: settings.voiceIdentifier == voice.identifier)
                    }
                    .tint(.primary)
                    .shapedButton()
                }
            } header: { Text("Voice") } footer: {
                Text("Basic voices, including the Siri voices apps are given, are small copies that can sound mechanical. Premium and Enhanced voices sound far more natural: download them free in \(Self.voicesPath), and they appear here.")
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
            } footer: { Text("Set up a Personal Voice in \(Self.settingsApp) › Accessibility › Personal Voice, then allow Umpi to use it.") }

            Section {
                Button { settings.usesPhonon = false } label: {
                    row(name: "Apple", detail: "Built in", selected: !settings.usesPhonon)
                }
                .tint(.primary)
                .shapedButton()
                Button { choosePhonon() } label: {
                    row(name: "Phonon-2", detail: phononDetail, selected: settings.usesPhonon, progress: Self.progress(phonon))
                }
                .tint(.primary)
                .shapedButton()
                .allowsHitTesting(!Self.busy(phonon))
                if PhononTranscriber.downloaded {
                    Button("Remove Phonon-2 from this \(ThisDevice.noun)", role: .destructive) {
                        Task { await PhononTranscriber.shared.remove(); settings.usesPhonon = false }
                    }
                }
            } header: { Text("Recognition") } footer: {
                Text("Phonon-2 is an open speech model that writes out what you said far more accurately, on this \(ThisDevice.noun); nothing is sent anywhere. English only. Its files download once, and the first start prepares it for a few minutes; until then, Apple's recognizer is used.")
            }

            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text("Wait before replying"); Spacer(); Text(String(format: "%.1f s", settings.pause)).monospacedDigit().foregroundStyle(.secondary) }
                    Slider(value: $settings.pause, in: 0.6...2.5, step: 0.1) { Text("Wait before replying") }
                }
                Toggle("Cut in by talking", isOn: $settings.cutIn)
            } header: { Text("Conversation") } footer: {
                Text("How long you can pause before Umpi takes your turn as finished. When your words trail off (\u{201C}and…\u{201D}, \u{201C}so…\u{201D}), it waits longer, at least 2.5 s. With cutting in on, talking over Umpi stops it.")
            }
        }
        #if os(macOS)
        .formStyle(.grouped)
        #endif
        .readableWidth()
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if inSheet { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } } }
        // A voice downloaded in Settings appears without reopening this screen.
        .onReceive(NotificationCenter.default.publisher(for: AVSpeechSynthesizer.availableVoicesDidChangeNotification)) { _ in voices = VoiceCatalog.voices() }
        .onAppear { voices = VoiceCatalog.voices() }
        .onDisappear {
            sample.stopSpeaking(at: .immediate)
            natural.stop()
            #if os(iOS)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            #endif
        }
    }

    #if os(macOS)
    static let settingsApp = "System Settings", voicesPath = "System Settings › Accessibility › Spoken Content › System voice › Manage Voices"
    #else
    static let settingsApp = "Settings", voicesPath = "Settings › Accessibility › Spoken Content › Voices"
    #endif
    static let sampleText = "Hi, I'm Umpi. This is how I'll sound when we talk."

    /// A choice; while its model downloads, a ring fills in place of the checkmark (`progress` nil is not loading, a
    /// fraction is downloading, and 1.5 is preparing the files already on the device).
    private func row(name: String, detail: String, selected: Bool, progress: Double? = nil) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(name).foregroundStyle(.primary)
                Text(detail).font(.caption).foregroundStyle(.secondary).monospacedDigit().contentTransition(.numericText())
            }
            Spacer()
            if let progress { DownloadRing(fraction: progress > 1 ? nil : progress) }
            else if selected { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
        }
        .contentShape(Rectangle())
    }

    private static func progress(_ state: KokoroVoice.State) -> Double? { VoiceModelStatus.fraction(state) }
    private static func progress(_ state: PhononTranscriber.State) -> Double? { VoiceModelStatus.fraction(state) }
    private static func busy(_ state: KokoroVoice.State) -> Bool { progress(state) != nil }
    private static func busy(_ state: PhononTranscriber.State) -> Bool { progress(state) != nil }
    private static func percent(_ fraction: Double) -> String { "\(Int((fraction * 100).rounded(.down)))%" }

    private func naturalDetail(_ detail: String) -> String {
        switch kokoro {
        case .downloading(let fraction): return "Downloading… \(Self.percent(fraction))"
        case .preparing: return "Getting ready…"
        case .failed(let message): return "Could not load: \(message)"
        default: return KokoroVoice.downloaded ? detail : "\(detail) · tap to download"
        }
    }

    private var phononDetail: String {
        switch phonon {
        case .downloading(let fraction): return "Downloading… \(Self.percent(fraction)) of about 360 MB"
        case .preparing: return "Preparing… a few minutes the first time"
        case .failed(let message): return "Could not load: \(message)"
        default: return PhononTranscriber.downloaded ? "More accurate · English" : "More accurate · English · tap to download (about 360 MB)"
        }
    }

    /// Uses Phonon-2: downloads and prepares it the first time.
    private func choosePhonon() {
        settings.usesPhonon = true
        Task { try? await PhononTranscriber.shared.prepare() }
    }

    /// Picks a natural voice: downloads it the first time, then plays the sample with it.
    private func chooseNatural(_ id: String) {
        settings.voiceIdentifier = KokoroVoice.prefix + id
        Task {
            try? await KokoroVoice.shared.prepare()
            if await KokoroVoice.shared.state == .ready { play() }
        }
    }

    private func play() {
        sample.stopSpeaking(at: .immediate)
        natural.stop()
        if let id = settings.kokoroVoice {
            let speed = settings.kokoroSpeed
            Task {
                guard let samples = try? await KokoroVoice.shared.speak(Self.sampleText, voice: id, speed: speed) else { return }
                natural.play(samples)
            }
            return
        }
        // Plain spoken audio, as Siri plays it: no microphone, no echo cancellation.
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        #endif
        let utterance = AVSpeechUtterance(string: Self.sampleText)
        utterance.voice = settings.voice
        utterance.rate = Float(settings.rate)
        utterance.pitchMultiplier = VoiceSettings.cleanPitch(settings.pitch)
        sample.speak(utterance)
    }
}

/// Plays 24 kHz mono speech as plain spoken audio.
@MainActor
final class PCMPlayer {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

    func play(_ samples: [Float]) {
        stop()
        guard !samples.isEmpty, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        #endif
        if player.engine == nil { engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format) }
        do { if !engine.isRunning { try engine.start() } } catch { return }
        player.scheduleBuffer(buffer)
        player.play()
    }

    func stop() { player.stop() }
}

/// A download's progress: a blue ring whose inside fills clockwise as a pie, up to the ring. Without a fraction
/// (preparing files already downloaded), the full pie breathes.
struct DownloadRing: View {
    var fraction: Double?
    @State private var breathing = false

    var body: some View {
        ZStack {
            // A solid ring, and the pie filling right up to it.
            Pie(fraction: fraction ?? 1).fill(Color.accentColor)
                .opacity(fraction == nil && breathing ? 0.35 : 1)
            Circle().strokeBorder(Color.accentColor, lineWidth: 1.5)
        }
        .frame(width: 20, height: 20)
        .animation(.linear(duration: 0.25), value: fraction)
        .animation(fraction == nil ? .easeInOut(duration: 0.9).repeatForever() : .default, value: breathing)
        .onAppear { breathing = true }
        .accessibilityElement()
        .accessibilityLabel(fraction.map { "Downloading, \(Int($0 * 100)) percent" } ?? "Preparing")
    }

    private struct Pie: Shape {
        var fraction: Double
        var animatableData: Double { get { fraction } set { fraction = newValue } }
        func path(in rect: CGRect) -> Path {
            var path = Path()
            guard fraction > 0 else { return path }
            let center = CGPoint(x: rect.midX, y: rect.midY)
            path.move(to: center)
            path.addArc(center: center, radius: min(rect.width, rect.height) / 2, startAngle: .degrees(-90),
                        endAngle: .degrees(-90 + 360 * min(1, fraction)), clockwise: false)
            path.closeSubpath()
            return path
        }
    }
}
