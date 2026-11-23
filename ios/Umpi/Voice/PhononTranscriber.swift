import AVFoundation
import CoreML
import FluidAudio
import Foundation

/// Phonon-2, an open English speech model (a re-training of NVIDIA's Parakeet TDT v3) run on this device's Neural
/// Engine by FluidAudio: far more accurate than the recognizer iOS gives apps on the device. Voice mode keeps Apple's
/// recognizer for the live caption and for hearing when a turn ends, then writes the turn's audio out with this.
/// Its files (about 360 MB) download once and stay on the device, outside backups; nothing is sent anywhere.
actor PhononTranscriber {
    static let shared = PhononTranscriber()

    /// `downloading` carries the fraction done; `preparing` is compiling or loading the files on the device.
    enum State: Equatable, Sendable { case notReady, downloading(Double), preparing, ready, failed(String) }
    private(set) var state = State.notReady {
        didSet { published += 1; let state = state, number = published; Task { @MainActor in VoiceModelStatus.shared.update(phonon: state, number: number) } }
    }
    private var published = 0
    private var manager: AsrManager?
    private var preparing: Task<Void, Error>?
    /// The owner's speech words, and FluidAudio's word spotter (Parakeet CTC 110M, about 100 MB, downloaded once when
    /// there are words), which checks Phonon-2's text against the turn's audio and puts in a word where the text reads
    /// like it and the audio fits it (`spotterConfig`).
    private var words: [String] = []
    private var spotterModels: CtcModels?
    private var boosting: (words: [String], session: VocabularyBoostingSession)?
    private var spotting: Task<Void, Never>?

    /// The files are on the device: a later start loads them without the network.
    nonisolated static var downloaded: Bool { UserDefaults.standard.bool(forKey: "phonon.downloaded") }

    nonisolated static var directory: URL { AsrModels.defaultCacheDirectory(for: .phonon2) }

    /// Downloads (the first time) and loads the model. Core ML compiles it for the Neural Engine on its first load after
    /// an install or update, which takes minutes once and is kept. Its encoder has three versions, for 5, 10, and 15 s of
    /// audio, each a third of that compile; only the 15 s one is needed. So until `prepareSpeedUps` has compiled the
    /// other two for this build, the model loads with the 15 s one alone and is ready in a third of the time.
    /// Safe to call again; one preparation runs at a time.
    func prepare() async throws {
        if manager != nil { return }
        if let preparing { return try await preparing.value }
        state = Self.downloaded ? .preparing : .downloading(0)
        voiceLog(Self.downloaded ? "phonon preparing (minutes after an install or update, while it is compiled for the Neural Engine)" : "phonon downloading")
        let task = Task {
            let started = Date()
            // Downloads what is missing; with everything present it returns at once.
            let directory = try await AsrModels.download(version: .phonon2) { progress in
                Task { await self.report(progress) }
            }
            state = .preparing
            var url = Self.directory
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
            UserDefaults.standard.set(true, forKey: "phonon.downloaded")
            let complete = Self.speedUpsReady
            let models = complete ? try await AsrModels.load(from: directory, version: .phonon2) : try await Self.loadQuickly(from: directory)
            let manager = AsrManager(config: .default)
            try await manager.loadModels(models)
            self.manager = manager
            // Loaded before voice mode has fetched the words (such as by the warm-up after an update): the saved copy.
            if words.isEmpty { words = SpeechWords.cached }
            prepareSpotter()
            let took = Date().timeIntervalSince(started)
            voiceLog(String(format: "phonon ready in %.1f s%@", took, complete ? "" : " (15 s encoder only; the shorter ones compile next)"))
            // How long a compile takes on this device, to show progress next time.
            if took > 20 { UserDefaults.standard.set(took, forKey: "phonon.prepareSeconds") }
        }
        preparing = task
        do { try await task.value; state = .ready; preparing = nil }
        catch { state = .failed(error.localizedDescription); preparing = nil; voiceLog("phonon could not load: \(error.localizedDescription)"); throw error }
    }

    /// The encoder's 5 s and 10 s versions are compiled for this build of the app, so a load takes all three.
    nonisolated static var speedUpsReady: Bool {
        UserDefaults.standard.string(forKey: "phonon.speedUpsFor") == VoiceModelWarmup.buildKey
    }

    /// Compiles the encoder's 5 s and 10 s versions, which make shorter turns quicker to write out, and keeps the
    /// result for the next load. The loaded model is left as it is; from the next load on it uses them.
    /// Runs off the transcriber, which keeps writing out turns meanwhile; true once all are compiled.
    @discardableResult
    nonisolated func prepareSpeedUps() async -> Bool {
        guard Self.downloaded, !Self.speedUpsReady, let encoder = Self.encoderURL else { return Self.speedUpsReady }
        let started = Date()
        for function in ["enc_5040ms", "enc_10160ms"] {
            if Task.isCancelled { return false }
            // Minutes of blocking work: on a thread of its own, not one of Swift's few shared ones. At the first stage's
            // priority: at utility priority the system's compile ran about three times slower (1,020 s against 152 s
            // for one version, on an iPhone 13).
            let error: String? = await withCheckedContinuation { done in
                DispatchQueue.global(qos: .userInitiated).async {
                    let configuration = Self.configuration(Self.encoderUnits)
                    configuration.functionName = function
                    do { _ = try MLModel(contentsOf: encoder, configuration: configuration); done.resume(returning: nil) }
                    catch { done.resume(returning: error.localizedDescription) }
                }
            }
            if let error { voiceLog("phonon \(function) could not compile: \(error)"); return false }
        }
        let took = Date().timeIntervalSince(started)
        UserDefaults.standard.set(VoiceModelWarmup.buildKey, forKey: "phonon.speedUpsFor")
        if took > 20 { UserDefaults.standard.set(took, forKey: "phonon.speedUpSeconds") }
        voiceLog(String(format: "phonon shorter encoders compiled in %.0f s", took))
        return true
    }

    /// Phonon-2 with only its 15 s encoder: the same files and settings as FluidAudio's own load, so what is compiled
    /// here is reused by it, without the shorter encoder versions.
    private static func loadQuickly(from directory: URL) async throws -> AsrModels {
        guard let repo = repository(directory) else { return try await AsrModels.load(from: directory, version: .phonon2) }
        func model(_ name: String, _ units: MLComputeUnits) throws -> MLModel {
            try MLModel(contentsOf: repo.appendingPathComponent(name), configuration: configuration(units))
        }
        let defaults = AsrModels.defaultConfiguration()
        let vocabulary = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: repo.appendingPathComponent("parakeet_vocab.json")))
        return AsrModels(
            encoder: try model("Encoder.mlmodelc", encoderUnits),
            preprocessor: try model("Preprocessor.mlmodelc", .cpuOnly),
            decoder: try model("Decoder.mlmodelc", defaults.computeUnits),
            joint: try model("JointDecisionv3.mlmodelc", defaults.computeUnits),
            configuration: defaults,
            vocabulary: Dictionary(uniqueKeysWithValues: vocabulary.compactMap { key, value in Int(key).map { ($0, value) } }),
            version: .phonon2)
    }

    private static var encoderUnits: MLComputeUnits { AsrModels.defaultConfiguration().computeUnits }

    /// FluidAudio's settings for each model, so Core ML's compiled result is shared.
    private static func configuration(_ units: MLComputeUnits) -> MLModelConfiguration {
        let configuration = MLModelConfiguration()
        configuration.computeUnits = units
        configuration.allowLowPrecisionAccumulationOnGPU = true
        return configuration
    }

    /// The folder holding the model files: the download folder, or FluidAudio's folder for this model beside it.
    private static func repository(_ directory: URL) -> URL? {
        [directory, directory.deletingLastPathComponent().appendingPathComponent("phonon-2"), Self.directory]
            .first { FileManager.default.fileExists(atPath: $0.appendingPathComponent("Encoder.mlmodelc").path) }
    }

    private static var encoderURL: URL? { repository(directory).map { $0.appendingPathComponent("Encoder.mlmodelc") } }

    private func report(_ progress: DownloadProgress) {
        switch (state, progress.phase) {
        case (.downloading, .downloading): state = .downloading(min(1, max(0, progress.fractionCompleted)))
        case (.downloading, .compiling): state = .preparing
        default: break
        }
    }

    /// The speech words to correct towards. With words and Phonon-2 loaded, the word spotter loads in the background
    /// (downloading it the first time); until it is ready, turns are written out without it.
    func use(words: [String]) {
        guard words != self.words else { return }
        self.words = words
        if words.isEmpty { boosting = nil; return }
        prepareSpotter()
    }

    private func prepareSpotter() {
        guard spotting == nil, manager != nil, !words.isEmpty, boosting?.words != words else { return }
        let wanted = words, loaded = spotterModels
        spotting = Task {
            do {
                let models: CtcModels
                if let loaded { models = loaded } else {
                    voiceLog(CtcModels.modelsExist(at: Self.spotterDirectory) ? "word spotter loading" : "word spotter downloading (about 100 MB)")
                    models = try await CtcModels.downloadAndLoad(variant: .ctc110m)
                    var url = Self.spotterDirectory
                    var values = URLResourceValues(); values.isExcludedFromBackup = true
                    try? url.setResourceValues(values)
                }
                spotterModels = models
                let vocabulary = CustomVocabularyContext(terms: wanted.map { CustomVocabularyTerm(text: $0) })
                boosting = (wanted, try await VocabularyBoostingSession(vocabulary: vocabulary, ctcModels: models, config: Self.spotterConfig, thresholds: Self.spotterThresholds))
                voiceLog("word spotter ready for \(wanted.count) speech words")
            } catch {
                voiceLog("word spotter could not load: \(error.localizedDescription)")
            }
            spotting = nil
            // The words changed while it loaded.
            if boosting?.words != words, !words.isEmpty, spotterModels != nil { prepareSpotter() }
        }
    }

    nonisolated static var spotterDirectory: URL { CtcModels.defaultCacheDirectory(for: .ctc110m) }

    /// How the word spotter decides. FluidAudio's defaults favour putting a word in, and in dictation they put speech
    /// words where ordinary words were said. Three of its settings are changed:
    /// - `spotterRescueEnabled: false`. The "acoustic rescue" (lists of up to 10 words only) replaces a span on sound
    ///   alone, however unlike the word it reads, and caused nearly all wrong replacements.
    /// - `minSimilarity: 0.6` (FluidAudio: 0.50 up to 10 words, 0.55 up to 100). A word goes in only where Phonon-2's
    ///   text reads this much like it.
    /// - `shortTermCbwTaperPivot: 5` with exponent 2. A word of fewer than 5 tokens (a short name) gets less of the
    ///   bonus FluidAudio gives speech words, so it must fit the audio better than the common word Phonon-2 wrote.
    /// A short name one sound away from a common word ("Tark" for "park") can still replace it now and then.
    /// Measured with invented words and system voices: `docs/subsystems/phone-companion.md`, "Speech words".
    private static let spotterConfig = VocabularyRescorer.Config(shortTermCbwTaperPivot: 5, shortTermCbwTaperExponent: 2, spotterRescueEnabled: false)
    private static let spotterThresholds = VocabularyBoostingSession.Thresholds(minSimilarity: 0.6)

    /// A speech word goes in only where the words it replaces read at least this much like it (`likeness`).
    static let leastLikeness = 0.5

    /// How alike two texts read, from 0 to 1, by their letters and digits alone: 1 less the edit distance over the
    /// longer length. "Brandwell" and "Brantwell" give 0.89; "twelve minutes" and "Dremm" give 0.15.
    static func likeness(_ first: String, _ second: String) -> Double {
        let a = Array(first.lowercased().filter { $0.isLetter || $0.isNumber }), b = Array(second.lowercased().filter { $0.isLetter || $0.isNumber })
        guard !a.isEmpty, !b.isEmpty else { return a.isEmpty && b.isEmpty ? 1 : 0 }
        var previous = Array(0...b.count), current = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            current[0] = i
            for j in 1...b.count { current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)) }
            swap(&previous, &current)
        }
        return 1 - Double(previous[b.count]) / Double(max(a.count, b.count))
    }

    /// True when every speech word went where the words it replaced read like it. One that did not (a word put in on
    /// sound alone) means the spotter's text is not trusted, and Phonon-2's goes as written.
    static func plausible(_ replacements: [(heard: String, word: String)]) -> Bool {
        replacements.allSatisfy { likeness($0.heard, $0.word) >= leastLikeness }
    }

    /// The words in `audio` (mono, any sample rate), or nil when the model is not loaded yet or fails.
    func transcribe(_ audio: TurnAudio) async -> String? {
        guard let manager else { voiceLog("phonon not ready yet (\(state)); sending the recognizer's words"); return nil }
        let started = Date()
        do {
            let samples = try AudioConverter().resampleBuffer(audio.buffer)
            var decoder = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
            let result = try await manager.transcribe(samples, decoderState: &decoder)
            voiceLog(String(format: "phonon wrote %d words from %.1f s of speech in %.2f s", result.text.split(separator: " ").count, audio.seconds, Date().timeIntervalSince(started)))
            guard let session = boosting?.session, let timings = result.tokenTimings, !timings.isEmpty, !result.text.isEmpty else { return result.text }
            return await Self.corrected(result.text, timings: timings, samples: samples, session: session)
        } catch {
            voiceLog("phonon failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Phonon-2's text with the speech words the spotter heard put in. At most 2 s: past that the text goes as written,
    /// and the spotter finishes on its own. The text also goes as written when a word went where the words read
    /// nothing like it, which the spotter's settings should already prevent.
    private static func corrected(_ text: String, timings: [TokenTiming], samples: [Float], session: VocabularyBoostingSession) async -> String {
        let started = Date()
        let output = await firstOf(seconds: 2) { await session.rescore(text: text, tokenTimings: timings, audioSamples: samples) }
        guard let output else { voiceLog("word spotter took over 2 s; sending phonon's words as written"); return text }
        guard let result = output, result.wasModified else { return text }
        guard plausible(result.replacements.map { ($0.originalWord, $0.replacementWord ?? "") }) else {
            voiceLog("word spotter put a speech word where the words read unlike it (\(result.replacements.count) put in); sending phonon's words as written")
            return text
        }
        voiceLog(String(format: "word spotter put in %d speech words in %.2f s", result.replacements.count, Date().timeIntervalSince(started)))
        return result.text
    }

    /// `work`'s result, or nil (outer) when it takes longer than `seconds`; it is not waited for after that.
    private static func firstOf<T: Sendable>(seconds: Double, _ work: @escaping @Sendable () async -> T) async -> T? {
        let once = Once()
        return await withCheckedContinuation { (done: CheckedContinuation<T?, Never>) in
            Task { let value = await work(); if once.claim() { done.resume(returning: .some(value)) } }
            Task { try? await Task.sleep(for: .seconds(seconds)); if once.claim() { done.resume(returning: .none) } }
        }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var claimed = false
        func claim() -> Bool { lock.withLock { defer { claimed = true }; return !claimed } }
    }

    /// Frees the loaded models, keeping their files; they load again in seconds, as Core ML keeps the compiled result.
    func unload() {
        guard preparing == nil, spotting == nil, manager != nil else { return }
        manager = nil
        spotterModels = nil
        boosting = nil
        state = .notReady
    }

    /// Removes the downloaded files, the word spotter's too.
    func remove() {
        manager = nil
        spotterModels = nil
        boosting = nil
        state = .notReady
        UserDefaults.standard.set(false, forKey: "phonon.downloaded")
        try? FileManager.default.removeItem(at: Self.directory)
        try? FileManager.default.removeItem(at: Self.spotterDirectory)
    }
}

/// A turn's audio, handed from the audio thread to the transcriber once the turn has ended and nothing writes to it.
struct TurnAudio: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer

    var seconds: Double { Double(buffer.frameLength) / buffer.format.sampleRate }

    /// Two parts of one turn, the owner having carried on after a pause that ended the first, as one.
    static func joined(_ first: TurnAudio?, _ second: TurnAudio?) -> TurnAudio? {
        TurnAudio([first?.buffer, second?.buffer].compactMap { $0 })
    }

    /// One buffer from the turn's pieces, or nil when there is nothing.
    init?(_ pieces: [AVAudioPCMBuffer]) {
        guard let format = pieces.first?.format else { return nil }
        let frames = pieces.reduce(0) { $0 + Int($1.frameLength) }
        guard frames > 0, let joined = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let target = joined.floatChannelData else { return nil }
        var offset = 0
        for piece in pieces {
            guard let source = piece.floatChannelData, piece.format == format else { continue }
            let count = Int(piece.frameLength)
            target[0].advanced(by: offset).update(from: source[0], count: count)
            offset += count
        }
        joined.frameLength = AVAudioFrameCount(offset)
        buffer = joined
    }
}
