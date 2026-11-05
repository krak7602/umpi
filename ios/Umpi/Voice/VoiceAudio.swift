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
        /// The owner stopped talking for the set pause.
        case ended(turn: Int)
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
    private var _pause = 0.7
    var pause: Double { get { lock.withLock { _pause } } set { lock.withLock { _pause = newValue } } }
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
        try configure()
        running = true
        let center = NotificationCenter.default
        // A call, Siri, or a route change stops the engine; start it again. Turning on echo cancellation changes the
        // audio setup once just after starting, which stops the microphone without this.
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in self?.restart() })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            if type == .ended { self?.restart() }
        })
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
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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
        let session = AVAudioSession.sharedInstance()
        let processing = cutIn
        try session.setCategory(.playAndRecord, mode: processing ? .voiceChat : .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        let input = engine.inputNode
        if input.isVoiceProcessingEnabled != processing { try input.setVoiceProcessingEnabled(processing) }
        // Echo cancellation turns other sound down by default; it should not touch anything else on the phone.
        if processing { input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min) }
        print("VOICELOG audio: echo cancellation \(processing ? "on" : "off"), \(Int(session.sampleRate)) Hz, route \(session.currentRoute.outputs.map(\.portType.rawValue).joined(separator: ","))")
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceError("The phone gave no microphone format.") }
        inputRate = format.sampleRate
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 50), format: format) { [weak self] buffer, _ in self?.heard(buffer) }
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
            floorDB = min(max(floorDB, -75), -35)
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
            heardFrames += frames
            silentFrames = voicedFrames > 0 ? 0 : silentFrames + frames
            if Double(silentFrames) * 0.02 >= pause || Double(heardFrames) * 0.02 >= 55 {
                self.mode = .replying
                request?.endAudio()
                onEvent?(.ended(turn: turn))
            }
        case .replying:
            guard cutIn, recent.filter({ $0 }).count >= 10 else { break }
            // Maybe the owner: lower Umpi and check for words before stopping it.
            lock.withLock { _mode = .probing; probeStarted = Date() }
            onEvent?(.maybeCutIn)
            startRecognition()
        case .probing:
            request?.append(buffer)
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
        turn += 1
        let turn = self.turn
        for buffer in preroll { request.append(buffer) }
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
                self.onEvent?(.words(text, final: result.isFinal, turn: turn))
            } else if error != nil {
                self.onEvent?(.words("", final: true, turn: turn))
            }
        }
    }

    private func endRecognition(cancel: Bool) {
        if cancel { task?.cancel() } else { request?.endAudio() }
        task = nil; request = nil
    }

    // MARK: Speaking

    /// Plays one buffer of Umpi's speech; `played` runs on the audio thread when it has been heard.
    func play(_ buffer: AVAudioPCMBuffer, played: @escaping @Sendable () -> Void) {
        guard let float = Self.floatBuffer(buffer) else { played(); return }
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
        if let gap, gap > 0.03, gap < 5 { print(String(format: "VOICELOG gap of %.0f ms before the next speech", gap * 1000)) }
        if !loggedFormat { loggedFormat = true; print("VOICELOG speech buffers: \(buffer.format)") }
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

    /// The synthesizer's buffers can be 16-bit; the player takes float.
    private static func floatBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
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
