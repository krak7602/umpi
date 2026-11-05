import Foundation
import XCTest
@testable import Umpi

final class VoiceTests: XCTestCase {
    func testSpeaksWholeSentencesAndKeepsTheRest() {
        let (first, rest) = VoiceConversation.sentences("It's sunny. Take a jacket for tonight, though. It might", all: false)
        XCTAssertEqual(first, ["It's sunny.", "Take a jacket for tonight, though."])
        XCTAssertEqual(rest.trimmingCharacters(in: .whitespaces), "It might")
        let (end, left) = VoiceConversation.sentences(rest + " rain.", all: true)
        XCTAssertEqual(end, ["It might rain."])
        XCTAssertEqual(left, "")
    }

    func testASentenceEndNeedsWhatFollowsSoNumbersAndQuotesStayWhole() {
        XCTAssertEqual(VoiceConversation.sentences("It costs 3.50 today", all: false).0, [], "a decimal point is not an end")
        XCTAssertEqual(VoiceConversation.sentences("She said \"go.\" Then left", all: false).0, ["She said \"go.\""])
        XCTAssertEqual(VoiceConversation.sentences("Wait!", all: false).0, [], "the last sentence waits for more text, or the end")
        XCTAssertEqual(VoiceConversation.sentences("Line one\nLine two", all: false).0, ["Line one"])
    }

    func testAVeryLongSentenceIsSplitSoSpeechStartsSooner() {
        let long = String(repeating: "word, ", count: 60)
        let (parts, rest) = VoiceConversation.sentences(long, all: false)
        XCTAssertFalse(parts.isEmpty)
        XCTAssertTrue(parts.allSatisfy { $0.count <= 230 })
        XCTAssertLessThan(rest.count, 230)
    }

    func testMarkdownAndLinksAreNotReadOut() {
        XCTAssertEqual(VoiceConversation.speakable("**Two** meetings: see [the agenda](https://example.com/a)."), "Two meetings: see the agenda.")
        XCTAssertEqual(VoiceConversation.speakable("- Buy `milk`"), "Buy milk")
        XCTAssertEqual(VoiceConversation.speakable("Details at https://example.com/x?y=1 today"), "Details at the link today")
        XCTAssertEqual(VoiceConversation.speakable("### Summary"), "Summary")
    }

    func testToolsBecomePlainWords() {
        XCTAssertEqual(VoiceConversation.describe("calendar_events"), "Checking your calendar")
        XCTAssertEqual(VoiceConversation.describe("web_search"), "Searching the web")
        XCTAssertEqual(VoiceConversation.describe("list_reminders"), "Checking reminders")
        XCTAssertEqual(VoiceConversation.describe("something_new"), "Working on it")
    }

    func testFramesDecode() throws {
        let text = try JSONDecoder().decode(VoiceConversation.Frame.self, from: Data(#"{"type":"speech","operationId":"message:telegram:app:x","part":1,"text":"Hi."}"#.utf8))
        XCTAssertEqual(text.part, 1); XCTAssertEqual(text.text, "Hi.")
        let done = try JSONDecoder().decode(VoiceConversation.Frame.self, from: Data(#"{"type":"speech","operationId":"x","done":true}"#.utf8))
        XCTAssertEqual(done.done, true)
        let chat = try JSONDecoder().decode(VoiceConversation.Frame.self, from: Data(#"{"type":"chat","latest":12}"#.utf8))
        XCTAssertEqual(chat.latest, 12)
    }

    func testWhatIsShownInTheChatIsNotSpokenEvenWhenItsTagsAreSplit() {
        var filter = SpokenFilter()
        var spoken = ""
        for piece in ["Plan B is cheaper. The numbers are in the chat.\n<ch", "at>\n| Plan | Cost |\n|---|---|\n| B | 10 |\n</c", "hat> Anything else?"] {
            spoken += filter.feed(piece)
        }
        spoken += filter.feed("", end: true)
        XCTAssertEqual(spoken, "Plan B is cheaper. The numbers are in the chat.\n Anything else?")
        XCTAssertTrue(filter.sawShown)
        var plain = SpokenFilter()
        XCTAssertEqual(plain.feed("Costs < 5 dollars"), "Costs < 5 dollars", "a lone < is not held forever")
        XCTAssertEqual(plain.feed("x <", end: false), "x ", "a possible tag start waits for the next text")
        XCTAssertEqual(plain.feed("", end: true), "<")
    }

    func testTheChatsCopySpeaksOnlyItsLead() {
        XCTAssertEqual(VoiceConversation.spokenLead("Plan B is cheaper.\n\n| Plan | Cost |\n|---|---|"), "Plan B is cheaper.")
        XCTAssertEqual(VoiceConversation.spokenLead("Here it is:\nhttps://example.com"), "Here it is:")
        XCTAssertEqual(VoiceConversation.spokenLead("Just talking."), "Just talking.")
    }
}
