import os

private let logger = Logger(subsystem: "umpi.voice", category: "voice")

/// Voice mode's diagnostics, in the system log (`log stream --predicate 'subsystem == "umpi.voice"'`), so they can be
/// read while the app runs normally. No transcripts: only levels, counts, and decisions.
func voiceLog(_ message: String) {
    logger.notice("\(message, privacy: .public)")
}
