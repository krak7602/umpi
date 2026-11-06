import AVFoundation
import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#endif

/// Voice mode's spoken conversation with the same Umpi: hands-free turns, Umpi's reply read aloud as it is written,
/// and cutting in by talking. Every turn is an ordinary message in the shared chat.
@MainActor @Observable
final class VoiceConversation {
    enum Phase: Equatable {
        case starting, listening, hearing, thinking, working(String), speaking, paused
        case failed(String)
    }

    private(set) var phase = Phase.starting
    /// 0…1: the owner's voice while listening, Umpi's while speaking.
    /// 0…1: the owner's voice while listening, Umpi's while speaking. Not observed: the orb reads it every frame, so a
    /// level change (dozens a second) does not redraw the whole screen.
    @ObservationIgnored private(set) var level: Float = 0
    /// The owner's words while they talk; Umpi's sentence while it speaks.
    private(set) var caption = ""
    private(set) var captionIsOwner = true
    /// The current reply put something in the chat to be seen, such as a table or a link.
    private(set) var showsInChat = false
    var muted = false { didSet { audio.muted = muted } }

    private let audio = VoiceAudio()
    private let speaker: VoiceSpeaker
    private let settings = VoiceSettings.shared
    private weak var store: CompanionStore?
    private var socketTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .ephemeral)

    /// The reply being spoken, by its operation.
    private var reply: Reply?
    /// Frames for an operation this phone has not heard back about yet.
    private var early: [String: [Frame]] = [:]
    /// What the owner said in the current turn.
    private var words = ""
    private var turn = 0
    private var finalWaiter: Task<Void, Never>?
    /// Phonon-2 is writing out the turn: Apple's final words do not send it early.
    private var transcribing = false
    /// The ended turn's audio, until it is sent.
    private var turnAudio: TurnAudio?
    /// A turn that ended but was not sent yet when the owner carried on talking: the next turn continues it.
    private var carried: (words: String, audio: TurnAudio?)?
    /// The reply the owner just talked over, sent with the next message.
    private var interrupted: (id: String, heard: String)?
    private var started = false
    /// A message is on its way; talking over the wait for it cuts off its reply once its operation is known.
    private var sending = false
    private var cutWhileSending = false
    /// The last owner turn the recognizer gave final words for.
    private var finalTurn = 0

    private final class Reply {
        let id: String
        var part = 0
        var pendingText = ""
        var heard = ""
        var done = false
        var spokeAnything = false
        var filter = SpokenFilter()
        var finished = false
        init(id: String) { self.id = id }
    }

    struct Frame: Decodable {
        var type: String
        var operationId: String?
        var part: Int?
        var text: String?
        var working: String?
        var done: Bool?
        var latest: Int?
    }

    init() {
        speaker = VoiceSpeaker(audio: audio)
        audio.onEvent = { [weak self] event in Task { @MainActor in self?.handle(event) } }
        speaker.onEvent = { [weak self] event in Task { @MainActor in self?.handle(event) } }
    }

    // MARK: Start and stop

    func start(_ store: CompanionStore) async {
        guard !started else { return }
        started = true
        self.store = store
        // Opened from the widget or a control, the app may still be coming to the front; iOS refuses the microphone
        // until it is.
        #if os(iOS)
        for _ in 0..<30 where UIApplication.shared.applicationState != .active { try? await Task.sleep(for: .milliseconds(100)) }
        #endif
        if let problem = await VoiceAudio.permissions() { phase = .failed(problem); return }
        applySettings()
        do { try audio.start() } catch { phase = .failed("The microphone could not start: \(error.localizedDescription)"); return }
        socketTask = Task { await stayConnected() }
        listen()
    }

    func stop() {
        guard started else { return }
        started = false
        carried = nil
        finalWaiter?.cancel(); transcribing = false
        socketTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        speaker.stop()
        audio.stop()
        // A reply still being written ends in the chat as usual.
        reply = nil
        phase = .paused
    }

    /// Told to Umpi with words the owner said just before leaving the app.
    static let leftNote = "The owner said this in the app's voice mode and left the app before hearing a reply. Handle it, and reply in writing for the chat; an idea, task, or anything with a time is filed as usual."

    /// The owner left the app. Words not yet sent (mid-sentence, or in the pause before sending) go through the chat's
    /// outbox, which keeps them on the phone until they are delivered, and Umpi answers in the chat. A message already
    /// sent is answered on the coordinator as usual.
    func leaving() async {
        guard started else { return }
        if phase == .hearing || finalWaiter != nil {
            finalWaiter?.cancel(); finalWaiter = nil; transcribing = false
            // Still taking the recognizer's words for this turn.
            phase = .hearing
            let turn = self.turn
            audio.endTurn()
            // The recognizer's final words, briefly; otherwise what it had heard so far.
            for _ in 0..<8 where finalTurn < turn { try? await Task.sleep(for: .milliseconds(100)) }
            let text = Self.join(carried?.words, words).trimmingCharacters(in: .whitespacesAndNewlines)
            carried = nil
            words = ""
            if text.count >= 2, let store {
                voiceLog("left the app mid-turn; sending what was heard through the outbox")
                await store.sendChat(text: text, voice: true, context: Self.leftNote, media: MediaInfo(kind: "voice"))
            }
        }
        stop()
    }

    /// Pause and resume, from the button: nothing is heard while paused.
    func togglePause() {
        if phase == .paused { audio.ensureRunning(); listen() }
        else { stopReply(note: false); audio.mode = .off; phase = .paused; caption = "" }
    }

    /// The orb was tapped: send now while talking, or stop Umpi while it speaks.
    func tapped() {
        switch phase {
        case .hearing: finishTurn(audio: nil)   // The audio stays on the audio thread: the recognizer's words are sent.
        case .speaking, .thinking, .working: stopReply(note: true); listen()
        case .paused: togglePause()
        default: break
        }
    }

    func applySettings() {
        audio.pause = settings.pause
        audio.cutIn = settings.cutIn
        // The natural voice once its files are on the phone; until then the iOS voice, while they download.
        let kokoro = settings.kokoroVoice
        speaker.voice = .init(identifier: settings.voice?.identifier, rate: Float(settings.rate), pitch: VoiceSettings.cleanPitch(settings.pitch),
                              kokoro: KokoroVoice.downloaded ? kokoro : nil, kokoroSpeed: settings.kokoroSpeed)
        if kokoro != nil { Task { try? await KokoroVoice.shared.prepare(); if KokoroVoice.downloaded, settings.kokoroVoice == kokoro { speaker.voice.kokoro = kokoro } } }
        // Loaded in the background; until it is ready, turns use Apple's words.
        if settings.usesPhonon, PhononTranscriber.downloaded { Task { try? await PhononTranscriber.shared.prepare() } }
    }

    func returnedToApp() { if started { audio.ensureRunning() } }

    private func listen() {
        carried = nil
        words = ""
        caption = ""
        audio.mode = .waiting
        phase = .listening
    }

    // MARK: Events

    private func handle(_ event: VoiceAudio.Event) {
        guard started else { return }
        switch event {
        case .level(let value):
            level = value
        case .started(let cutIn):
            if cutIn {
                // The owner talked over Umpi: stop it and remember what was heard.
                if reply == nil && sending { cutWhileSending = true }
                stopReply(note: true)
                #if os(iOS)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                #endif
            }
            if finalWaiter != nil {
                // The turn ended but is not sent yet, and the owner carried on: one message, not two.
                carried = (Self.join(carried?.words, words), turnAudio)
                voiceLog("carried on talking before the turn was sent; joining the two")
            }
            finalWaiter?.cancel(); transcribing = false
            words = ""
            caption = carried?.words ?? ""
            captionIsOwner = true
            showsInChat = false
            phase = .hearing
        case .words(let text, let final, let turn):
            guard phase == .hearing || phase == .thinking && finalWaiter != nil else { break }
            if !text.isEmpty { words = text; if phase == .hearing { caption = Self.join(carried?.words, text); captionIsOwner = true } }
            if final { finalTurn = turn }
            if final, self.turn == turn, finalWaiter != nil, !transcribing { finalWaiter?.cancel(); finalWaiter = nil; send() }
            self.turn = turn
        case .ended(let turn, let audio):
            self.turn = turn
            finishTurn(audio: audio)
        case .maybeCutIn, .notCutIn:
            // Umpi keeps talking at full volume until words confirm the owner is cutting in.
            break
        case .failed(let message):
            phase = .failed(message)
        }
    }

    private func handle(_ event: VoiceSpeaker.Event) {
        guard started, let reply else { return }
        switch event {
        case .started(let sentence):
            phase = .speaking
            caption = sentence
            captionIsOwner = false
        case .heard(let sentence):
            reply.heard += (reply.heard.isEmpty ? "" : " ") + sentence
        case .idle:
            if reply.done { finishReply() }
        }
    }

    // MARK: The owner's turn

    /// The owner stopped talking. With Phonon-2 ready, its transcript of the turn's audio is sent (Apple's words if it
    /// fails or takes over 4 s); otherwise the recognizer's final words, waited for briefly.
    private func finishTurn(audio ended: TurnAudio?) {
        var turnAudio = ended
        if let carried {
            words = Self.join(carried.words, words)
            // Phonon-2 writes out both parts only when it has the audio of both.
            turnAudio = carried.audio != nil && ended != nil ? TurnAudio.joined(carried.audio, ended) : nil
            self.carried = nil
        }
        self.turnAudio = turnAudio
        audio.mode = .replying
        phase = .thinking
        caption = words
        finalWaiter?.cancel()
        transcribing = false
        if settings.usesPhonon, let turnAudio {
            transcribing = true
            finalWaiter = Task { [weak self] in
                let text = await withTaskGroup(of: String?.self) { group in
                    group.addTask { await PhononTranscriber.shared.transcribe(turnAudio) }
                    group.addTask { try? await Task.sleep(for: .seconds(4)); return nil }
                    let first = await group.next() ?? nil
                    group.cancelAll()
                    return first
                }
                guard let self, !Task.isCancelled else { return }
                self.transcribing = false
                self.finalWaiter = nil
                if let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { self.words = text; self.caption = text }
                else { voiceLog("phonon gave nothing in time; sending the recognizer's words") }
                self.send()
            }
            return
        }
        finalWaiter = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(900))
            guard let self, !Task.isCancelled else { return }
            self.finalWaiter = nil
            self.send()
        }
    }

    #if DEBUG
    /// Sends `text` as if it had been heard, for checking the reply path where there is no speech recognition.
    func sendForTesting(_ text: String) {
        stopReply(note: true)
        words = text
        caption = text
        captionIsOwner = true
        audio.mode = .replying
        send()
    }
    #endif

    nonisolated static func join(_ first: String?, _ second: String) -> String {
        [first ?? "", second].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    private func send() {
        turnAudio = nil
        let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
        // Too short to be a request, such as a cough: listen again.
        guard text.count >= 2, let transport = store?.chatTransport else {
            voiceLog("nothing to send (\(text.count) characters heard); listening again")
            listen(); return
        }
        voiceLog("sending \(text.split(separator: " ").count) words")
        words = ""
        let cut = interrupted
        interrupted = nil
        phase = .thinking
        sending = true
        cutWhileSending = false
        // A few seconds from iOS to finish sending if the owner leaves the app right now.
        #if os(iOS)
        let background = UIApplication.shared.beginBackgroundTask(withName: "voice message")
        #endif
        Task {
            #if os(iOS)
            defer { sending = false; UIApplication.shared.endBackgroundTask(background) }
            #else
            defer { sending = false }
            #endif
            struct Body: Encodable { var id: String; var text: String; var sentAt: String; var voice = true; var spoken = true; var interrupts: String?; var heard: String? }
            let body = Body(id: UUID().uuidString, text: text, sentAt: ISO8601DateFormatter().string(from: Date()), interrupts: cut?.id, heard: cut.map { String($0.heard.prefix(16_000)) })
            do {
                let data = try await transport.send(path: "/api/device/messages", method: "POST", body: JSONEncoder().encode(body))
                let operation = try JSONDecoder().decode(Operation.self, from: data)
                guard started else { return }
                if cutWhileSending { cutWhileSending = false; interrupted = (operation.id, ""); early.removeValue(forKey: operation.id); return }
                let reply = Reply(id: operation.id)
                self.reply = reply
                for frame in early.removeValue(forKey: operation.id) ?? [] { apply(frame, to: reply) }
                early.removeAll()
            } catch {
                phase = .failed((error as? LocalizedError)?.errorDescription ?? "Umpi could not be reached.")
                try? await Task.sleep(for: .seconds(2))
                if started, case .failed = phase { listen() }
            }
        }
    }

    // MARK: Umpi's reply

    private func receive(_ frame: Frame) {
        guard frame.type == "speech", let id = frame.operationId else { return }
        if let reply, reply.id == id { apply(frame, to: reply) }
        else if reply == nil || reply?.finished == true { early[id, default: []].append(frame) }
    }

    private func apply(_ frame: Frame, to reply: Reply) {
        guard !reply.finished else { return }
        if let part = frame.part, part != reply.part {
            // A new message of the answer, such as after a tool: finish the last sentence first.
            flush(reply, all: true)
            reply.part = part
        }
        if let text = frame.text {
            // What Umpi shows in the chat is not read aloud.
            reply.pendingText += reply.filter.feed(text)
            if reply.filter.sawShown { showsInChat = true }
            flush(reply, all: false)
        }
        if let tool = frame.working, phase != .speaking { phase = .working(Self.describe(tool)) }
        if frame.done == true {
            reply.done = true
            reply.pendingText += reply.filter.feed("", end: true)
            flush(reply, all: true)
            if !reply.spokeAnything { Task { await speakFromChat(reply) } }
            else if !speaker.isBusy { finishReply() }
        }
    }

    /// Speaks every whole sentence written so far; `all` also speaks an unfinished one.
    private func flush(_ reply: Reply, all: Bool) {
        let (sentences, rest) = Self.sentences(reply.pendingText, all: all)
        reply.pendingText = rest
        for sentence in sentences {
            let spoken = Self.speakable(sentence)
            guard !spoken.isEmpty else { continue }
            reply.spokeAnything = true
            speaker.say(spoken)
        }
    }

    /// The relay could not watch this reply (or the coordinator restarted): read the finished reply from the chat.
    private func speakFromChat(_ reply: Reply) async {
        guard let transport = store?.chatTransport else { finishReply(); return }
        for _ in 0..<20 {
            if let data = try? await transport.send(path: "/api/device/chat?limit=10", method: "GET", body: nil),
               let page = try? JSONDecoder().decode(ChatPage.self, from: data),
               let entry = page.entries.first(where: { $0.id == "umpi:answer:\(reply.id)" }) {
                guard self.reply === reply, !reply.spokeAnything else { return }
                reply.pendingText = Self.spokenLead(entry.text)
                if reply.pendingText != entry.text.trimmingCharacters(in: .whitespacesAndNewlines) { showsInChat = true }
                flush(reply, all: true)
                if !reply.spokeAnything { finishReply() }
                return
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        if self.reply === reply { finishReply() }
    }

    private func finishReply() {
        guard let reply, !reply.finished else { return }
        reply.finished = true
        self.reply = nil
        audio.replyEnded()
        if phase != .paused, phase != .hearing { listen() }
    }

    /// Stops Umpi's reply; with `note`, the next message tells Umpi where the owner cut it off.
    private func stopReply(note: Bool) {
        finalWaiter?.cancel(); finalWaiter = nil; transcribing = false
        let wasSpeaking = speaker.isBusy
        speaker.stop()
        guard let reply, !reply.finished else { return }
        reply.finished = true
        // Only a reply not yet heard in full was cut off.
        if note, !reply.done || wasSpeaking || !reply.pendingText.isEmpty { interrupted = (reply.id, reply.heard) }
        self.reply = nil
    }

    // MARK: The socket

    private func stayConnected() async {
        var delay: UInt64 = 1
        while !Task.isCancelled {
            guard let request = store?.chatSocketRequest() else { return }
            let task = session.webSocketTask(with: request)
            socket = task
            task.resume()
            do {
                while !Task.isCancelled {
                    let message = try await task.receive()
                    delay = 1
                    if case .string(let text) = message, let data = text.data(using: .utf8), let frame = try? JSONDecoder().decode(Frame.self, from: data) { receive(frame) }
                }
            } catch {}
            task.cancel(with: .goingAway, reason: nil)
            try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            delay = min(delay * 2, 8)
        }
    }

    // MARK: Text

    /// Whole sentences, and what is left; a long run without an end is split at a comma or space.
    nonisolated static func sentences(_ text: String, all: Bool) -> ([String], String) {
        var sentences: [String] = []
        var current = ""
        let characters = Array(text)
        var i = 0
        while i < characters.count {
            let c = characters[i]
            current.append(c)
            let next = i + 1 < characters.count ? characters[i + 1] : nil
            let ends = (".!?…".contains(c) && (next == nil ? false : next!.isWhitespace || next == "\"" || next == ")")) || c == "\n"
            if ends {
                // Keep closing quotes or brackets with the sentence.
                while i + 1 < characters.count, "\")'”’".contains(characters[i + 1]) { i += 1; current.append(characters[i]) }
                if !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sentences.append(current.trimmingCharacters(in: .whitespacesAndNewlines)) }
                current = ""
            } else if current.count > 220, let cut = current.lastIndex(where: { $0 == "," || $0 == ";" || $0 == " " }) {
                sentences.append(String(current[...cut]).trimmingCharacters(in: .whitespacesAndNewlines))
                current = String(current[current.index(after: cut)...])
            }
            i += 1
        }
        if all, !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sentences.append(current.trimmingCharacters(in: .whitespacesAndNewlines)); current = "" }
        return (sentences, current)
    }

    /// The chat's copy of a reply has no tags; its spoken part is what comes before the first table, code, list, or link.
    nonisolated static func spokenLead(_ text: String) -> String {
        var kept: [Substring] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("|") || trimmed.hasPrefix("```") || trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("#")
                || trimmed.range(of: #"^\d+\. "#, options: .regularExpression) != nil || trimmed.contains("://") { break }
            kept.append(line)
        }
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// What to say aloud: Markdown marks and links are not read out.
    nonisolated static func speakable(_ sentence: String) -> String {
        var text = sentence
        text = text.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"https?://\S+"#, with: "the link", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(^|\s)(#{1,6}|[-*•]|\d+\.)\s+"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"[*_`~>|]"#, with: "", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// What Umpi is doing, from the tool it started.
    nonisolated static func describe(_ tool: String) -> String {
        let name = tool.lowercased()
        let labels: [(String, String)] = [("calendar", "Checking your calendar"), ("mail", "Looking through your mail"), ("reminder", "Checking reminders"),
            ("web", "Searching the web"), ("search_history", "Remembering"), ("history", "Remembering"), ("note", "Reading your notes"), ("vault", "Reading your notes"),
            ("today", "Reading today's note"), ("t3", "Checking your coding sessions"), ("coding", "Working on code"), ("browser", "Using the browser"),
            ("decide", "Sorting through it"), ("extract", "Sorting through it"), ("memory", "Remembering"), ("job", "Working on your Mac")]
        return labels.first { name.contains($0.0) }?.1 ?? "Working on it"
    }
}

/// Leaves out what Umpi puts between <chat> and </chat>: it is shown in the chat, never read aloud. Tags can arrive
/// split across frames, so a possible start of one is held until the next text.
struct SpokenFilter {
    static let open = "<chat>", close = "</chat>"
    private(set) var inShown = false
    private(set) var sawShown = false
    private var carry = ""

    mutating func feed(_ text: String, end: Bool = false) -> String {
        var input = carry + text
        carry = ""
        var spoken = ""
        while !input.isEmpty {
            let tag = inShown ? Self.close : Self.open
            if let found = input.range(of: tag) {
                if !inShown { spoken += input[..<found.lowerBound] }
                input = String(input[found.upperBound...])
                inShown.toggle()
                if inShown { sawShown = true }
                continue
            }
            let held = end ? 0 : Self.partialTag(at: input, tag)
            if !inShown { spoken += input.dropLast(held) }
            carry = String(input.suffix(held))
            input = ""
        }
        return spoken
    }

    /// How many characters at the end of `text` could be the start of `tag`.
    private static func partialTag(at text: String, _ tag: String) -> Int {
        for length in stride(from: min(tag.count - 1, text.count), through: 1, by: -1) where text.hasSuffix(tag.prefix(length)) { return length }
        return 0
    }
}
