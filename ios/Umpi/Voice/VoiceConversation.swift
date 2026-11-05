import AVFoundation
import Foundation
import Observation
import UIKit

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
    private(set) var level: Float = 0
    /// The owner's words while they talk; Umpi's sentence while it speaks.
    private(set) var caption = ""
    private(set) var captionIsOwner = true
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
    /// The reply the owner just talked over, sent with the next message.
    private var interrupted: (id: String, heard: String)?
    private var started = false
    /// A message is on its way; talking over the wait for it cuts off its reply once its operation is known.
    private var sending = false
    private var cutWhileSending = false

    private final class Reply {
        let id: String
        var part = 0
        var pendingText = ""
        var heard = ""
        var done = false
        var spokeAnything = false
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
        for _ in 0..<30 where UIApplication.shared.applicationState != .active { try? await Task.sleep(for: .milliseconds(100)) }
        if let problem = await VoiceAudio.permissions() { phase = .failed(problem); return }
        applySettings()
        do { try audio.start() } catch { phase = .failed("The microphone could not start: \(error.localizedDescription)"); return }
        socketTask = Task { await stayConnected() }
        listen()
    }

    func stop() {
        guard started else { return }
        started = false
        finalWaiter?.cancel()
        socketTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        speaker.stop()
        audio.stop()
        // A reply still being written ends in the chat as usual.
        reply = nil
        phase = .paused
    }

    /// Pause and resume, from the button: nothing is heard while paused.
    func togglePause() {
        if phase == .paused { audio.ensureRunning(); listen() }
        else { stopReply(note: false); audio.mode = .off; phase = .paused; caption = "" }
    }

    /// The orb was tapped: send now while talking, or stop Umpi while it speaks.
    func tapped() {
        switch phase {
        case .hearing: finishTurn()
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
    }

    func returnedToApp() { if started { audio.ensureRunning() } }

    private func listen() {
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
            level = level * 0.6 + value * 0.4
        case .started(let cutIn):
            if cutIn {
                // The owner talked over Umpi: stop it and remember what was heard.
                if reply == nil && sending { cutWhileSending = true }
                stopReply(note: true)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            finalWaiter?.cancel()
            words = ""
            caption = ""
            captionIsOwner = true
            phase = .hearing
        case .words(let text, let final, let turn):
            guard phase == .hearing || phase == .thinking && finalWaiter != nil else { break }
            if !text.isEmpty { words = text; if phase == .hearing { caption = text; captionIsOwner = true } }
            if final, self.turn == turn, finalWaiter != nil { finalWaiter?.cancel(); finalWaiter = nil; send() }
            self.turn = turn
        case .ended(let turn):
            self.turn = turn
            finishTurn()
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

    /// The owner stopped talking: wait briefly for the recognizer's final words, then send.
    private func finishTurn() {
        audio.mode = .replying
        phase = .thinking
        caption = words
        finalWaiter?.cancel()
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

    private func send() {
        let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
        // Too short to be a request, such as a cough: listen again.
        guard text.count >= 2, let transport = store?.chatTransport else { listen(); return }
        words = ""
        let cut = interrupted
        interrupted = nil
        phase = .thinking
        sending = true
        cutWhileSending = false
        Task {
            defer { sending = false }
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
            reply.pendingText += text
            flush(reply, all: false)
        }
        if let tool = frame.working, phase != .speaking { phase = .working(Self.describe(tool)) }
        if frame.done == true {
            reply.done = true
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
                reply.pendingText = entry.text
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
        finalWaiter?.cancel(); finalWaiter = nil
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
