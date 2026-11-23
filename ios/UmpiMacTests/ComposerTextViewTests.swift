import AppKit
import SwiftUI
import XCTest

/// The field's file reads the chat's line height; these tests are built without the chat.
enum ChatView { static let fieldHeight: CGFloat = 40 }

/// The message field against the chat's draft and focus, with no window on screen. `Field.update` does what a SwiftUI
/// update does: it hands the field the chat's current text and focus.
@MainActor
final class ComposerTextViewTests: XCTestCase {
    /// The chat's side: the draft and whether the chat wants the field focused.
    private final class Chat {
        var text = ""
        var focused = false
    }

    @MainActor private final class Field {
        let chat = Chat()
        let view = ComposerNSTextView(usingTextLayoutManager: false)
        let coordinator: ComposerTextView.Coordinator
        /// Never shown.
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 120), styleMask: [.titled], backing: .buffered, defer: true)

        init() {
            let chat = chat
            coordinator = ComposerTextView.Coordinator(ComposerTextView(
                text: Binding(get: { chat.text }, set: { chat.text = $0 }),
                focused: Binding(get: { chat.focused }, set: { chat.focused = $0 }),
                placeholder: "Message", onPaste: { _ in }))
            view.isRichText = false
            view.delegate = coordinator
            view.onFocus = { [weak coordinator] in coordinator?.focusChanged($0) }
            view.frame = NSRect(x: 0, y: 0, width: 320, height: 120)
            coordinator.textView = view
            window.isReleasedWhenClosed = false
            window.contentView?.addSubview(view)
        }

        func update() { coordinator.follow(text: chat.text, focused: chat.focused) }
        var isFocused: Bool { window.firstResponder === view }
        /// Lets the work the field put off to the next turn of the run loop happen.
        func turn() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }

    private let unfinished = NSRange(location: NSNotFound, length: 0)

    func testTypedAndInsertedTextReachesTheDraft() {
        let field = Field()
        field.view.insertText("two tickets", replacementRange: field.view.selectedRange())
        XCTAssertEqual(field.chat.text, "two tickets")
        field.update()
        XCTAssertEqual(field.view.string, "two tickets")
    }

    func testTextSetThroughAccessibilityReachesTheDraft() {
        let field = Field()
        field.view.setAccessibilitySelectedText("water the fern")
        XCTAssertEqual(field.chat.text, "water the fern", "inserted at the cursor, as a dictation tool does")
        field.view.setAccessibilityValue("buy stamps")
        XCTAssertEqual(field.chat.text, "buy stamps", "the whole value replaced")
        field.update()
        XCTAssertEqual(field.view.string, "buy stamps")
    }

    func testAnUnfinishedWordSurvivesAnUpdate() {
        let field = Field()
        field.view.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0), replacementRange: unfinished)
        XCTAssertEqual(field.chat.text, "", "the draft does not have an input method's unfinished text")
        field.update()
        XCTAssertEqual(field.view.string, "ni")
        XCTAssertTrue(field.view.hasMarkedText(), "the word is still being composed")
        field.view.insertText("日", replacementRange: unfinished)
        XCTAssertEqual(field.chat.text, "日")
    }

    func testAnUpdateWithTheSameOlderTextKeepsWhatTheFieldHas() {
        let field = Field()
        field.update()
        field.view.insertText("call the plumber", replacementRange: field.view.selectedRange())
        // An update made before the insert, arriving after it.
        field.coordinator.follow(text: "", focused: false)
        XCTAssertEqual(field.view.string, "call the plumber")
        XCTAssertEqual(field.chat.text, "call the plumber")
    }

    func testAClearedDraftClearsTheField() {
        let field = Field()
        field.view.insertText("see you at nine", replacementRange: field.view.selectedRange())
        field.update()
        field.chat.text = ""
        field.update()
        XCTAssertEqual(field.view.string, "", "after a send")
    }

    func testADraftPutInByTheChatShows() {
        let field = Field()
        field.update()
        field.chat.text = "Remind me "
        field.update()
        XCTAssertEqual(field.view.string, "Remind me ")
    }

    func testFocusGivenToTheFieldSurvivesAnUpdateFromBefore() {
        let field = Field()
        field.update()
        XCTAssertTrue(field.window.makeFirstResponder(field.view), "as the panel opening or Command-N does")
        XCTAssertFalse(field.chat.focused, "the chat learns of it on the next turn")
        field.update()
        field.turn()
        XCTAssertTrue(field.isFocused, "an update that still said \"not focused\" did not take the cursor away")
        XCTAssertTrue(field.chat.focused)
        field.update()
        field.turn()
        XCTAssertTrue(field.isFocused)
    }

    func testTheFieldFollowsTheChatsFocusWhenTheChatChangesIt() {
        let field = Field()
        field.chat.focused = true
        field.update()
        field.turn()
        XCTAssertTrue(field.isFocused)
        field.chat.focused = false
        field.update()
        field.turn()
        XCTAssertFalse(field.isFocused, "as when voice mode opens from the field")
    }

    func testFocusTheChatNoLongerWantsIsNotGiven() {
        let field = Field()
        field.chat.focused = true
        field.update()
        field.chat.focused = false
        field.turn()
        XCTAssertFalse(field.isFocused)
    }

    // MARK: What a paste does with each kind of clipboard

    /// A clipboard of its own for one test; the owner's clipboard is not read or changed.
    private func clipboard(_ fill: (NSPasteboard) -> Void) -> NSPasteboard {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("umpi.composer.tests.\(UUID().uuidString)"))
        pasteboard.clearContents()
        fill(pasteboard)
        addTeardownBlock { pasteboard.releaseGlobally() }
        return pasteboard
    }

    private func attaches(_ pasteboard: NSPasteboard, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let providers = ComposerNSTextView.mediaProviders(pasteboard)
        XCTAssertEqual(ComposerNSTextView.hasMedia(pasteboard), !providers.isEmpty, "the Paste item agrees with the paste", file: file, line: line)
        return !providers.isEmpty
    }

    private var picture: NSImage {
        NSImage(size: NSSize(width: 4, height: 4), flipped: false) { rect in
            NSColor.systemTeal.setFill()
            rect.fill()
            return true
        }
    }

    func testTextPastesAsTextAlsoWithOtherFormsOfItOnTheClipboard() throws {
        XCTAssertFalse(attaches(clipboard { $0.setString("water the fern", forType: .string) }))
        // Marks some tools add so clipboard managers skip the entry.
        let marks = [NSPasteboard.PasteboardType("org.nspasteboard.TransientType"), NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")]
        XCTAssertFalse(attaches(clipboard { pasteboard in
            pasteboard.declareTypes([.string] + marks, owner: nil)
            pasteboard.setString("water the fern", forType: .string)
            for mark in marks { pasteboard.setString("", forType: mark) }
        }))
        let rich = try XCTUnwrap(NSAttributedString(string: "water the fern").rtf(from: NSRange(location: 0, length: 14)))
        XCTAssertFalse(attaches(clipboard {
            $0.declareTypes([.string, .rtf, .html], owner: nil)
            $0.setString("water the fern", forType: .string)
            $0.setData(rich, forType: .rtf)
            $0.setString("<b>water the fern</b>", forType: .html)
        }))
        let image = try XCTUnwrap(picture.tiffRepresentation)
        XCTAssertFalse(attaches(clipboard {
            let item = NSPasteboardItem()
            item.setString("water the fern", forType: .string)
            item.setData(image, forType: .tiff)
            $0.writeObjects([item])
        }), "text with a picture of it, as some apps copy, is text")
    }

    func testImagesAndFilesAttach() throws {
        let picture = picture
        XCTAssertTrue(attaches(clipboard { $0.writeObjects([picture]) }), "an image alone, such as a copied screenshot")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("umpi-composer-test-\(UUID().uuidString).txt")
        try "invented".write(to: file, atomically: true, encoding: .utf8)
        addTeardownBlock { try? FileManager.default.removeItem(at: file) }
        XCTAssertTrue(attaches(clipboard { $0.writeObjects([file as NSURL]) }), "a file copied in Finder")
    }
}
