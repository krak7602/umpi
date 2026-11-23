import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import Umpi

@MainActor
final class ChatTests: XCTestCase {
    private func entry(_ seq: Int, role: String, surface: String = "app", operation: String? = nil, at: String = "2026-11-03T10:00:00.000Z") -> ChatEntry {
        ChatEntry(seq: seq, id: "e\(seq)", at: at, role: role, surface: surface, kind: role == "owner" ? "text" : "reply", text: "t\(seq)", operationId: operation)
    }

    func testAMemoryReviewDecodesWithItsChangedLinesAndSaysWhatBecameOfIt() throws {
        let json = #"{"reviews":[{"id":"r1","kind":"update","status":"pending","topic":"Preferences","source":"Topics/Example.md","category":"preferences","reason":"You asked for examples.","before":"Use short summaries.","after":"Prefer examples.","changes":[{"op":"remove","text":"Use short summaries."},{"op":"add","text":"Prefer examples."}],"createdAt":"2026-11-03T10:00:00.000Z","entry":"umpi:memory:review:r1"},{"id":"r2","kind":"restore","status":"stale","topic":"Routine","source":"Topics/Example.md","category":"routines","reason":"","before":"a","after":"b","changes":null,"createdAt":"2026-11-02T10:00:00.000Z","decidedAt":"2026-11-02T11:00:00.000Z","entry":"umpi:memory:review:r2"}]}"#
        struct List: Decodable { var reviews: [MemoryReview] }
        let reviews = try JSONDecoder().decode(List.self, from: Data(json.utf8)).reviews
        XCTAssertEqual(reviews[0].changes?.map(\.op), ["remove", "add"])
        XCTAssertTrue(reviews[0].pending)
        XCTAssertEqual(reviews[0].headline, "Update “Preferences”")
        XCTAssertNil(reviews[1].changes, "a topic too long to compare has no changed lines")
        XCTAssertFalse(reviews[1].pending)
        XCTAssertEqual(reviews[1].headline, "Restore “Routine”")
        XCTAssertTrue(reviews[1].outcome.hasPrefix("Out of date"))
    }

    func testDecodesTheCoordinatorsPage() throws {
        let json = #"{"entries":[{"seq":3,"id":"umpi:approval:j:1","at":"2026-11-03T10:00:00.123Z","role":"umpi","surface":"telegram","kind":"message","text":"Approve?","buttons":[[{"label":"Approve","data":"job:a"}]]}],"latest":3,"more":false}"#
        let page = try JSONDecoder().decode(ChatPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.entries.first?.buttons?.first?.first?.label, "Approve")
        XCTAssertNotNil(page.entries.first?.date)
        XCTAssertFalse(page.entries[0].fromOwner)
    }

    func testTimeHeadersStartNewStretches() {
        let now = Date()
        let iso = { (date: Date) in date.formatted(.iso8601) }
        let first = ChatEntry(seq: 1, id: "a", at: iso(now.addingTimeInterval(-3_600)), role: "umpi", surface: "telegram", kind: "message", text: "a")
        let close = ChatEntry(seq: 2, id: "b", at: iso(now.addingTimeInterval(-3_300)), role: "umpi", surface: "telegram", kind: "message", text: "b")
        let later = ChatEntry(seq: 3, id: "c", at: iso(now), role: "umpi", surface: "telegram", kind: "message", text: "c")
        XCTAssertNotNil(ChatView.timeHeader(first, after: nil))
        XCTAssertNil(ChatView.timeHeader(close, after: first), "five minutes later continues the stretch")
        XCTAssertEqual(ChatView.timeHeader(later, after: close)?.hasPrefix("Today"), Calendar.current.isDateInToday(now))
    }

    func testMergeKeepsOrderAndReplacesBySequence() {
        let merged = ChatModel.merge([entry(1, role: "owner"), entry(3, role: "umpi")], [entry(2, role: "umpi"), entry(3, role: "umpi")])
        XCTAssertEqual(merged.map(\.seq), [1, 2, 3])
    }

    func testASentMessageKeepsItsRowFromSendingToTheLog() {
        let message = MessageRequest(id: "local-1", text: "Hello", sentAt: "2026-11-07T10:00:00Z")
        let earlier = [entry(1, role: "umpi")]
        let now = Date()

        let sending = ChatView.rows(entries: earlier, sent: [], pending: [(message, false)], now: now)
        XCTAssertEqual(sending.map(\.id), ["e1", "local-1"])
        XCTAssertEqual(sending.last?.status, .sending)
        XCTAssertEqual(sending.last?.entry.text, "Hello")
        XCTAssertTrue(sending.last?.entry.fromOwner ?? false)

        // Accepted, but the chat has not read it back yet: still shown, under the same identity.
        let sent = CompanionStore.SentMessage(message: message, operationID: "op-1", at: now)
        let delivered = ChatView.rows(entries: earlier, sent: [sent], pending: [], now: now)
        XCTAssertEqual(delivered.map(\.id), ["e1", "local-1"])
        XCTAssertEqual(delivered.last?.status, .delivered)

        // Its entry arrives and takes the same row.
        let logged = ChatView.rows(entries: earlier + [entry(2, role: "owner", operation: "op-1")], sent: [sent], pending: [], now: now)
        XCTAssertEqual(logged.map(\.id), ["e1", "local-1"])
        XCTAssertEqual(logged.last?.status, .logged)
        XCTAssertEqual(logged.last?.entry.seq, 2)

        // One the log never shows (such as a command) stops being shown after two minutes.
        XCTAssertEqual(ChatView.rows(entries: earlier, sent: [sent], pending: [], now: now.addingTimeInterval(121)).map(\.id), ["e1"])
        // A failed one stays, marked.
        XCTAssertEqual(ChatView.rows(entries: earlier, sent: [], pending: [(message, true)], now: now).last?.status, .failed)
    }

    func testTheAppWorksOutItsMessagesOperationAsTheWorkerDoes() {
        // From Node: "message:telegram:app:" + sha256(JSON.stringify(["device-1","local-1"])).
        XCTAssertEqual(CompanionStore.appOperation(device: "device-1", message: "local-1"),
                       "message:telegram:app:fc60f0d526b50212876669004e7a45c598a2e803651dafe37bf84b62245da6be")
        XCTAssertNil(CompanionStore.appOperation(device: "", message: "local-1"))
    }

    func testAnEntryThatArrivesWhileSendingTakesTheMessagesRow() throws {
        let message = MessageRequest(id: "local-1", text: "Hello", sentAt: "2026-11-07T10:00:00Z")
        let operation = try XCTUnwrap(CompanionStore.appOperation(device: "device-1", message: "local-1"))
        // The coordinator logged it and the socket brought it, but the send has not returned yet.
        let rows = ChatView.rows(entries: [entry(1, role: "umpi"), entry(2, role: "owner", operation: operation)], sent: [],
                                 pending: [(message, false)], device: "device-1")
        XCTAssertEqual(rows.map(\.id), ["e1", "local-1"], "one row for the message, never two")
        XCTAssertEqual(rows.last?.status, .logged)
        XCTAssertEqual(rows.last?.entry.seq, 2)
    }

    func testThinkingUntilTheReplyToTheSameMessageArrives() throws {
        let model = ChatModel()
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-03T10:01:00Z"))
        XCTAssertFalse(model.isThinking(now: now))
        XCTAssertTrue(model.isThinking(now: now, pending: 1), "a message still in the outbox counts as waiting")
    }
}

final class MarkdownTests: XCTestCase {
    func testParsesTheBlocksClaudeWrites() {
        let blocks = MarkdownBlock.parse("""
        # Plan
        Some **bold** and `code`.

        | Item | Cost |
        | --- | ---: |
        | Eggs | 720 |

        - [x] Done
        - [ ] Open

        1. First
        2. Second

        > Quoted

        ```swift
        let x = 1
        ```

        ---
        """)
        guard blocks.count == 8 else { return XCTFail("got \(blocks.count) blocks: \(blocks)") }
        if case .heading(let level, _) = blocks[0] { XCTAssertEqual(level, 1) } else { XCTFail("heading") }
        if case .table(let header, let rows, let alignments) = blocks[2] {
            XCTAssertEqual(header.map { String($0.characters) }, ["Item", "Cost"])
            XCTAssertEqual(rows.first.map { $0.map { String($0.characters) } }, ["Eggs", "720"])
            XCTAssertEqual(alignments.last ?? nil, .trailing)
        } else { XCTFail("table") }
        if case .list(false, _, let items) = blocks[3] { XCTAssertEqual(items.map(\.checkbox), [true, false]) } else { XCTFail("checklist") }
        if case .list(true, let start, let items) = blocks[4] { XCTAssertEqual(start, 1); XCTAssertEqual(items.count, 2) } else { XCTFail("ordered") }
        if case .code(let language, let text) = blocks[6] { XCTAssertEqual(language, "swift"); XCTAssertEqual(text, "let x = 1") } else { XCTFail("code") }
        XCTAssertEqual(blocks[7], .rule)
    }
}

final class MarkdownAddressTests: XCTestCase {
    func testPlainWebAddressesBecomeLinks() {
        let blocks = MarkdownBlock.parse("""
        Pages:

        - https://tickets.example/harbour-screens/2026-12-18 (Umpi wrote this address)

        See https://example.org/guide_(draft), then [the list](https://example.org/list). No link in example.org alone.
        """)
        guard blocks.count == 3, case .list(_, _, let items) = blocks[1], case .paragraph(let text) = blocks[2] else { return XCTFail("got \(blocks)") }
        func links(_ text: AttributedString) -> [String: String] {
            Dictionary(text.runs.compactMap { run in run.link.map { (String(text[run.range].characters), $0.absoluteString) } }, uniquingKeysWith: { first, _ in first })
        }
        guard case .paragraph(let item)? = items.first?.blocks.first else { return XCTFail("list item") }
        XCTAssertEqual(links(item), ["https://tickets.example/harbour-screens/2026-12-18": "https://tickets.example/harbour-screens/2026-12-18"], "the note after the address is not part of the link")
        XCTAssertEqual(links(text), [
            "https://example.org/guide_(draft)": "https://example.org/guide_(draft)",
            "the list": "https://example.org/list",
        ], "a bracket the address opened belongs to it; the comma after it does not")
    }
}

final class ObsidianMarkdownTests: XCTestCase {
    func testCalloutsMermaidHighlightsAndWikiLinks() {
        let blocks = MarkdownBlock.parse("""
        > [!warning] Retest in February
        > Fast for 10–12 hours.

        ```mermaid
        graph TD; A-->B
        ```

        See ==this== and [[Health|my health note]].
        """)
        guard blocks.count == 3 else { return XCTFail("got \(blocks)") }
        if case .callout(let kind, let title, let inner) = blocks[0] {
            XCTAssertEqual(kind, .warning); XCTAssertEqual(title, "Retest in February"); XCTAssertEqual(inner.count, 1)
        } else { XCTFail("callout") }
        XCTAssertEqual(blocks[1], .mermaid("graph TD; A-->B"))
        if case .paragraph(let text) = blocks[2] { XCTAssertEqual(String(text.characters), "See this and my health note.") } else { XCTFail("paragraph") }
    }
}

@MainActor
final class SyntaxHighlightTests: XCTestCase {
    func testHighlightJSOutputBecomesColoredText() {
        let text = SyntaxHighlighter.attributed(#"<span class="hljs-keyword">let</span> x = <span class="hljs-string">&quot;a &amp; b&quot;</span>"#)
        XCTAssertEqual(String(text.characters), #"let x = "a & b""#)
        XCTAssertNotNil(text.runs.first?.foregroundColor, "the keyword is colored")
    }
    func testBundledHighlighterColorsSwift() {
        let text = SyntaxHighlighter.shared.highlight("let value = 42 // answer", language: "swift")
        XCTAssertEqual(String(text.characters), "let value = 42 // answer")
        XCTAssertGreaterThan(text.runs.filter { $0.foregroundColor != nil }.count, 1, "keywords, numbers, and comments get colors")
    }
}

final class NoteMarkupTests: XCTestCase {
    func testCommentsAreHiddenAndPlanMarksBecomeTags() {
        let blocks = MarkdownBlock.parse("- [target] 06:30 workout <!-- umpi-plan:routine -->\n- [ ] Buy oats <!--\nnote -->")
        guard case .list(_, _, let items) = blocks.first, items.count == 2, case .paragraph(let first) = items[0].blocks.first else { return XCTFail("\(blocks)") }
        XCTAssertEqual(items[0].mark, "Target", "the plan mark replaces the bullet")
        XCTAssertEqual(String(first.characters), "06:30 workout")
        XCTAssertNil(items[1].mark)
        XCTAssertEqual(items[1].line, 2, "line numbers still match the note")
        guard case .paragraph(let plain) = MarkdownBlock.parse("[tentative] Lunch")[0] else { return XCTFail("paragraph") }
        XCTAssertEqual(String(plain.characters), "Tentative Lunch", "outside a list the mark stays an inline tag")
        XCTAssertEqual(MarkdownBlock.withoutComments("a <!-- x\ny --> b\nc"), "a\n b\nc")
        guard case .list(_, _, let tasks) = MarkdownBlock.parse("## Tasks\n- [ ] \n- [ ] Real task\n- [x] ")[1] else { return XCTFail("tasks") }
        XCTAssertEqual(tasks.count, 1, "blank template items are not shown")
        XCTAssertEqual(tasks.first?.line, 3)
        // With a plan marker in the note, comments are removed and the blank item loses its trailing space, so it no
        // longer parses as a checkbox; it is still left out.
        guard case .list(_, _, let marked) = MarkdownBlock.parse("## Tasks\n\n- [ ] \n\n- [ ] Ask <!-- umpi-plan:a -->")[1] else { return XCTFail("marked tasks") }
        XCTAssertEqual(marked.count, 1)
        XCTAssertEqual(marked.first?.checkbox, false)
    }
}

/// Set when something observed changes, which is when SwiftUI would draw again.
private final class Redraw: @unchecked Sendable { var asked = false }

private struct FieldHost: View {
    let draft: ChatDraft
    let placeholder: String
    var body: some View {
        ComposerTextView(draft: draft, revision: draft.revision, focused: draft.focused, placeholder: placeholder) { _ in }
    }
}

@MainActor
final class ComposerTests: XCTestCase {
    private func watch(_ draft: ChatDraft) -> Redraw {
        let redraw = Redraw()
        withObservationTracking { _ = (draft.isEmpty, draft.hasWords, draft.revision, draft.focused) } onChange: { redraw.asked = true }
        return redraw
    }
    /// Shows the field in the test host's window and returns its container.
    private func show(_ draft: ChatDraft) async throws -> (UIHostingController<FieldHost>, ComposerField) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: FieldHost(draft: draft, placeholder: "Message"))
        window.rootViewController = host
        window.makeKeyAndVisible()
        addTeardownBlock { @MainActor in window.isHidden = true }
        try await Task.sleep(for: .milliseconds(300))
        func find(_ view: UIView) -> ComposerField? { view as? ComposerField ?? view.subviews.lazy.compactMap(find).first }
        return (host, try XCTUnwrap(find(window)))
    }

    func testTypingRedrawsNothingUntilTheComposerMustChange() {
        let draft = ChatDraft()
        var redraw = watch(draft)
        draft.typed("W")
        XCTAssertEqual(draft.text, "W", "the draft has the text at once")
        XCTAssertTrue(redraw.asked, "the first character brings the send button")
        XCTAssertTrue(draft.hasWords)

        redraw = watch(draft)
        for text in ["Wa", "Water", "Water the ferns", "Water the ferns\non Friday"] {
            draft.typed(text)
            XCTAssertEqual(draft.text, text)
        }
        draft.focused = false
        XCTAssertFalse(redraw.asked, "more text, and focus that does not change, draw nothing again")
        XCTAssertEqual(draft.revision, 0, "typing is not the app replacing the text")
        XCTAssertEqual(draft.edits, 5)

        draft.set("")
        XCTAssertTrue(redraw.asked)
        XCTAssertEqual(draft.revision, 1)
        XCTAssertTrue(draft.isEmpty)
        XCTAssertFalse(draft.hasWords)

        draft.typed("  \n ")
        XCTAssertFalse(draft.isEmpty)
        XCTAssertFalse(draft.hasWords, "spaces and line breaks alone cannot be sent")
    }

    func testTheFieldKeepsABurstOfTextAndTakesOnlyWhatTheAppSets() async throws {
        let draft = ChatDraft()
        let (host, field) = try await show(draft)
        let view = field.textView

        // A burst, such as dictation or a paste in pieces: all of it arrives before SwiftUI runs again.
        for piece in ["Buy ", "two bags ", "of compost"] { view.insertText(piece) }
        XCTAssertEqual(draft.text, "Buy two bags of compost", "the draft is never older than the field")

        // SwiftUI updates the field for another reason. It has no older text to write back.
        host.rootView = FieldHost(draft: draft, placeholder: "Message Umpi")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(view.text, "Buy two bags of compost")

        // The app replaces the text; the field takes it once.
        draft.set("Remind me ")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(view.text, "Remind me ")
        view.insertText("to prune the roses")
        host.rootView = FieldHost(draft: draft, placeholder: "Message")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(view.text, "Remind me to prune the roses", "a later update does not bring the set text back")
        XCTAssertEqual(draft.text, view.text)
    }

    func testTypingWithinALineAsksForNoNewSize() async throws {
        let (_, field) = try await show(ChatDraft())
        let view = field.textView
        let height = field.bounds.height
        let asked = field.sizeRequests

        for character in "Feed the cat at six" { view.insertText(String(character)) }
        XCTAssertEqual(field.sizeRequests, asked, "SwiftUI is not asked to lay out again while the height stays")

        view.insertText("\nand again at nine")
        XCTAssertGreaterThan(field.sizeRequests, asked, "a new line needs a taller field")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertGreaterThan(field.bounds.height, height)
    }
}
