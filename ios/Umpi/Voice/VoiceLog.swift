import Foundation
import os

private let logger = Logger(subsystem: "umpi.voice", category: "voice")

/// Voice mode's diagnostics, in the system log (`log stream --predicate 'subsystem == "umpi.voice"'`), so they can be
/// read while the app runs normally. No transcripts: only levels, counts, timings, and decisions. Debug builds also keep
/// the latest lines in `Library/Caches/voice.log`, which can be copied off a phone with `devicectl device copy from`.
func voiceLog(_ message: String) {
    logger.notice("\(message, privacy: .public)")
    #if DEBUG
    VoiceLogFile.append(message)
    #endif
}

#if DEBUG
private enum VoiceLogFile {
    static let queue = DispatchQueue(label: "umpi.voice.log")
    static let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("voice.log")

    static func append(_ message: String) {
        let line = "\(Date().formatted(.iso8601)) \(message)\n"
        queue.async {
            // Kept small: once past 256 KB the file starts again.
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 256_000 { try? FileManager.default.removeItem(at: url) }
            if let handle = try? FileHandle(forWritingTo: url) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() }
            else { try? Data(line.utf8).write(to: url) }
        }
    }
}
#endif
