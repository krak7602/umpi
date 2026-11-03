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

    func testMergeKeepsOrderAndReplacesBySequence() {
        let merged = ChatModel.merge([entry(1, role: "owner"), entry(3, role: "umpi")], [entry(2, role: "umpi"), entry(3, role: "umpi")])
        XCTAssertEqual(merged.map(\.seq), [1, 2, 3])
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
        XCTAssertEqual(String(first.characters), "Target 06:30 workout")
        XCTAssertEqual(items[1].line, 2, "line numbers still match the note")
        XCTAssertEqual(MarkdownBlock.withoutComments("a <!-- x\ny --> b\nc"), "a\n b\nc")
        guard case .list(_, _, let tasks) = MarkdownBlock.parse("## Tasks\n- [ ] \n- [ ] Real task\n- [x] ")[1] else { return XCTFail("tasks") }
        XCTAssertEqual(tasks.count, 1, "blank template items are not shown")
        XCTAssertEqual(tasks.first?.line, 3)
    }
}
