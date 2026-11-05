import AppKit
import Carbon.HIToolbox
import XCTest

final class ShortcutTests: XCTestCase {
    func testDefaultsShowAsTheMacWritesThem() {
        XCTAssertEqual(Shortcut.chatDefault.display, "⌥Space")
        XCTAssertEqual(Shortcut.voiceDefault.display, "⌥⇧Space")
    }

    func testModifiersAreShownInTheMacOrder() {
        let shortcut = Shortcut(keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(cmdKey | shiftKey | optionKey | controlKey))
        XCTAssertEqual(shortcut.display, "⌃⌥⇧⌘K")
    }

    func testTheDisplayedFormReadsBack() {
        for text in ["⌥Space", "⌥⇧Space", "⌃⌥⇧⌘K", "⌘/", "⌃F5", "F13", "⌥↑"] {
            XCTAssertEqual(Shortcut(text)?.display, text, text)
        }
        XCTAssertEqual(Shortcut("⌥space"), Shortcut.chatDefault, "key names are read without regard to case")
        XCTAssertEqual(Shortcut("⇧⌥Space"), Shortcut.voiceDefault, "modifiers may come in any order")
    }

    func testAShortcutNeedsControlOptionOrCommandUnlessItIsAFunctionKey() {
        XCTAssertNil(Shortcut("K"))
        XCTAssertNil(Shortcut("⇧K"), "Shift alone would take a typed capital from every app")
        XCTAssertNotNil(Shortcut("⌃K"))
        XCTAssertNotNil(Shortcut("F6"))
        XCTAssertNil(Shortcut("⌥Escape"), "Escape is kept for cancelling")
        XCTAssertNil(Shortcut("⌥Banana"))
        XCTAssertNil(Shortcut(""))
    }

    func testRecordedKeysBecomeCarbonModifiers() {
        let recorded = Shortcut(keyCode: UInt16(kVK_Space), flags: [.option, .shift, .capsLock])
        XCTAssertEqual(recorded, Shortcut.voiceDefault, "Caps Lock and other flags are ignored")
        XCTAssertNil(Shortcut(keyCode: UInt16(kVK_ANSI_A), flags: [.shift]))
        XCTAssertEqual(Shortcut.voiceDefault.eventModifiers, [.option, .shift])
    }

    func testMenusShowLettersDigitsAndSpaceOnly() {
        XCTAssertEqual(Shortcut.chatDefault.menuCharacter, " ")
        XCTAssertEqual(Shortcut("⌘K")?.menuCharacter, "k")
        XCTAssertNil(Shortcut("⌘F5")?.menuCharacter)
        XCTAssertNil(Shortcut("⌘/")?.menuCharacter)
    }

    func testSettingsKeepTheDisplayedFormAndAnEmptyValueTurnsAShortcutOff() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "umpi.shortcut.tests.\(UUID().uuidString)"))
        XCTAssertEqual(ShortcutSettings.shortcut(for: .chat, in: defaults), .chatDefault, "nothing saved yet: the default")
        ShortcutSettings.set(Shortcut("⌃⌥U"), for: .voice, in: defaults)
        XCTAssertEqual(defaults.string(forKey: "shortcut.voice"), "⌃⌥U")
        XCTAssertEqual(ShortcutSettings.shortcut(for: .voice, in: defaults)?.display, "⌃⌥U")
        ShortcutSettings.set(nil, for: .chat, in: defaults)
        XCTAssertNil(ShortcutSettings.shortcut(for: .chat, in: defaults))
    }
}

final class ChatNoticeTests: XCTestCase {
    private struct Entry { var seq: Int; var role: String; var id: String }

    private func fresh(_ entries: [Entry], after baseline: Int) -> [Int] {
        ChatNotices.fresh(entries, after: baseline, seq: \.seq, role: \.role, id: \.id).map(\.seq)
    }

    func testOnlyUmpisNewMessagesAreAnnounced() {
        let entries = [Entry(seq: 4, role: "umpi", id: "umpi:a"), Entry(seq: 6, role: "owner", id: "owner:b"),
                       Entry(seq: 7, role: "umpi", id: "umpi:answer:b"), Entry(seq: 5, role: "umpi", id: "umpi:c")]
        XCTAssertEqual(fresh(entries, after: 4), [5, 7], "after the baseline, oldest first, never the owner's")
        XCTAssertEqual(fresh(entries, after: 7), [])
    }

    func testAnApprovalsOutcomeNoteIsNotAnnounced() {
        let entries = [Entry(seq: 9, role: "umpi", id: "umpi:t3-request:r1:outcome"), Entry(seq: 10, role: "umpi", id: "umpi:t3-request:r1")]
        XCTAssertEqual(fresh(entries, after: 0), [10])
    }

    func testTheBaselineOnlyMovesForward() {
        XCTAssertEqual(ChatNotices.baseline(nil, seqs: []), 0)
        XCTAssertEqual(ChatNotices.baseline(nil, seqs: [3, 9, 4]), 9)
        XCTAssertEqual(ChatNotices.baseline(12, seqs: [3, 9]), 12, "an older page read later does not move it back")
    }

    func testPreviewsArePlainShortText() {
        XCTAssertEqual(ChatNotices.preview("**Done.** See [the doc](https://example.com/x) and [[Note|your note]]."),
                       "Done. See the doc and your note.")
        XCTAssertEqual(ChatNotices.preview("## Plan\n- [ ] one\n- two\n\n```swift\nlet x = 1\n```\nAfter"), "Plan one two After")
        let long = ChatNotices.preview(String(repeating: "word ", count: 100), limit: 30)
        XCTAssertTrue(long.hasSuffix("…"))
        XCTAssertLessThanOrEqual(long.count, 31)
    }
}
