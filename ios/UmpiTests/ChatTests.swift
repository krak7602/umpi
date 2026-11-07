import Foundation
import XCTest
@testable import Umpi

@MainActor
final class ChatTests: XCTestCase {
    private func entry(_ seq: Int, role: String, surface: String = "app", operation: String? = nil, at: String = "2026-11-03T10:00:00.000Z") -> ChatEntry {
        ChatEntry(seq: seq, id: "e\(seq)", at: at, role: role, surface: surface, kind: role == "owner" ? "text" : "reply", text: "t\(seq)", operationId: operation)
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
