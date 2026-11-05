import AVFoundation
import Observation

/// How Umpi sounds in voice mode, and when it takes the owner's turn as finished. Kept on this phone only.
@MainActor @Observable
final class VoiceSettings {
    static let shared = VoiceSettings()
    static let normalRate = Double(AVSpeechUtteranceDefaultSpeechRate)

    /// An installed voice; nil is the best voice for the phone's language.
    var voiceIdentifier: String? { didSet { defaults.set(voiceIdentifier, forKey: "voice.identifier") } }
    /// Speech rate as Apple counts it: 0.5 is normal speed.
    var rate: Double { didSet { defaults.set(rate, forKey: "voice.rate") } }
    var pitch: Double { didSet { defaults.set(pitch, forKey: "voice.pitch") } }
    /// Seconds of quiet that end the owner's turn.
    var pause: Double { didSet { defaults.set(pause, forKey: "voice.pause") } }
    /// Talking over Umpi stops it.
    var cutIn: Bool { didSet { defaults.set(cutIn, forKey: "voice.cutIn") } }

    @ObservationIgnored private let defaults = UserDefaults.standard

    private init() {
        voiceIdentifier = defaults.string(forKey: "voice.identifier")
        rate = defaults.object(forKey: "voice.rate") as? Double ?? Self.normalRate
        pitch = defaults.object(forKey: "voice.pitch") as? Double ?? 1
        pause = defaults.object(forKey: "voice.pause") as? Double ?? 0.7
        cutIn = defaults.object(forKey: "voice.cutIn") as? Bool ?? true
    }

    /// The chosen voice if it is still installed.
    var voice: AVSpeechSynthesisVoice? { voiceIdentifier.flatMap(AVSpeechSynthesisVoice.init(identifier:)) ?? VoiceCatalog.bestDefault() }

    var speedLabel: String {
        switch rate / Self.normalRate {
        case ..<0.94: return "Slower"
        case ..<1.05: return "Normal"
        case ..<1.15: return "A little faster"
        case ..<1.28: return "Fast"
        default: return "Very fast"
        }
    }
}
