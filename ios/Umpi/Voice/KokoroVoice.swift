import FluidAudio
import Foundation

/// Kokoro, an open voice model (Apache-2.0) run on the phone by FluidAudio (Apache-2.0): more natural than the voices
/// iOS gives apps. Its files download once on first use and stay on the phone, outside backups.
actor KokoroVoice {
    static let shared = KokoroVoice()
    /// Voices offered, by Kokoro's id.
    static let voices: [(id: String, name: String, detail: String)] = [("af_heart", "Heart", "American English · natural voice")]
    static let prefix = "kokoro:"

    enum State: Equatable, Sendable { case notReady, preparing, ready, failed(String) }
    private(set) var state = State.notReady
    private var manager: KokoroAneManager?
    private var preparing: Task<Void, Error>?

    /// The files are on the phone: a later start loads them without the network.
    nonisolated static var downloaded: Bool { UserDefaults.standard.bool(forKey: "kokoro.downloaded") }

    nonisolated static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Kokoro", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        var url = base
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return base
    }

    /// Downloads (the first time) and loads the model. Safe to call again; one preparation runs at a time.
    func prepare() async throws {
        if manager != nil { return }
        if let preparing { return try await preparing.value }
        state = .preparing
        let task = Task {
            let started = Date()
            let manager = KokoroAneManager(directory: Self.directory)
            try await manager.initialize(preloadVoices: Set(Self.voices.map(\.id)))
            self.manager = manager
            UserDefaults.standard.set(true, forKey: "kokoro.downloaded")
            voiceLog(String(format: "kokoro ready in %.1f s", Date().timeIntervalSince(started)))
        }
        preparing = task
        do { try await task.value; state = .ready; preparing = nil }
        catch { state = .failed(error.localizedDescription); preparing = nil; throw error }
    }

    /// 24 kHz mono speech for `text`. `speed` 1 is normal.
    func speak(_ text: String, voice: String, speed: Float) async throws -> [Float] {
        try await prepare()
        guard let manager else { throw VoiceError("The natural voice is not ready.") }
        let started = Date()
        let result = try await manager.synthesizeDetailed(text: text, voice: voice, speed: max(0.7, min(1.6, speed)))
        let seconds = Double(result.samples.count) / Double(result.sampleRate)
        let took = Date().timeIntervalSince(started)
        voiceLog(String(format: "kokoro made %.1f s of speech in %.2f s (%.1fx real time)", seconds, took, seconds / max(took, 0.001)))
        return result.samples
    }

    /// Removes the downloaded files.
    func remove() {
        manager = nil
        state = .notReady
        UserDefaults.standard.set(false, forKey: "kokoro.downloaded")
        try? FileManager.default.removeItem(at: Self.directory)
    }
}
