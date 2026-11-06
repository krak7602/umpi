import SwiftUI

/// The voice models' download and preparation, for the screens: the voice settings, and a quiet icon (beside the
/// connection's) while a model is downloading or preparing for long enough to notice, such as after an update.
@MainActor @Observable
final class VoiceModelStatus {
    static let shared = VoiceModelStatus()

    private(set) var kokoro = KokoroVoice.State.notReady
    private(set) var phonon = PhononTranscriber.State.notReady
    /// True once a model has been busy for over a second, so a quick load does not flash the icon.
    private(set) var showing = false
    @ObservationIgnored private var kokoroNumber = 0
    @ObservationIgnored private var phononNumber = 0
    @ObservationIgnored private var showTask: Task<Void, Never>?

    // Updates come from the models' actors in tasks, which can arrive out of order: an older one is ignored.
    func update(kokoro state: KokoroVoice.State, number: Int) {
        guard number > kokoroNumber else { return }
        kokoroNumber = number; kokoro = state; refresh()
    }
    func update(phonon state: PhononTranscriber.State, number: Int) {
        guard number > phononNumber else { return }
        phononNumber = number; phonon = state; refresh()
    }

    var busy: Bool { Self.fraction(kokoro) != nil || Self.fraction(phonon) != nil }

    /// The download's fraction across the models downloading, or nil when they are only preparing.
    var downloading: Double? {
        let fractions = [Self.fraction(kokoro), Self.fraction(phonon)].compactMap { $0 }.filter { $0 <= 1 }
        return fractions.isEmpty ? nil : fractions.reduce(0, +) / Double(fractions.count)
    }

    var summary: String {
        if let fraction = downloading { return "Downloading voice models… \(Int(fraction * 100))%" }
        return "Preparing voice models…"
    }

    private func refresh() {
        if !busy { showTask?.cancel(); showTask = nil; showing = false; return }
        guard !showing, showTask == nil else { return }
        showTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard let self, !Task.isCancelled else { return }
            self.showTask = nil
            if self.busy { self.showing = true }
        }
    }

    /// A fraction while downloading, above 1 while preparing, nil otherwise.
    static func fraction(_ state: KokoroVoice.State) -> Double? {
        switch state { case .downloading(let fraction): fraction; case .preparing: 1.5; default: nil }
    }
    static func fraction(_ state: PhononTranscriber.State) -> Double? {
        switch state { case .downloading(let fraction): fraction; case .preparing: 1.5; default: nil }
    }
}

/// The voice models' icon: a waveform whose bars fill as they download, and ripple while they prepare.
struct VoiceModelIcon: View {
    let status = VoiceModelStatus.shared

    var body: some View {
        Image(systemName: "waveform", variableValue: status.downloading ?? 1)
            .symbolEffect(.variableColor.iterative.dimInactiveLayers, options: .repeating, isActive: status.downloading == nil)
            .foregroundStyle(Color.accentColor)
            .accessibilityLabel(status.summary)
    }
}

/// Each voice model and where it is, shown from the icon.
struct VoiceModelsPopover: View {
    let status = VoiceModelStatus.shared
    let settings = VoiceSettings.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Voice models").font(.headline)
            row("Natural voice", detail: "Kokoro · \(KokoroVoice.voices.first?.name ?? "Heart")",
                state: settings.kokoroVoice == nil ? "Not used" : Self.describe(status.kokoro, downloaded: KokoroVoice.downloaded),
                progress: settings.kokoroVoice == nil ? nil : VoiceModelStatus.fraction(status.kokoro), ready: status.kokoro == .ready)
            row("Recognition", detail: "Phonon-2",
                state: settings.usesPhonon ? Self.describe(status.phonon, downloaded: PhononTranscriber.downloaded) : "Not used · Apple's recognizer",
                progress: settings.usesPhonon ? VoiceModelStatus.fraction(status.phonon) : nil, ready: status.phonon == .ready)
            row("Turn detection", detail: "Smart Turn", state: "Built in", progress: nil, ready: true)
            Text("After an update, models are prepared again for this \(ThisDevice.noun)'s Neural Engine. Until they are ready, voice mode uses Apple's recognizer and voice.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(width: 300)
    }

    private func row(_ name: String, detail: String, state: String, progress: Double?, ready: Bool) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                Text("\(detail) · \(state)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Spacer(minLength: 8)
            if let progress { DownloadRing(fraction: progress > 1 ? nil : progress) }
            else if ready { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
        }
    }

    static func describe(_ state: KokoroVoice.State, downloaded: Bool) -> String {
        switch state {
        case .downloading(let fraction): "Downloading \(Int(fraction * 100))%"
        case .preparing: "Preparing…"
        case .ready: "Ready"
        case .failed: "Could not load"
        case .notReady: downloaded ? "Loads when voice mode opens" : "Not downloaded"
        }
    }
    static func describe(_ state: PhononTranscriber.State, downloaded: Bool) -> String {
        switch state {
        case .downloading(let fraction): "Downloading \(Int(fraction * 100))%"
        case .preparing: "Preparing… a few minutes after an update"
        case .ready: "Ready"
        case .failed: "Could not load"
        case .notReady: downloaded ? "Loads when voice mode opens" : "Not downloaded"
        }
    }
}
