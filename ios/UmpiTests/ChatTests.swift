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
