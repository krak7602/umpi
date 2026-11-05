import AVFoundation

/// Turns Umpi's sentences into speech with the owner's chosen voice, one at a time, and plays them through voice
/// mode's audio engine. Reports each sentence once it has been heard, so a cut-off reply keeps only what was said.
final class VoiceSpeaker: @unchecked Sendable {
    struct Voice: Sendable { var identifier: String?; var rate: Float; var pitch: Float }
    enum Event: Sendable { case started(String), heard(String), idle }

    private let audio: VoiceAudio
    private let queue = DispatchQueue(label: "umpi.voice.speaker")
    private let synthesizer = AVSpeechSynthesizer()
    private var pending: [String] = []
    private var writing = false
    private var generation = 0
    /// Buffers of a sentence still to be played, by sentence number.
    private var unplayed: [Int: Int] = [:]
    private var finishedWriting: Set<Int> = []
    private var texts: [Int: String] = [:]
    private var announced: Set<Int> = []
    /// Stretches written for the current reply.
    private var written = 0
    private var next = 0
    var voice = Voice(identifier: nil, rate: AVSpeechUtteranceDefaultSpeechRate, pitch: 1)
    var onEvent: (@Sendable (Event) -> Void)?

    init(audio: VoiceAudio) {
        self.audio = audio
        synthesizer.usesApplicationAudioSession = true
    }

    func say(_ sentence: String) {
        queue.async { self.pending.append(sentence); self.writeNext() }
    }

    /// Stops at once and forgets what was not spoken yet.
    func stop() {
        queue.async {
            self.generation += 1
            self.pending.removeAll()
            self.unplayed.removeAll(); self.finishedWriting.removeAll(); self.texts.removeAll(); self.announced.removeAll()
            self.written = 0
            self.writing = false
            self.synthesizer.stopSpeaking(at: .immediate)
        }
        audio.stopPlayback()
    }

    /// True while a sentence is being written or played.
    var isBusy: Bool { queue.sync { writing || !pending.isEmpty || !unplayed.isEmpty } }

    private func writeNext() {
        guard !writing, !pending.isEmpty else { return }
        // The first sentence goes alone so speech starts soon; after that, everything waiting is spoken as one stretch,
        // so there are fewer seams between sentences.
        let text = written == 0 ? pending.removeFirst() : pending.joined(separator: " ")
        if written > 0 { pending.removeAll() }
        written += 1
        writing = true
        let number = next; next += 1
        let generation = self.generation
        texts[number] = text
        unplayed[number] = 0
        let utterance = AVSpeechUtterance(string: text)
        if let identifier = voice.identifier, let chosen = AVSpeechSynthesisVoice(identifier: identifier) { utterance.voice = chosen }
        else { utterance.voice = VoiceCatalog.bestDefault() }
        utterance.rate = voice.rate
        utterance.pitchMultiplier = voice.pitch
        utterance.preUtteranceDelay = 0
        utterance.postUtteranceDelay = 0
        synthesizer.write(utterance) { [weak self] buffer in
            guard let self else { return }
            let pcm = buffer as? AVAudioPCMBuffer
            self.queue.async {
                guard generation == self.generation else { return }
                guard let pcm, pcm.frameLength > 0 else {
                    // The sentence is fully written; the next one starts while this one plays.
                    self.finishedWriting.insert(number)
                    self.writing = false
                    self.settle(number)
                    self.writeNext()
                    return
                }
                if self.announced.insert(number).inserted { self.onEvent?(.started(text)) }
                self.unplayed[number, default: 0] += 1
                self.audio.play(pcm) { [weak self] in
                    guard let self else { return }
                    self.queue.async {
                        guard generation == self.generation else { return }
                        self.unplayed[number, default: 1] -= 1
                        self.settle(number)
                    }
                }
            }
        }
    }

    private func settle(_ number: Int) {
        guard finishedWriting.contains(number), unplayed[number] == 0 else { return }
        unplayed[number] = nil; finishedWriting.remove(number); announced.remove(number)
        if let text = texts.removeValue(forKey: number) { onEvent?(.heard(text)) }
        if unplayed.isEmpty, pending.isEmpty, !writing { written = 0; onEvent?(.idle) }
    }
}

/// The voices installed on this phone, best first.
enum VoiceCatalog {
    static func voices(language: String = Locale.current.language.languageCode?.identifier ?? "en") -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(language) && !$0.voiceTraits.contains(.isNoveltyVoice) }
            .sorted { ($0.quality.rawValue, $0.voiceTraits.contains(.isPersonalVoice) ? 1 : 0, $1.name) > ($1.quality.rawValue, $1.voiceTraits.contains(.isPersonalVoice) ? 1 : 0, $0.name) }
    }

    /// The best installed voice for the phone's language and region.
    static func bestDefault() -> AVSpeechSynthesisVoice? {
        let all = voices().filter { !$0.voiceTraits.contains(.isPersonalVoice) }
        let region = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
        return all.first { $0.language == region } ?? all.first ?? AVSpeechSynthesisVoice(language: region)
    }

    static func quality(_ voice: AVSpeechSynthesisVoice) -> String {
        if voice.voiceTraits.contains(.isPersonalVoice) { return "Personal Voice" }
        switch voice.quality {
        case .premium: return "Premium"
        case .enhanced: return "Enhanced"
        default: return "Basic"
        }
    }

    static func accent(_ voice: AVSpeechSynthesisVoice) -> String {
        Locale.current.localizedString(forIdentifier: voice.language) ?? voice.language
    }
}
