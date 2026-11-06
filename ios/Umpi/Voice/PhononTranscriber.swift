import AVFoundation
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
    private(set) var state = State.notReady
    private var manager: AsrManager?
    private var preparing: Task<Void, Error>?

    /// The files are on the device: a later start loads them without the network.
    nonisolated static var downloaded: Bool { UserDefaults.standard.bool(forKey: "phonon.downloaded") }

    nonisolated static var directory: URL { AsrModels.defaultCacheDirectory(for: .phonon2) }

    /// Downloads (the first time) and loads the model. The first load also compiles it for the Neural Engine, which
    /// takes minutes once; Core ML keeps the result. Safe to call again; one preparation runs at a time.
    func prepare() async throws {
        if manager != nil { return }
        if let preparing { return try await preparing.value }
        state = Self.downloaded ? .preparing : .downloading(0)
        voiceLog(Self.downloaded ? "phonon preparing (minutes after an install or update, while it is compiled for the Neural Engine)" : "phonon downloading")
        let task = Task {
            let started = Date()
            let models = try await AsrModels.downloadAndLoad(version: .phonon2) { progress in
                Task { await self.report(progress) }
            }
            state = .preparing
            var url = Self.directory
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
            UserDefaults.standard.set(true, forKey: "phonon.downloaded")
            let manager = AsrManager(config: .default)
            try await manager.loadModels(models)
            self.manager = manager
            voiceLog(String(format: "phonon ready in %.1f s", Date().timeIntervalSince(started)))
        }
        preparing = task
        do { try await task.value; state = .ready; preparing = nil }
        catch { state = .failed(error.localizedDescription); preparing = nil; voiceLog("phonon could not load: \(error.localizedDescription)"); throw error }
    }

    private func report(_ progress: DownloadProgress) {
        switch (state, progress.phase) {
        case (.downloading, .downloading): state = .downloading(min(1, max(0, progress.fractionCompleted)))
        case (.downloading, .compiling): state = .preparing
        default: break
        }
    }

    /// The words in `audio` (mono, any sample rate), or nil when the model is not loaded yet or fails.
    func transcribe(_ audio: TurnAudio) async -> String? {
        guard let manager else { voiceLog("phonon not ready yet (\(state)); sending the recognizer's words"); return nil }
        let started = Date()
        do {
            var decoder = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
            let result = try await manager.transcribe(audio.buffer, decoderState: &decoder)
            let seconds = Double(audio.buffer.frameLength) / audio.buffer.format.sampleRate
            voiceLog(String(format: "phonon wrote %d words from %.1f s of speech in %.2f s", result.text.split(separator: " ").count, seconds, Date().timeIntervalSince(started)))
            return result.text
        } catch {
            voiceLog("phonon failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Removes the downloaded files.
    func remove() {
        manager = nil
        state = .notReady
        UserDefaults.standard.set(false, forKey: "phonon.downloaded")
        try? FileManager.default.removeItem(at: Self.directory)
    }
}

/// A turn's audio, handed from the audio thread to the transcriber once the turn has ended and nothing writes to it.
struct TurnAudio: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer

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
