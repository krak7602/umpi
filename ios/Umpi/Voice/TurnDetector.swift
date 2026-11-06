import Accelerate
import AVFoundation
import CoreML

/// Hears whether the owner sounds finished, from how they said it rather than the words: Smart Turn v3.2 (Pipecat,
/// BSD-2-Clause; see `Resources/SmartTurn/SmartTurn-README.md`), run on the device's CPU in a few tens of milliseconds. Voice mode asks it
/// at the start of each pause: sounding finished, Umpi replies after a short pause; sounding mid-thought, it waits.
final class TurnDetector: @unchecked Sendable {
    static let shared = TurnDetector()

    static let sampleRate = 16_000.0
    static let samples = 8 * 16_000, fftSize = 400, hop = 160, bins = 201, mels = 80, frames = 800

    private let queue = DispatchQueue(label: "umpi.voice.turn", qos: .userInitiated)
    private var model: MLModel?
    private var loadFailed = false
    /// Whisper's mel filters, frequency-major (201 × 80), and a DFT as cosine and sine tables (400 × 201).
    private let filters: [Float]
    private let cosines: [Float], sines: [Float]
    private let window: [Float]

    init() {
        if let url = Bundle.main.url(forResource: "SmartTurnMel", withExtension: "bin"), let data = try? Data(contentsOf: url),
           data.count == Self.bins * Self.mels * 4 {
            filters = data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        } else {
            filters = []
        }
        var cosines = [Float](repeating: 0, count: Self.fftSize * Self.bins), sines = cosines
        for n in 0..<Self.fftSize {
            for k in 0..<Self.bins {
                let angle = 2 * Double.pi * Double(k * n) / Double(Self.fftSize)
                cosines[n * Self.bins + k] = Float(cos(angle))
                sines[n * Self.bins + k] = Float(sin(angle))
            }
        }
        self.cosines = cosines; self.sines = sines
        // A periodic Hann window, as Whisper uses.
        window = (0..<Self.fftSize).map { Float(0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(Self.fftSize))) }
    }

    /// Loads the model ahead of the first pause.
    func prepare() { queue.async { _ = self.loaded() } }

    private func loaded() -> MLModel? {
        if let model { return model }
        guard !loadFailed, !filters.isEmpty, let url = Bundle.main.url(forResource: "SmartTurn", withExtension: "mlmodelc") else { loadFailed = true; return nil }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuOnly
        do { model = try MLModel(contentsOf: url, configuration: configuration) }
        catch { loadFailed = true; voiceLog("turn detector could not load: \(error.localizedDescription)") }
        return model
    }

    /// Asks, off the audio thread, whether the turn so far sounds finished: `done` gets the probability (nil when the
    /// model is unavailable) and the seconds it took.
    func check(_ audio: TurnAudio, done: @escaping @Sendable (Float?, TimeInterval) -> Void) {
        queue.async {
            let started = Date()
            let samples = Self.resampled(audio.buffer)
            done(self.probability(samples), Date().timeIntervalSince(started))
        }
    }

    /// The probability that the speaker has finished, for mono samples at 16 kHz.
    func probability(_ samples: [Float]) -> Float? {
        guard let model = loaded(), let input = try? MLMultiArray(shape: [1, NSNumber(value: Self.mels), NSNumber(value: Self.frames)], dataType: .float32) else { return nil }
        let features = features(samples)
        features.withUnsafeBufferPointer { source in
            input.dataPointer.assumingMemoryBound(to: Float.self).update(from: source.baseAddress!, count: features.count)
        }
        guard let output = try? model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["input_features": input])),
              let value = output.featureValue(for: "probability")?.multiArrayValue else { return nil }
        return value[0].floatValue
    }

    /// Whisper's log-mel features (80 × 800, mel-major) for the last 8 s, as Smart Turn was trained: zero-padded at the
    /// start, normalized to zero mean and unit variance, a 400-sample Hann STFT every 160 samples with reflected edges,
    /// log10 of the mel power, floored 8 below its peak, then scaled as (x + 4) / 4.
    func features(_ input: [Float]) -> [Float] {
        let n = Self.samples, half = Self.fftSize / 2
        var x = [Float](repeating: 0, count: n)
        let kept = input.suffix(n)
        x.replaceSubrange((n - kept.count)..<n, with: kept)
        var mean: Float = 0, deviation: Float = 0
        vDSP_normalize(x, 1, nil, 1, &mean, &deviation, vDSP_Length(n))
        // vDSP gives the population deviation; Whisper divides by sqrt(variance + 1e-7).
        let scale = 1 / (deviation * deviation + 1e-7).squareRoot()
        x = x.map { ($0 - mean) * scale }
        var padded = [Float](repeating: 0, count: n + 2 * half)
        for i in 0..<half { padded[i] = x[half - i]; padded[half + n + i] = x[n - 2 - i] }
        padded.replaceSubrange(half..<(half + n), with: x)
        let count = 1 + n / Self.hop   // 801 frames; the last is dropped, as Whisper does
        var segments = [Float](repeating: 0, count: count * Self.fftSize)
        for t in 0..<count {
            let start = t * Self.hop
            for i in 0..<Self.fftSize { segments[t * Self.fftSize + i] = padded[start + i] * window[i] }
        }
        var real = [Float](repeating: 0, count: count * Self.bins), imaginary = real
        vDSP_mmul(segments, 1, cosines, 1, &real, 1, vDSP_Length(count), vDSP_Length(Self.bins), vDSP_Length(Self.fftSize))
        vDSP_mmul(segments, 1, sines, 1, &imaginary, 1, vDSP_Length(count), vDSP_Length(Self.bins), vDSP_Length(Self.fftSize))
        var power = [Float](repeating: 0, count: count * Self.bins)
        vDSP_vmma(real, 1, real, 1, imaginary, 1, imaginary, 1, &power, 1, vDSP_Length(power.count))
        var mel = [Float](repeating: 0, count: count * Self.mels)
        vDSP_mmul(power, 1, filters, 1, &mel, 1, vDSP_Length(count), vDSP_Length(Self.mels), vDSP_Length(Self.bins))
        var features = [Float](repeating: 0, count: Self.mels * Self.frames)
        var peak = -Float.infinity
        for t in 0..<Self.frames {
            for m in 0..<Self.mels {
                let value = log10(max(mel[t * Self.mels + m], 1e-10))
                features[m * Self.frames + t] = value
                peak = max(peak, value)
            }
        }
        let floor = peak - 8
        return features.map { (max($0, floor) + 4) / 4 }
    }

    /// Mono samples at 16 kHz from a turn's audio at the microphone's rate.
    static func resampled(_ buffer: AVAudioPCMBuffer) -> [Float] {
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: buffer.format, to: target) else { return [] }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * sampleRate / buffer.format.sampleRate) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }
        nonisolated(unsafe) var given = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if given { status.pointee = .endOfStream; return nil }
            given = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let data = output.floatChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: data[0], count: Int(output.frameLength)))
    }
}
