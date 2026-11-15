import Foundation
import Observation

/// The owner's speech words: names and terms speech recognition gets wrong, written the way the owner spells them.
/// The coordinator keeps the list (Umpi can change it too); the app keeps a copy, so voice mode works offline, and gives
/// it to Phonon-2's word spotter and to Apple's recognizer. The list starts empty.
@MainActor @Observable final class SpeechWords {
    static let shared = SpeechWords()

    private(set) var words: [String]
    private(set) var version: Int
    /// The last change or refresh failed; the copy shown may be out of date.
    private(set) var problem: String?

    /// The same limits as the coordinator's.
    static let maxWords = 100
    static let maxLength = 48

    private nonisolated static let wordsKey = "speech.words", versionKey = "speech.wordsVersion"

    /// The copy on this device, for code off the main actor (Apple's recognizer starts on the audio thread).
    nonisolated static var cached: [String] { UserDefaults.standard.stringArray(forKey: wordsKey) ?? [] }

    private init() {
        words = Self.cached
        version = UserDefaults.standard.integer(forKey: Self.versionKey)
    }

    private struct List: Codable { var words: [String]; var version: Int }

    /// Fetches the list from the coordinator; keeps the copy when it cannot.
    func refresh(_ store: CompanionStore) async {
        guard let transport = store.chatTransport else { apply(); return }
        do {
            let data = try await transport.send(path: "/api/device/speech-words", method: "GET", body: nil)
            keep(try JSONDecoder().decode(List.self, from: data))
            problem = nil
        } catch { apply() }
    }

    /// Adds a word, cleaned the way the coordinator cleans it. False when it is empty, too long, or already there.
    @discardableResult
    func add(_ word: String, _ store: CompanionStore) async -> Bool {
        // Never fetched on this device: the list may already hold words, from Umpi or another device.
        if version == 0 { await refresh(store) }
        let word = Self.clean(word)
        guard !word.isEmpty, word.count <= Self.maxLength, !words.contains(where: { $0.caseInsensitiveCompare(word) == .orderedSame }) else { return false }
        guard words.count < Self.maxWords else { problem = "At most \(Self.maxWords) words; remove some first."; return false }
        return await save(words + [word], store)
    }

    func remove(_ word: String, _ store: CompanionStore) async {
        _ = await save(words.filter { $0 != word }, store)
    }

    static func clean(_ word: String) -> String {
        word.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// The whole list, against the version this device last saw; another change since (from Umpi or another device)
    /// is fetched instead, and the owner tries again.
    private func save(_ next: [String], _ store: CompanionStore) async -> Bool {
        struct Change: Encodable { var expectedVersion: Int; var words: [String] }
        guard let transport = store.chatTransport, let body = try? JSONEncoder().encode(Change(expectedVersion: version, words: next)) else {
            problem = "Not connected to Umpi."; return false
        }
        do {
            let data = try await transport.send(path: "/api/device/speech-words", method: "PUT", body: body)
            keep(try JSONDecoder().decode(List.self, from: data))
            problem = nil
            return true
        } catch {
            await refresh(store)
            problem = (error as? LocalizedError)?.errorDescription ?? "The words could not be saved."
            return false
        }
    }

    private func keep(_ list: List) {
        words = list.words
        version = list.version
        UserDefaults.standard.set(list.words, forKey: Self.wordsKey)
        UserDefaults.standard.set(list.version, forKey: Self.versionKey)
        apply()
    }

    /// Gives the words to Phonon-2 when it is in use.
    private func apply() {
        let words = words
        Task { await PhononTranscriber.shared.use(words: VoiceSettings.shared.usesPhonon ? words : []) }
    }
}
