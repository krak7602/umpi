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

/// A text that is still being written: the blocks that cannot change are kept, and only its end is parsed again.
final class MarkdownGrowthTests: XCTestCase {
    private func plain(_ block: MarkdownBlock?) -> String? {
        guard case .paragraph(let text)? = block else { return nil }
        return String(text.characters)
    }
    private func links(_ block: MarkdownBlock?) -> [String] {
        guard case .paragraph(let text)? = block else { return [] }
        return text.runs.compactMap { $0.link?.absoluteString }
    }

    func testAParagraphIsPendingUntilABlankLineFollows() {
        var document = MarkdownDocument.growing("Water the ferns")
        XCTAssertEqual(document.blocks.map(\.isStable), [false])
        document = .growing("Water the ferns on Friday.", after: document)
        XCTAssertEqual(document.blocks.map(\.id), [0], "the same block, with more text")
        XCTAssertEqual(plain(document.blocks[0].content), "Water the ferns on Friday.")
        XCTAssertTrue(document.stable.isEmpty)

        let closed = MarkdownDocument.growing("Water the ferns on Friday.\n\n", after: document)
        XCTAssertEqual(closed.blocks.map(\.isStable), [true], "a blank line closes a paragraph")
        XCTAssertEqual(closed.pendingStart, closed.source.utf8.count)

        let next = MarkdownDocument.growing("Water the ferns on Friday.\n\nThen feed the cat", after: closed)
        XCTAssertEqual(next.blocks.map(\.id), [0, 1])
        XCTAssertEqual(next.blocks[0], closed.blocks[0], "a stable block is the same value in the next result")
        XCTAssertEqual(next.pendingStart, closed.source.utf8.count, "only the text after the stable part was parsed")
        XCTAssertEqual(plain(next.pending.first?.content), "Then feed the cat")
    }

    func testAFenceIsOpenUntilItClosesAndABlankLineInsideIsNoBoundary() {
        var document = MarkdownDocument.growing("Run this:\n\n```swift\nlet pots = 3")
        XCTAssertEqual(document.blocks.map(\.isStable), [true, false])
        XCTAssertTrue(document.blocks[1].hasOpenFence)
        XCTAssertEqual(document.blocks[1].content, .code(language: "swift", text: "let pots = 3"))
        let intro = document.blocks[0]

        // A blank line inside the fence, and a closing fence that is only part written.
        document = .growing(document.source + "\n\nlet trays = 2\n``", after: document)
        XCTAssertEqual(document.blocks.count, 2, "the blank line did not split the code")
        XCTAssertEqual(document.blocks[0], intro)
        XCTAssertTrue(document.blocks[1].hasOpenFence)
        XCTAssertEqual(document.blocks[1].content, .code(language: "swift", text: "let pots = 3\n\nlet trays = 2"), "the part-written closing fence is not shown as code")

        document = .growing(document.source + "`\n", after: document)
        XCTAssertFalse(document.blocks[1].hasOpenFence, "closed")
        XCTAssertFalse(document.blocks[1].isStable, "but nothing follows it yet")

        let followed = MarkdownDocument.growing(document.source + "\nDone.\n", after: document)
        XCTAssertEqual(followed.blocks.map(\.isStable), [true, true, false])
        XCTAssertEqual(followed.blocks[1].content, .code(language: "swift", text: "let pots = 3\n\nlet trays = 2"))
        XCTAssertEqual(MarkdownDocument.growing(document.source + "\n", after: document).blocks.map(\.isStable), [true, true], "a blank line after a closed fence is a boundary")
    }

    func testADiagramIsNotDrawnWhileItsFenceIsOpen() {
        let open = MarkdownDocument.growing("```mermaid\ngraph TD; A-->B")
        XCTAssertEqual(open.blocks.first?.content, .mermaid("graph TD; A-->B"))
        XCTAssertEqual(open.blocks.first?.hasOpenFence, true, "the view draws an open fence as plain code")
        let closed = MarkdownDocument.growing(open.source + "\n```\n\n", after: open)
        XCTAssertEqual(closed.blocks.map(\.hasOpenFence), [false])
        XCTAssertEqual(closed.blocks.map(\.isStable), [true])
    }

    func testAListStaysPendingWhileItCanGainItems() {
        var document = MarkdownDocument.growing("To buy:\n\n- Compost\n")
        XCTAssertEqual(document.blocks.map(\.isStable), [true, false])
        let intro = document.blocks[0]
        document = .growing(document.source + "- Twine\n", after: document)
        XCTAssertEqual(document.blocks[0], intro)
        guard case .list(false, _, let items) = document.blocks[1].content else { return XCTFail("\(document.blocks)") }
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items.map(\.line), [3, 4], "an item keeps its line in the whole text")

        document = .growing(document.source + "\n", after: document)
        XCTAssertEqual(document.blocks.map(\.isStable), [true, false], "a blank line after a list is no boundary: another item can follow")

        let followed = MarkdownDocument.growing(document.source + "Next, water them.\n", after: document)
        XCTAssertEqual(followed.blocks.map(\.isStable), [true, true, false])
        XCTAssertEqual(followed.blocks[1].content, document.blocks[1].content)
    }

    func testATableStaysPendingWhileItCanGainRows() {
        var document = MarkdownDocument.growing("Counts:\n\n| Plant | Pots |\n| --- | ---: |\n| Fern | 2 |\n")
        guard case .table(_, let rows, _) = document.blocks.last?.content else { return XCTFail("\(document.blocks)") }
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(document.blocks.map(\.isStable), [true, false])
        document = .growing(document.source + "| Moss | 5 |\n", after: document)
        guard case .table(_, let more, _) = document.blocks.last?.content else { return XCTFail("\(document.blocks)") }
        XCTAssertEqual(more.map { $0.map { String($0.characters) } }, [["Fern", "2"], ["Moss", "5"]])
        XCTAssertEqual(document.blocks.map(\.id), [0, 1])
        XCTAssertFalse(document.blocks[1].isStable)
        // A row that is only begun can read as a new paragraph; it does not close the table.
        let begun = MarkdownDocument.growing(document.source + "|", after: document)
        XCTAssertEqual(begun.stable.count, 1, "a line that is still being written closes nothing")
        guard case .table(_, let all, _) = MarkdownDocument.growing(document.source + "| Ivy | 1 |\n", after: begun).blocks.last?.content else { return XCTFail("a row") }
        XCTAssertEqual(all.count, 3)
        let followed = MarkdownDocument.growing(document.source + "\nSeven pots in all.\n", after: document)
        XCTAssertEqual(followed.blocks.map(\.isStable), [true, true, false])
    }

    func testALateReferenceDefinitionParsesTheWholeTextAgain() {
        let before = MarkdownDocument.growing("See [the guide] first.\n\nThen water the ferns.\n\n")
        XCTAssertEqual(before.blocks.map(\.isStable), [true, true])
        XCTAssertFalse(before.parsesWhole)
        XCTAssertEqual(links(before.blocks[0].content), [])

        let after = MarkdownDocument.growing(before.source + "[the guide]: https://example.org/guide\n", after: before)
        XCTAssertTrue(after.parsesWhole)
        XCTAssertEqual(links(after.blocks[0].content), ["https://example.org/guide"], "the definition gave an earlier block its link")
        XCTAssertEqual(after.blocks.map(\.content), MarkdownBlock.parse(after.source))
        XCTAssertEqual(after.blocks[0].id, before.blocks[0].id)
        XCTAssertNotEqual(after.blocks[0], before.blocks[0])
        XCTAssertTrue(MarkdownDocument.growing(after.source + "\nMore later.", after: after).parsesWhole, "and every later call does")
    }

    func testUnfinishedMarksAndLinksArePlainText() {
        XCTAssertEqual(plain(MarkdownDocument.growing("Use **two").blocks.first?.content), "Use **two")
        for text in ["Use **two bags*", "Use **two bags**"] {
            guard case .paragraph(let shown)? = MarkdownDocument.growing(text).blocks.first?.content else { return XCTFail(text) }
            XCTAssertEqual(String(shown.characters), text, "marks at the very end can be half of a longer mark")
            XCTAssertTrue(shown.runs.allSatisfy { $0.inlinePresentationIntent == nil })
        }
        guard case .paragraph(let bold)? = MarkdownDocument.growing("Use **two bags** of compost").blocks.first?.content else { return XCTFail("bold") }
        XCTAssertEqual(String(bold.characters), "Use two bags of compost")
        XCTAssertTrue(bold.runs.contains { $0.inlinePresentationIntent == .stronglyEmphasized })

        let unfinished = MarkdownDocument.growing("Read [the guide](https://example.org/gui")
        XCTAssertEqual(plain(unfinished.blocks.first?.content), "Read [the guide](https://example.org/gui")
        XCTAssertEqual(links(unfinished.blocks.first?.content), [], "half an address is not a link")
        let finished = MarkdownDocument.growing("Read [the guide](https://example.org/guide) today", after: unfinished)
        XCTAssertEqual(links(finished.blocks.first?.content), ["https://example.org/guide"])
        XCTAssertEqual(unfinished.source, "Read [the guide](https://example.org/gui", "the source is never changed")
    }

    func testGrowingInSmallStepsGivesTheBlocksOfTheWholeText() {
        let text = """
        # Garden plan

        Water the **ferns** on Friday, then read [the notes](https://example.org/notes).

        - Compost
          - two bags
        - A script:

          ```sh
          echo "pots"

          echo "trays"
          ```
        - Twine

        > [!tip] Shade
        > Keep the moss out of the sun.

        | Plant | Pots |
        | --- | ---: |
        | Fern | 2 |
        | Moss | 5 |

        ```swift
        let pots = 3

        let trays = 2
        ```

        3. Rake the leaves
        4. Sweep the path

        ---

        That is all for this week.

        """
        // One character at a time meets every half-written line; larger steps meet other cuts.
        for step in [1, 3, 7, 16] {
            var document: MarkdownDocument?
            var end = text.startIndex
            while end < text.endIndex {
                end = text.index(end, offsetBy: step, limitedBy: text.endIndex) ?? text.endIndex
                let next = MarkdownDocument.growing(String(text[..<end]), after: document)
                if let document {
                    XCTAssertEqual(Array(next.blocks.prefix(document.stable.count)), Array(document.stable), "stable blocks stay as they are")
                }
                XCTAssertEqual(next.blocks.map(\.id), Array(next.blocks.indices))
                document = next
            }
            XCTAssertEqual(document?.blocks.map(\.content), MarkdownBlock.parse(text), "in steps of \(step)")
            XCTAssertEqual(document?.parsesWhole, false)
            XCTAssertEqual(document?.blocks.contains { $0.hasOpenFence }, false)
        }
        XCTAssertEqual(MarkdownDocument.complete(text).blocks.map(\.isStable).contains(false), false)
    }
}

/// What is kept so that a text is parsed, and code coloured, once.
final class RenderCacheTests: XCTestCase {
    func testTheEntryUsedLongestAgoIsDroppedFirst() {
        let cache = RecentCache<String, Int>(limit: 3)
        for (index, key) in ["ferns", "moss", "ivy"].enumerated() { cache.set(index, for: key) }
        XCTAssertEqual(cache["ferns"], 0, "a read counts as a use")
        cache.set(3, for: "sage")
        XCTAssertEqual(cache.count, 3)
        XCTAssertNil(cache["moss"], "the one used longest ago went")
        XCTAssertEqual(cache["ferns"], 0)
        XCTAssertEqual(cache["sage"], 3)

        let sized = RecentCache<String, String>(limit: 10, costLimit: 10)
        sized.set("a", for: "first", cost: 6)
        sized.set("b", for: "second", cost: 6)
        XCTAssertNil(sized["first"], "the costs together stay within the limit")
        XCTAssertEqual(sized["second"], "b")
    }

    func testATextIsParsedOnceAndCanBePreparedOffTheMainActor() async {
        let text = "## Seed order \(UUID().uuidString)\n\n- Basil\n- Dill"
        XCTAssertFalse(MarkdownCache.has(text))
        let document = MarkdownCache.document(text)
        XCTAssertEqual(document.blocks.map(\.content), MarkdownBlock.parse(text))
        XCTAssertEqual(document.blocks.map(\.id), [0, 1])
        XCTAssertEqual(MarkdownCache.cached(text), document)

        let later = "Prune the roses \(UUID().uuidString)"
        await MarkdownCache.prepare([text, later])
        XCTAssertEqual(MarkdownCache.cached(later)?.blocks.count, 1)
    }

    func testCodeIsColoredOffTheMainActorAndKept() async {
        let code = "let pots = \(Int.random(in: 100...999)) // counted"
        XCTAssertNil(SyntaxHighlighter.shared.cached(code, language: "swift"), "plain until it is colored")
        let colored = await SyntaxHighlighter.shared.highlighted(code, language: "swift")
        XCTAssertEqual(String(colored.characters), code)
        XCTAssertGreaterThan(colored.runs.filter { $0.foregroundColor != nil }.count, 1)
        XCTAssertEqual(SyntaxHighlighter.shared.cached(code, language: "swift"), colored)
    }

    func testALongBlockWithoutALanguageIsDetectedFromItsStart() {
        let line = "func water(_ plant: String, pots: Int) -> Bool { return pots > 0 } // every Friday\n"
        let code = String(repeating: line, count: 60)
        let sample = SyntaxHighlighter.sample(code)
        XCTAssertLessThanOrEqual(sample.count, SyntaxHighlighter.detectionSample)
        XCTAssertTrue(code.hasPrefix(sample + "\n"), "whole lines from the start")
        XCTAssertEqual(SyntaxHighlighter.sample("let pots = 3\nlet trays = 2"), "let pots = 3\nlet trays = 2", "short code is read whole")
        let colored = SyntaxHighlighter.shared.highlight(code, language: nil)
        XCTAssertEqual(String(colored.characters), code)
        XCTAssertGreaterThan(colored.runs.filter { $0.foregroundColor != nil }.count, 60, "the language found in the sample colors every line")
    }
}

/// The rows the chat draws: derived once for each change, the newest shown first.
@MainActor
final class ChatListTests: XCTestCase {
    private func entry(_ seq: Int, role: String = "umpi", at: String = "2026-11-03T10:00:00Z") -> ChatEntry {
        ChatEntry(seq: seq, id: "e\(seq)", at: at, role: role, surface: "app", kind: role == "owner" ? "text" : "reply", text: "t\(seq)")
    }

    func testRowsAreDerivedOnlyWhenSomethingChanged() throws {
        let list = ChatList()
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-03T12:00:00Z"))
        let entries = [entry(1), entry(2, at: "2026-11-03T10:03:00Z"), entry(3, role: "owner", at: "2026-11-03T10:30:00Z")]
        let first = list.derive(entries: entries, revision: 1, sent: [], pending: [], device: "device-1", now: now)
        _ = list.derive(entries: entries, revision: 1, sent: [], pending: [], device: "device-1", now: now.addingTimeInterval(30))
        XCTAssertEqual(list.derivations, 1, "a drawing with nothing changed derives nothing")
        XCTAssertEqual(first.rows.map(\.id), ["e1", "e2", "e3"])
        XCTAssertEqual(first.rows.map { $0.header != nil }, [true, false, true], "a time starts the conversation and each new stretch")
        XCTAssertEqual(first.rows.map(\.divider), [false, true, false], "a line parts two of Umpi's messages with no time between")
        XCTAssertEqual(first.rows.map(\.isFirst), [true, false, false])
        XCTAssertEqual(first.rows[2].header, ChatView.timeHeader(entries[2], after: entries[1]))

        let message = MessageRequest(id: "local-1", text: "Water the ferns", sentAt: "2026-11-03T11:59:00Z")
        let sending = list.derive(entries: entries, revision: 1, sent: [], pending: [(message, false)], device: "device-1", now: now)
        XCTAssertEqual(list.derivations, 2)
        XCTAssertEqual(sending.rows.last?.id, "local-1")
        XCTAssertEqual(sending.waiting, 1)

        let sent = CompanionStore.SentMessage(message: message, operationID: "op-1", at: now)
        let delivered = list.derive(entries: entries, revision: 1, sent: [sent], pending: [], device: "device-1", now: now)
        XCTAssertEqual(delivered.rows.last?.status, .delivered)
        _ = list.derive(entries: entries, revision: 1, sent: [sent], pending: [], device: "device-1", now: now.addingTimeInterval(60))
        XCTAssertEqual(list.derivations, 3)
        let expired = list.derive(entries: entries, revision: 1, sent: [sent], pending: [], device: "device-1", now: now.addingTimeInterval(121))
        XCTAssertEqual(list.derivations, 4, "a sent message's two minutes ran out")
        XCTAssertEqual(expired.rows.map(\.id), ["e1", "e2", "e3"])
        XCTAssertEqual(expired.waiting, 0)

        _ = list.derive(entries: entries + [entry(4)], revision: 2, sent: [sent], pending: [], device: "device-1", now: now.addingTimeInterval(122))
        XCTAssertEqual(list.derivations, 5, "the entries changed")
    }

    func testTheNewestRowsShowFirstAndOlderOnesJoinInSteps() {
        let rows = ChatView.rows(entries: (101...200).map { entry($0) }, sent: [], pending: [])
        var window = ChatRowWindow()
        XCTAssertEqual(window.start(in: rows), 100 - ChatRowWindow.first)
        XCTAssertEqual(window.hidden, 70)

        // A new message adds to the rows that show; none leaves at the top.
        let grown = rows + ChatView.rows(entries: [entry(201)], sent: [], pending: [])
        XCTAssertEqual(window.start(in: grown), 70)
        XCTAssertEqual(window.count, 31)

        XCTAssertEqual(window.showEarlier(in: grown)?.id, "e171", "the row that was the oldest shown, to keep in place")
        XCTAssertEqual(window.start(in: grown), 70 - ChatRowWindow.more)
        XCTAssertNotNil(window.showEarlier(in: grown))
        XCTAssertNotNil(window.showEarlier(in: grown))
        XCTAssertEqual(window.hidden, 0)
        XCTAssertNil(window.showEarlier(in: grown), "every row shows")

        // A page of older messages that the owner asked for shows whole.
        var asked = ChatRowWindow()
        _ = asked.start(in: rows)
        asked.showAll()
        let page = ChatView.rows(entries: (51...100).map { entry($0) }, sent: [], pending: [])
        asked.loaded()
        XCTAssertEqual(asked.start(in: page + rows), 0)
        XCTAssertEqual(asked.oldest, "e51")
        // After that the rows that show start at the same row again.
        let older = ChatView.rows(entries: (41...50).map { entry($0) }, sent: [], pending: [])
        XCTAssertEqual(asked.start(in: older + page + rows), 10)
    }

    func testTheRowsThatShowKeepTheirNumberWhenTheOldestIsGone() {
        let rows = ChatView.rows(entries: (1...50).map { entry($0) }, sent: [], pending: [])
        var window = ChatRowWindow()
        XCTAssertEqual(window.start(in: rows), 20)
        _ = window.showEarlier(in: rows)
        XCTAssertEqual(window.count, 50)
        let without = rows.filter { $0.id != "e1" }
        XCTAssertEqual(window.start(in: without), 0, "the same number of rows shows")
        XCTAssertEqual(window.start(in: []), 0)
    }

    func testOnlyAMessageThatCarriedMediaLooksForPreviews() {
        var message = entry(1, role: "owner")
        XCTAssertFalse(message.showsMedia)
        message.images = 2
        XCTAssertEqual(message.mediaKind, "photos")
        XCTAssertTrue(message.showsMedia)
        message.images = nil; message.kind = "voice"
        XCTAssertFalse(message.showsMedia, "a voice note shows as its transcript")
        message.media = MediaInfo(kind: "video", seconds: 12)
        XCTAssertTrue(message.showsMedia)
        XCTAssertNil(LocalMedia.shown("no-such-message-\(UUID().uuidString)"))
    }

    func testAModelDoesNoWorkUntilItsEntriesAreRead() async throws {
        let model = ChatModel()
        XCTAssertFalse(model.hasRestored)
        XCTAssertEqual(model.revision, 0)
        _ = model.entries
        for _ in 0..<100 where !model.hasRestored { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(model.hasRestored, "the first read restores the saved copy")
        XCTAssertEqual(model.entries.isEmpty, model.revision == 0, "restoring is one change of the entries, or none")
    }
}

/// A clock the test moves.
@MainActor private final class TestClock {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
}

/// A reply that grows while it is written: the socket's `reply` frames, shown until the finished entry arrives.
@MainActor
final class LiveReplyTests: XCTestCase {
    private func say(_ words: String, operation: String = "op-1", part: Int = 0) -> LiveReplies.Frame {
        .init(type: "reply", operationId: operation, part: part, text: words)
    }
    private func plain(_ reply: LiveReplies.Reply?) -> [String] {
        (reply?.document.blocks ?? []).map { block in
            if case .paragraph(let text) = block.content { return String(text.characters) }
            if case .code(_, let code) = block.content { return code }
            return "?"
        }
    }

    func testPartsJoinWithABlankLineAndFramesAreShownTogether() {
        let clock = TestClock()
        let live = LiveReplies(now: { clock.now })
        live.receive(say("Let me look "))
        XCTAssertEqual(live.showings, 1, "the first text shows at once")
        XCTAssertEqual(live.writing, ["op-1"])
        live.receive(say("at the "))
        live.receive(say("seed list."))
        XCTAssertEqual(live.showings, 1, "frames inside a tenth of a second wait")
        XCTAssertEqual(plain(live.shown["op-1"]), ["Let me look"])

        clock.now += LiveReplies.showInterval
        live.receive(say("You have basil", part: 1))
        XCTAssertEqual(live.showings, 2)
        XCTAssertEqual(live.shown["op-1"]?.document.source, "Let me look at the seed list.\n\nYou have basil")
        XCTAssertEqual(plain(live.shown["op-1"]), ["Let me look at the seed list.", "You have basil"], "a new part is a new paragraph")
        XCTAssertEqual(live.shown["op-1"]?.document.blocks.map(\.isStable), [true, false], "only the end is parsed again")
        XCTAssertEqual(live.writing, ["op-1"], "the row list changes when a reply starts, not as it grows")

        live.receive(say(" and dill.", part: 1))
        live.show()
        XCTAssertEqual(plain(live.shown["op-1"]), ["Let me look at the seed list.", "You have basil and dill."])
    }

    func testAToolShowsAStatusOnlyAfterSomeText() {
        let clock = TestClock()
        let live = LiveReplies(now: { clock.now })
        live.receive(.init(type: "reply", operationId: "op-1", part: 0, working: "web_search"))
        live.show()
        XCTAssertTrue(live.writing.isEmpty, "no text yet: the chat keeps its thinking mark")
        XCTAssertNil(live.shown["op-1"])

        live.receive(say("I will check the forecast."))
        live.receive(.init(type: "reply", operationId: "op-1", part: 0, working: "web_search"))
        live.show()
        XCTAssertEqual(live.shown["op-1"]?.status, "Searching the web…")
        live.receive(.init(type: "reply", operationId: "op-1", part: 0, working: "an_unlisted_tool"))
        live.show()
        XCTAssertEqual(live.shown["op-1"]?.status, "Working…")

        live.receive(say("Rain on Friday.", part: 1))
        live.show()
        XCTAssertNil(live.shown["op-1"]?.status, "text after the tool ends the status")
        live.receive(.init(type: "reply", operationId: "op-1", part: 1, working: "read_calendar"))
        live.receive(.init(type: "reply", operationId: "op-1", done: true))
        live.show()
        XCTAssertNil(live.shown["op-1"]?.status, "the end of the reply ends it too")
        XCTAssertEqual(live.writing, ["op-1"], "what was shown stays until the entry arrives")
    }

    func testAnOpenFenceIsMarkedUntilItCloses() {
        let live = LiveReplies()
        live.receive(say("Run:\n\n```sh\necho pots"))
        live.show()
        XCTAssertEqual(live.shown["op-1"]?.document.blocks.last?.hasOpenFence, true)
        live.receive(say("\n```\n\nDone.\n"))
        live.show()
        XCTAssertEqual(live.shown["op-1"]?.document.blocks.map(\.hasOpenFence), [false, false, false])
    }

    func testOnlyReplyFramesShowAndAnyOperationMayShow() {
        let live = LiveReplies()
        live.receive(.init(type: "speech", operationId: "op-voice", part: 0, text: "Read aloud, not shown."))
        live.receive(.init(type: "chat", latest: 9))
        live.receive(.init(type: "reply", part: 0, text: "No operation."))
        live.receive(.init(type: "reply", operationId: "op-empty"))
        live.show()
        XCTAssertTrue(live.writing.isEmpty)
        XCTAssertTrue(live.shown.isEmpty)

        // A reply to a message this app did not send shows the same way.
        live.receive(say("Sent from the other device.", operation: "op-elsewhere"))
        live.show()
        XCTAssertEqual(live.writing, ["op-elsewhere"])
    }

    func testAReplyWithNoFrameForTwoMinutesIsRemoved() {
        let clock = TestClock()
        let live = LiveReplies(now: { clock.now })
        live.receive(say("Half a rep"))
        clock.now += 60
        live.receive(say("Another one", operation: "op-2"))
        clock.now += LiveReplies.quietLimit - 61
        live.prune()
        XCTAssertEqual(live.writing, ["op-1", "op-2"], "a dropped socket removes nothing before the two minutes")
        clock.now += 1
        live.prune()
        XCTAssertEqual(live.writing, ["op-2"])
        XCTAssertNil(live.shown["op-1"])
        clock.now += 60
        live.prune()
        XCTAssertTrue(live.writing.isEmpty)
        live.receive(say("ly."))
        live.show()
        XCTAssertEqual(plain(live.shown["op-1"]), ["ly."], "a frame after that starts the reply again; the entry will replace it")
    }

    func testTheFinishedEntryTakesTheRowOfTheReplyBeingWritten() throws {
        let model = ChatModel()
        let list = ChatList()
        let question = ChatEntry(seq: 1, id: "owner:op-1", at: "2026-11-03T10:00:00Z", role: "owner", surface: "app", kind: "text", text: "Which seeds do I have?", operationId: "op-1")
        model.setEntries([question])
        XCTAssertEqual(model.receive(socketText: #"{"type":"reply","operationId":"op-1","part":0,"text":"You have basil"}"#), .none)
        XCTAssertEqual(model.live.writing, ["op-1"])

        let writing = list.derive(entries: model.entries, revision: model.revision, sent: [], pending: [], device: "device-1", writing: model.live.writing, began: model.live.began)
        XCTAssertEqual(writing.rows.map(\.id), ["owner:op-1", "umpi:answer:op-1"])
        XCTAssertEqual(writing.rows.last?.status, .writing)
        XCTAssertEqual(writing.rows.last?.entry.operationId, "op-1")
        _ = model.receive(socketText: #"{"type":"reply","operationId":"op-1","part":0,"text":" and dill."}"#)
        model.live.show()
        _ = list.derive(entries: model.entries, revision: model.revision, sent: [], pending: [], device: "device-1", writing: model.live.writing, began: model.live.began)
        XCTAssertEqual(list.derivations, 1, "text that grows derives no rows again")
        XCTAssertFalse(list.takeReplacedWriting())

        let answer = ChatEntry(seq: 2, id: "umpi:answer:op-1", at: "2026-11-03T10:00:20Z", role: "umpi", surface: "app", kind: "reply", text: "You have basil and dill.", operationId: "op-1")
        model.setEntries([question, answer])
        XCTAssertTrue(model.live.writing.isEmpty, "the entry removes the reply that was being written, in the same change")
        XCTAssertNil(model.live.shown["op-1"])
        let finished = list.derive(entries: model.entries, revision: model.revision, sent: [], pending: [], device: "device-1", writing: model.live.writing, began: model.live.began)
        XCTAssertEqual(finished.rows.map(\.id), ["owner:op-1", "umpi:answer:op-1"], "the same row, now the entry")
        XCTAssertEqual(finished.rows.last?.status, .logged)
        XCTAssertTrue(list.takeReplacedWriting())

        // Frames that come late show nothing.
        XCTAssertEqual(model.receive(socketText: #"{"type":"reply","operationId":"op-1","part":0,"text":" More."}"#), .none)
        model.live.receive(.init(type: "reply", operationId: "op-1", part: 0, text: " More."))
        model.live.show()
        XCTAssertTrue(model.live.writing.isEmpty)
        // An entry that is in the rows already is never doubled by a row for its reply.
        XCTAssertEqual(ChatView.rows(entries: [question, answer], sent: [], pending: [], writing: ["op-1"]).map(\.id), ["owner:op-1", "umpi:answer:op-1"])
    }

    func testTheSocketsOtherFramesKeepTheirMeaning() {
        let model = ChatModel()
        model.setEntries([ChatEntry(seq: 4, id: "e4", at: "2026-11-03T10:00:00Z", role: "umpi", surface: "app", kind: "reply", text: "t4")])
        XCTAssertEqual(model.receive(socketText: #"{"type":"chat","latest":5}"#), .new)
        XCTAssertEqual(model.receive(socketText: #"{"type":"chat","latest":4}"#), .changed)
        XCTAssertEqual(model.receive(socketText: #"{"type":"speech","operationId":"op-9","part":0,"text":"Spoken words."}"#), .none)
        XCTAssertEqual(model.receive(socketText: #"{"type":"speech","operationId":"op-9","done":true}"#), .none)
        XCTAssertEqual(model.receive(socketText: "not json"), .none)
        model.live.show()
        XCTAssertTrue(model.live.writing.isEmpty, "a spoken reply is voice mode's; the chat does not show it growing")
    }
}

/// UI blocks on a chat entry, and the saved copy of the conversation.
final class ChatEntryBlockTests: XCTestCase {
    func testAnEntryCarriesItsBlocksAndOneWithoutHasNone() throws {
        let json = #"{"entries":[{"seq":7,"id":"umpi:answer:op-7","at":"2026-11-03T10:00:00.000Z","role":"umpi","surface":"app","kind":"reply","text":"Two trains fit.","operationId":"op-7","ui":[{"type":"card","title":"Trains to the coast","children":[{"type":"stat","label":"Fare","value":"420"},{"type":"hologram","depth":3}]},{"type":"button","label":"Book the early one","action":"send"}]},{"seq":8,"id":"umpi:answer:op-8","at":"2026-11-03T10:01:00.000Z","role":"umpi","surface":"app","kind":"reply","text":"Done."}],"latest":8,"more":false}"#
        let page = try JSONDecoder().decode(ChatPage.self, from: Data(json.utf8))
        let blocks = try XCTUnwrap(page.entries[0].ui)
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(UIProps(blocks[0])?.text("title"), "Trains to the coast")
        XCTAssertEqual(UIProps(blocks[0])?.children.map(\.type), ["stat", "hologram"], "a component this build does not know is kept and draws nothing")
        XCTAssertEqual(UIProps(blocks[1])?.text("action"), "send")
        XCTAssertNil(page.entries[1].ui, "an entry without blocks has no ui")

        var same = page.entries[0]
        XCTAssertEqual(same, page.entries[0])
        same.ui = [blocks[0]]
        XCTAssertNotEqual(same, page.entries[0], "a reply whose blocks changed is not the same entry")
        XCTAssertFalse(String(data: try JSONEncoder().encode(page.entries[1]), encoding: .utf8)?.contains("\"ui\"") ?? true)
    }

    private func copy(queue: DispatchQueue = DispatchQueue(label: "test.chat.save")) -> (ChatSavedCopy, URL) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("chat-copy-\(UUID().uuidString).json")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return (ChatSavedCopy(url: url, queue: queue), url)
    }
    private func entry(_ seq: Int, ui: [JSONValue]? = nil) -> ChatEntry {
        ChatEntry(seq: seq, id: "e\(seq)", at: "2026-11-03T10:00:00Z", role: "umpi", surface: "app", kind: "reply", text: "t\(seq)", ui: ui)
    }

    func testTheSavedCopyKeepsBlocksAndTheNewestHundred() {
        let (saved, _) = copy()
        let block = JSONValue.object(["type": .string("badge"), "label": .string("Ripe")])
        saved.write((1...120).map { entry($0, ui: $0 == 120 ? [block] : nil) })
        saved.flush()
        let read = saved.read()
        XCTAssertEqual(read.map(\.seq), Array(21...120))
        XCTAssertEqual(read.last?.ui, [block])
        XCTAssertNil(read.first?.ui)
    }

    func testAWriteQueuedBeforeADisconnectDoesNotBringTheCopyBack() {
        let queue = DispatchQueue(label: "test.chat.save.held")
        let (saved, url) = copy(queue: queue)
        saved.write([entry(1)])
        saved.flush()
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))

        // The write waits in the queue when the disconnect removes the copy.
        queue.suspend()
        saved.write([entry(1), entry(2)])
        saved.remove()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        queue.resume()
        saved.flush()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "the queued write did nothing")
        XCTAssertEqual(saved.read(), [])

        // A new pairing saves again.
        saved.write([entry(3)])
        saved.flush()
        XCTAssertEqual(saved.read().map(\.seq), [3])
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
