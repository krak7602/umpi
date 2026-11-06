import AVFoundation
import Speech

/// Voice mode's sound, on the audio thread: the microphone with the phone's echo cancellation, finding when the owner
/// starts and stops talking, transcribing on the phone as they talk, and playing Umpi's speech through the same engine,
/// so the echo canceller knows Umpi's voice and does not take it for the owner's.
final class VoiceAudio: @unchecked Sendable {
    enum Mode: Sendable { case off, waiting, listening, replying, probing }
    enum Event: Sendable {
        /// The owner started talking; `cutIn` when it was over Umpi's reply.
        case started(cutIn: Bool)
        /// Words so far, and the final text once the recognizer has it.
        case words(String, final: Bool, turn: Int)
        /// The owner stopped talking for the set pause, with the turn's audio for a better transcription.
        case ended(turn: Int, audio: TurnAudio?)
        /// Loud enough to be the owner over Umpi's voice: lower Umpi while words are checked.
        case maybeCutIn
        /// It was not words after all.
        case notCutIn
        case level(Float)
        case failed(String)
    }

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let lock = NSLock()
    private var observers: [NSObjectProtocol] = []
    /// Started and not stopped: only then is a stopped engine started again.
    private var running = false
    var onEvent: (@Sendable (Event) -> Void)?

    // Settings the main side changes.
    private var _mode = Mode.off
    var mode: Mode {
        get { lock.withLock { _mode } }
        set { lock.withLock { _mode = newValue; if newValue != .probing { probeStarted = nil } } }
    }
    private var _pause = 1.2
    var pause: Double { get { lock.withLock { _pause } } set { lock.withLock { _pause = newValue } } }

    /// The quiet that ends a turn. `finished` is the turn detector's view of this pause: when the owner sounds finished, a
    /// short pause; when they sound mid-thought, up to 5 s (three times the set pause, if longer). Without it, the set
    /// pause. Words that trail off ("…and", "…so I", "…um") always wait at least 2.5 s, as people pause to think there.
    static func quietNeeded(after words: String, pause: Double, finished: Bool? = nil) -> Double {
        if finished == false { return max(5, pause * 3) }
        if trails(words) { return max(pause * 2, 2.5) }
        return finished == true ? max(0.6, pause * 0.6) : pause
    }

    static func trails(_ words: String) -> Bool {
        let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = trimmed.last else { return false }
        if last == "," || last == "-" || last == "…" { return true }
        if ".?!".contains(last) { return false }
        let word = trimmed.split(whereSeparator: { $0 == " " }).last.map { $0.lowercased().trimmingCharacters(in: .punctuationCharacters) } ?? ""
        return trailingWords.contains(word)
    }
    private static let trailingWords: Set<String> = [
        "and", "but", "or", "so", "because", "cause", "like", "um", "uh", "er", "erm", "hmm", "the", "a", "an", "to", "of",
        "for", "with", "in", "on", "at", "from", "about", "that", "which", "who", "if", "when", "then", "maybe", "also",
        "i", "i'm", "my", "your", "is", "was", "are", "it's", "gonna", "want", "just", "kind", "sort", "basically", "actually",
    ]
    private var _cutIn = true
    /// With cutting in off, the microphone is not used while Umpi speaks, so its voice is played without echo
    /// cancellation, which can briefly turn speech down when it thinks someone is talking over it.
    var cutIn: Bool {
        get { lock.withLock { _cutIn } }
        set {
            let changed = lock.withLock { () -> Bool in defer { _cutIn = newValue }; return _cutIn != newValue }
            if changed { restart() }
        }
    }
    private var _muted = false
    var muted: Bool { get { lock.withLock { _muted } } set { lock.withLock { _muted = newValue } } }

    // Audio-thread state.
    private var preroll: [AVAudioPCMBuffer] = []
    private var prerollFrames = 0
    private var recent: [Bool] = []
    private var floorDB: Float = -60
    private var heardFrames = 0, silentFrames = 0
    /// When the recognizer's words for this turn last changed; the turn ends when they stop changing, however noisy.
    private var lastWordsChange: Date?
    private var lastWords = ""
    /// The turn's audio from just before the owner started, for the transcriber; at most about a minute.
    private var turnAudio: [AVAudioPCMBuffer] = []
    private var turnAudioFrames = 0
    /// The turn detector was asked about the current pause; its answer, for that pause only, is `_finished`.
    private var pauseChecked = false
    private var pauseNumber = 0
    private var _finished: Bool?
    private var probeStarted: Date?
    private var levelTick = 0
    private var inputRate = 48_000.0

    // Recognition: one request per owner turn.
    private let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var turn = 0

    // Playback.
    private var playerFormat: AVAudioFormat?
    private var queuedFrames = 0
    private var emptySince: Date?
    private var loggedFormat = false
    private var outputLevel: Float = 0

    static func permissions() async -> String? {
        guard await AVAudioApplication.requestRecordPermission() else { return "Allow the microphone for Umpi in Settings to talk to it." }
        let speech = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
        guard speech == .authorized else { return "Allow speech recognition for Umpi in Settings to talk to it." }
        return nil
    }

    func start() throws {
        TurnDetector.shared.prepare()
        try configure()
        running = true
        let center = NotificationCenter.default
        // A call, Siri, or a route change stops the engine; start it again. Turning on echo cancellation changes the
        // audio setup once just after starting, which stops the microphone without this.
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in self?.restart() })
        #if os(iOS)
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            if type == .ended { self?.restart() }
        })
        #endif
    }

    func stop() {
        guard running else { return }
        running = false
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        mode = .off
        endRecognition(cancel: true)
        player.stop()
        removeTaps()
        engine.stop()
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    /// Starts the engine again if it stopped; safe to call any time.
    func ensureRunning() { if running, !engine.isRunning { restart() } }

    private func restart() {
        guard running else { return }
        engine.stop()
        removeTaps()
        do { try configure() } catch { onEvent?(.failed("The microphone stopped: \(error.localizedDescription)")) }
    }

    /// Removing a tap from a node that is not attached raises an exception, so only attached nodes are touched.
    private func removeTaps() {
        engine.inputNode.removeTap(onBus: 0)
        if player.engine != nil { player.removeTap(onBus: 0) }
    }

    private func configure() throws {
        let processing = cutIn
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: processing ? .voiceChat : .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        #endif
        let input = engine.inputNode
        if input.isVoiceProcessingEnabled != processing { try input.setVoiceProcessingEnabled(processing) }
        // Echo cancellation turns other sound down by default; it should not touch anything else on the phone.
        if processing { input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min) }
        #if os(iOS)
        voiceLog("audio: echo cancellation \(processing ? "on" : "off"), \(Int(session.sampleRate)) Hz, route \(session.currentRoute.outputs.map(\.portType.rawValue).joined(separator: ","))")
        #else
        // The Mac has no audio session: the engine uses the default input and output devices.
        voiceLog("audio: echo cancellation \(processing ? "on" : "off"), \(Int(input.outputFormat(forBus: 0).sampleRate)) Hz")
        #endif
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceError("The phone gave no microphone format.") }
        inputRate = format.sampleRate
        voiceLog("microphone: \(format.channelCount) channels, \(Int(format.sampleRate)) Hz, \(format.isInterleaved ? "interleaved" : "separate channels")")
        // The recognizer gets one channel: with echo cancellation, a Mac's microphone can deliver several, and the
        // recognizer then hears no speech at all.
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 50), format: format) { [weak self] buffer, _ in
            guard let self, let mono = Self.firstChannel(buffer) else { return }
            self.heard(mono)
        }
        if player.engine == nil { engine.attach(player) }
        // The player is connected, and its level measured, once the first speech gives its format.
        if let playerFormat {
            engine.connect(player, to: engine.mainMixerNode, format: playerFormat)
            player.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in self?.measureOutput(buffer) }
        }
        engine.prepare()
        try engine.start()
    }

    // MARK: Listening

    private func heard(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        let mode = self.mode, muted = self.muted
        let frame = max(1, Int(inputRate / 50))   // 20 ms
        let count = Int(buffer.frameLength)
        var voicedFrames = 0, frames = 0, loudest: Float = -100
        var start = 0
        while start < count {
            let end = min(count, start + frame)
            var sum: Float = 0
            for i in start..<end { sum += data[0][i] * data[0][i] }
            let db = 10 * log10(sum / Float(end - start) + 1e-10)
            loudest = max(loudest, db)
            // The noise floor follows quiet quickly and loud slowly.
            floorDB = db < floorDB ? floorDB + 0.3 * (db - floorDB) : floorDB + 0.003 * (db - floorDB)
            // A noisy room (a fan, a Mac's keyboard) may sit well above a quiet phone's floor.
            floorDB = min(max(floorDB, -75), -25)
            let strict = mode == .replying || mode == .probing
            let voiced = !muted && db > max(floorDB + (strict ? 18 : 10), strict ? -40 : -50)
            recent.append(voiced); if recent.count > 15 { recent.removeFirst() }
            if voiced { voicedFrames += 1 }
            frames += 1
            start = end
        }
        levelTick += 1
        if levelTick % 2 == 0, mode == .listening || mode == .waiting {
            onEvent?(.level(muted ? 0 : min(1, max(0, (loudest - floorDB) / 40))))
        }
        // The last 400 ms, so the first syllable is not lost.
        if let copy = buffer.copy() as? AVAudioPCMBuffer { preroll.append(copy); prerollFrames += count }
        while prerollFrames - Int(preroll.first?.frameLength ?? 0) > Int(inputRate * 0.4) { prerollFrames -= Int(preroll.removeFirst().frameLength) }

        switch mode {
        case .off:
            break
        case .waiting:
            if recent.suffix(12).filter({ $0 }).count >= 8 { begin(cutIn: false) }
        case .listening:
            request?.append(buffer)
            keep(buffer)
            heardFrames += frames
            // A buffer is speech only with several voiced moments, so a click or a short noise does not hold the turn open.
            let speaking = voicedFrames >= max(2, frames / 4)
            silentFrames = speaking ? 0 : silentFrames + frames
            if speaking, pauseChecked {
                // Talking again: the next pause gets its own answer.
                pauseChecked = false
                lock.withLock { pauseNumber += 1; _finished = nil }
            } else if !speaking, !pauseChecked, Double(silentFrames) * 0.02 >= 0.3, let audio = TurnAudio(lastSeconds(8.2)) {
                pauseChecked = true
                let pause = lock.withLock { pauseNumber }
                TurnDetector.shared.check(audio) { [weak self] probability, took in
                    guard let self, let probability else { return }
                    let current = self.lock.withLock { () -> Bool in
                        guard self.pauseNumber == pause else { return false }
                        self._finished = probability >= 0.5
                        return true
                    }
                    voiceLog(String(format: "turn detector: %.2f finished (%@) in %.0f ms", probability, current ? "used" : "too late", took * 1000))
                }
            }
            let (quiet, wordsSettled, noWords) = lock.withLock { () -> (Double, Bool, Bool) in
                let quiet = Self.quietNeeded(after: lastWords, pause: _pause, finished: _finished)
                guard let changed = lastWordsChange else { return (quiet, false, true) }
                return (quiet, Date().timeIntervalSince(changed) >= quiet + 0.6, false)
            }
            if heardFrames / 50 != (heardFrames - frames) / 50 {
                voiceLog(String(format: "listening: loudest %.0f dB, floor %.0f dB, voiced %d/%d frames, quiet %.1f of %.1f s, heard %.1f s, words %@",
                             loudest, floorDB, voicedFrames, frames, Double(silentFrames) * 0.02, quiet, Double(heardFrames) * 0.02, noWords ? "none" : (wordsSettled ? "settled" : "changing")))
            }
            // Ends on quiet, on words that stopped changing, after 55 s, or after 8 s of sound with no words at all.
            if Double(silentFrames) * 0.02 >= quiet || wordsSettled || Double(heardFrames) * 0.02 >= 55 || (noWords && Double(heardFrames) * 0.02 >= 8) {
                let finished = lock.withLock { _finished }
                voiceLog("turn ended: \(Double(silentFrames) * 0.02 >= quiet ? "quiet" : wordsSettled ? "words settled" : noWords ? "no words" : "too long") after waiting \(quiet) s (sounded \(finished.map { $0 ? "finished" : "mid-thought" } ?? "unknown"))")
                self.mode = .replying
                request?.endAudio()
                let audio = TurnAudio(turnAudio)
                turnAudio = []; turnAudioFrames = 0
                onEvent?(.ended(turn: turn, audio: audio))
            }
        case .replying:
            guard cutIn, recent.filter({ $0 }).count >= 10 else { break }
            // Maybe the owner: lower Umpi and check for words before stopping it.
            lock.withLock { _mode = .probing; probeStarted = Date() }
            onEvent?(.maybeCutIn)
            startRecognition()
        case .probing:
            request?.append(buffer)
            keep(buffer)
            if let started = lock.withLock({ probeStarted }), Date().timeIntervalSince(started) > 1.6 {
                endRecognition(cancel: true)
                self.mode = .replying
                recent.removeAll()
                onEvent?(.notCutIn)
            }
        }
    }

    /// The owner started talking: transcribe from just before, then keep streaming.
    private func begin(cutIn: Bool) {
        mode = .listening
        heardFrames = 0; silentFrames = 0
        recent.removeAll()
        if !cutIn { startRecognition() }
        onEvent?(.started(cutIn: cutIn))
    }

    private func startRecognition() {
        endRecognition(cancel: true)
        guard let recognizer, recognizer.isAvailable else { onEvent?(.failed("Speech recognition is not available right now.")); return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        // On the phone's own model when it has one.
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        voiceLog("recognition started (on device: \(recognizer.supportsOnDeviceRecognition), locale \(recognizer.locale.identifier))")
        turn += 1
        let turn = self.turn
        lock.withLock { lastWords = ""; lastWordsChange = nil }
        turnAudio = []; turnAudioFrames = 0
        pauseChecked = false
        lock.withLock { pauseNumber += 1; _finished = nil }
        for buffer in preroll { request.append(buffer); keep(buffer) }
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                // Words while checking a possible cut-in: two or more is the owner talking.
                if self.mode == .probing, text.split(separator: " ").count >= 2 {
                    self.lock.withLock { self._mode = .listening; self.probeStarted = nil }
                    self.heardFrames = 0; self.silentFrames = 0
                    self.onEvent?(.started(cutIn: true))
                }
                self.lock.withLock { if text != self.lastWords { self.lastWords = text; self.lastWordsChange = text.isEmpty ? nil : Date() } }
                self.onEvent?(.words(text, final: result.isFinal, turn: turn))
            } else if let error {
                voiceLog("recognition error: \(error.localizedDescription)")
                self.onEvent?(.words("", final: true, turn: turn))
            }
        }
    }

    /// The turn's last `seconds` of audio, for the turn detector.
    private func lastSeconds(_ seconds: Double) -> [AVAudioPCMBuffer] {
        var frames = 0, pieces: [AVAudioPCMBuffer] = []
        for buffer in turnAudio.reversed() {
            pieces.append(buffer)
            frames += Int(buffer.frameLength)
            if Double(frames) >= inputRate * seconds { break }
        }
        return pieces.reversed()
    }

    /// Keeps a copy of the turn's audio for the transcriber, up to about a minute.
    private func keep(_ buffer: AVAudioPCMBuffer) {
        guard turnAudioFrames < Int(inputRate * 60), let copy = buffer.copy() as? AVAudioPCMBuffer else { return }
        turnAudio.append(copy)
        turnAudioFrames += Int(copy.frameLength)
    }

    /// The owner left mid-turn: stop listening and let the recognizer give its final words for what was heard.
    func endTurn() {
        mode = .off
        request?.endAudio()
    }

    private func endRecognition(cancel: Bool) {
        if cancel { task?.cancel() } else { request?.endAudio() }
        task = nil; request = nil
    }

    // MARK: Speaking

    /// Plays one buffer of Umpi's speech; `played` runs on the audio thread when it has been heard.
    func play(_ buffer: AVAudioPCMBuffer, played: @escaping @Sendable () -> Void) {
        // A copy: the synthesizer may reuse its buffer for the next piece before this one has played.
        guard let float = Self.floatCopy(buffer) else { played(); return }
        if playerFormat == nil || playerFormat!.sampleRate != float.format.sampleRate || playerFormat!.channelCount != float.format.channelCount {
            player.stop()
            playerFormat = float.format
            if player.engine != nil { player.removeTap(onBus: 0) }
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: float.format)
            player.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in self?.measureOutput(buffer) }
        }
        // A gap: the player ran dry while more speech was coming.
        let gap = lock.withLock { () -> TimeInterval? in
            defer { queuedFrames += Int(float.frameLength); emptySince = nil }
            return emptySince.map { Date().timeIntervalSince($0) }
        }
        if let gap, gap > 0.03, gap < 5 { voiceLog(String(format: "gap of %.0f ms before the next speech", gap * 1000)) }
        if !loggedFormat { loggedFormat = true; voiceLog("speech buffers: \(buffer.format)") }
        player.scheduleBuffer(float) { [weak self] in
            guard let self else { return }
            self.lock.withLock { self.queuedFrames -= Int(float.frameLength); if self.queuedFrames == 0 { self.emptySince = Date() } }
            played()
        }
        if !player.isPlaying { player.play() }
    }

    var isPlaying: Bool { lock.withLock { queuedFrames > 0 } }

    func stopPlayback() {
        player.stop()
        lock.withLock { queuedFrames = 0; emptySince = nil }
    }

    /// A reply ended: the silence before the next one is not a gap.
    func replyEnded() { lock.withLock { emptySince = nil } }

    private func measureOutput(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += data[0][i] * data[0][i] }
        let db = 10 * log10(sum / Float(buffer.frameLength) + 1e-10)
        onEvent?(.level(min(1, max(0, (db + 50) / 40))))
    }

    /// A float copy that stays valid after the synthesizer reuses its buffer.
    static func floatCopy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let float = floatBuffer(buffer) else { return nil }
        return float === buffer ? (buffer.copy() as? AVAudioPCMBuffer) : float
    }

    /// Channel 0 alone, as float: the echo-cancelled voice. The same buffer when it already is one float channel.
    static func firstChannel(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let source = buffer.format
        if source.channelCount == 1, source.commonFormat == .pcmFormatFloat32, !source.isInterleaved { return buffer }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: source.sampleRate, channels: 1, interleaved: false),
              let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength), let target = out.floatChannelData?[0] else { return nil }
        out.frameLength = buffer.frameLength
        let n = Int(buffer.frameLength), stride = source.isInterleaved ? Int(source.channelCount) : 1
        if let floats = buffer.floatChannelData { for i in 0..<n { target[i] = floats[0][i * stride] } }
        else if let ints = buffer.int16ChannelData { for i in 0..<n { target[i] = Float(ints[0][i * stride]) / 32_768 } }
        else { return nil }
        return out
    }

    /// The synthesizer's buffers can be 16-bit; the player takes float.
    static func floatBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if buffer.format.commonFormat == .pcmFormatFloat32, !buffer.format.isInterleaved { return buffer }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: buffer.format.sampleRate, channels: 1, interleaved: false),
              let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength), let target = out.floatChannelData?[0] else { return nil }
        out.frameLength = buffer.frameLength
        let n = Int(buffer.frameLength), channels = Int(buffer.format.channelCount)
        if let ints = buffer.int16ChannelData {
            let stride = buffer.format.isInterleaved ? channels : 1
            for i in 0..<n { target[i] = Float(ints[0][i * stride]) / 32_768 }
        } else if let floats = buffer.floatChannelData {
            let stride = buffer.format.isInterleaved ? channels : 1
            for i in 0..<n { target[i] = floats[0][i * stride] }
        } else { return nil }
        return out
    }
}

struct VoiceError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
