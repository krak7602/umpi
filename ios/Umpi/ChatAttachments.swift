import AVFoundation
import Foundation
import Speech
import UIKit

/// What an app message carries besides its text, kept in its own protected file until the message is sent.
struct OutgoingAttachment: Codable, Equatable, Sendable {
    struct Image: Codable, Equatable, Sendable { var data: String; var mimeType: String }
    struct File: Codable, Equatable, Sendable { var name: String; var data: String }
    var images: [Image]?
    var file: File?
}

/// Attachment files live beside the companion state, excluded from backup, and are removed once the message is sent.
enum AttachmentFiles {
    private static var directory: URL? {
        try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Companion/Attachments", isDirectory: true)
    }
    private static func url(_ id: String) -> URL? {
        guard id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return nil }
        return directory?.appendingPathComponent("\(id).json")
    }
    static func save(_ attachment: OutgoingAttachment, id: String) throws {
        guard let directory, let url = url(id) else { throw CocoaError(.fileWriteInvalidFileName) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try JSONEncoder().encode(attachment).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var excluded = url
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
    }
    static func load(_ id: String) -> OutgoingAttachment? {
        guard let url = url(id), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(OutgoingAttachment.self, from: data)
    }
    static func remove(_ id: String) {
        if let url = url(id) { try? FileManager.default.removeItem(at: url) }
    }
}

enum MediaError: LocalizedError {
    case tooLarge(String), unreadable(String), speech(String)
    var errorDescription: String? {
        switch self { case .tooLarge(let text), .unreadable(let text), .speech(let text): text }
    }
}

/// Prepares photos, files, audio, and video for an app message. Speech is transcribed on the phone.
enum MediaPrep {
    /// Same limits as Telegram: up to four images, 1 MB together.
    static let maxImages = 4, imageBudget = 1_000_000, fileBudget = 10_000_000, transcriptLimit = 12_000

    /// Scales and compresses images so they fit the shared 1 MB budget.
    static func images(_ sources: [UIImage]) throws -> [OutgoingAttachment.Image] {
        let chosen = Array(sources.prefix(maxImages))
        guard !chosen.isEmpty else { return [] }
        let each = imageBudget / chosen.count
        return try chosen.map { image in
            var side: CGFloat = 1_600, quality: CGFloat = 0.75
            while true {
                guard let data = scaled(image, longestSide: side).jpegData(compressionQuality: quality) else { throw MediaError.unreadable("A photo could not be read.") }
                if data.count <= each { return .init(data: data.base64EncodedString(), mimeType: "image/jpeg") }
                if quality > 0.45 { quality -= 0.1 } else if side > 600 { side *= 0.8 } else { throw MediaError.tooLarge("A photo is too large to send.") }
            }
        }
    }
    private static func scaled(_ image: UIImage, longestSide: CGFloat) -> UIImage {
        let size = image.size, longest = max(size.width, size.height)
        guard longest > longestSide else { return image }
        let factor = longestSide / longest
        let target = CGSize(width: (size.width * factor).rounded(), height: (size.height * factor).rounded())
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
    }

    static func file(at url: URL) throws -> OutgoingAttachment.File {
        let data = try Data(contentsOf: url)
        guard data.count <= fileBudget else { throw MediaError.tooLarge("The file is larger than 10 MB.") }
        return .init(name: url.lastPathComponent, data: data.base64EncodedString())
    }

    /// A few evenly spaced frames of a video, for Umpi to see what it shows.
    static func frames(of url: URL, count: Int = 4) async throws -> [UIImage] {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1_280, height: 1_280)
        // Exact times; by default every request snaps to the nearest keyframe and the frames repeat.
        let tolerance = CMTime(seconds: 0.1, preferredTimescale: 600)
        generator.requestedTimeToleranceBefore = tolerance
        generator.requestedTimeToleranceAfter = tolerance
        var images: [UIImage] = []
        for index in 0..<count {
            let time = CMTime(seconds: max(0, duration) * (Double(index) + 0.5) / Double(count), preferredTimescale: 600)
            if let frame = try? await generator.image(at: time).image { images.append(UIImage(cgImage: frame)) }
        }
        guard !images.isEmpty else { throw MediaError.unreadable("The video's frames could not be read.") }
        return images
    }

    static func hasAudio(_ url: URL) async -> Bool {
        (try? await AVURLAsset(url: url).loadTracks(withMediaType: .audio).isEmpty == false) ?? false
    }

    /// Transcribes speech in an audio or video file. On-device recognition is used when the phone supports it.
    static func transcribe(_ url: URL) async throws -> String {
        let status = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
        guard status == .authorized else { throw MediaError.speech("Allow speech recognition in Settings to send voice and audio.") }
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable else {
            throw MediaError.speech("Speech recognition is not available right now.")
        }
        // On the phone's own model when it has one; Apple's recognition service only when it does not.
        let text: String
        if recognizer.supportsOnDeviceRecognition, let local = try? await recognize(url, with: recognizer, onDevice: true) { text = local }
        else { text = try await recognize(url, with: recognizer, onDevice: false) }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw MediaError.speech("No speech was found.") }
        return String(trimmed.prefix(transcriptLimit))
    }

    private static func recognize(_ url: URL, with recognizer: SFSpeechRecognizer, onDevice: Bool) async throws -> String {
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        request.requiresOnDeviceRecognition = onDevice
        return try await withCheckedThrowingContinuation { continuation in
            var finished = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !finished else { return }
                if let result, result.isFinal { finished = true; continuation.resume(returning: result.bestTranscription.formattedString) }
                else if let error { finished = true; continuation.resume(throwing: MediaError.speech("The speech could not be transcribed: \(error.localizedDescription)")) }
            }
        }
    }
}

/// Records a voice note to a temporary file; the file is removed after it is transcribed.
@MainActor @Observable
final class VoiceRecorder {
    private(set) var isRecording = false
    private(set) var startedAt: Date?
    @ObservationIgnored private var recorder: AVAudioRecorder?

    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw MediaError.speech("Allow the microphone in Settings to record a voice note.") }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .spokenAudio)
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        let recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1])
        guard recorder.record(forDuration: 300) else { throw MediaError.speech("Recording could not start.") }
        self.recorder = recorder
        isRecording = true; startedAt = Date()
    }
    /// Stops and returns the recording, or nil when cancelled.
    func stop(keep: Bool) -> URL? {
        let url = recorder?.url
        recorder?.stop(); recorder = nil
        isRecording = false; startedAt = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if !keep, let url { try? FileManager.default.removeItem(at: url); return nil }
        return url
    }
}
