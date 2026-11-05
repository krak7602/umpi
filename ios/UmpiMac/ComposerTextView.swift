import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// The chat's message field on the Mac: an AppKit text view, as Mac chat apps have it. Return sends and Shift-Return
/// starts a new line. Pasted images and files are handed to the chat as an attachment; text pastes as text. It grows
/// to eight lines, then scrolls.
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    var onReturn: (() -> Void)? = nil
    let onPaste: ([NSItemProvider]) -> Void

    /// Room on the right for the send button that sits over the field.
    static let trailingRoom: CGFloat = 28
    static let horizontalInset: CGFloat = 14

    /// The vertical margin that centres one line of `font` in the field, so text, placeholder, and the buttons beside
    /// it share a centre line.
    static func inset(for font: NSFont) -> NSSize {
        let line = NSLayoutManager().defaultLineHeight(for: font)
        return NSSize(width: horizontalInset, height: max(4, ((ChatView.fieldHeight - line) / 2).rounded(.down)))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSView {
        let textView = ComposerNSTextView(usingTextLayoutManager: false)
        textView.delegate = context.coordinator
        textView.onPaste = { context.coordinator.parent.onPaste($0) }
        textView.placeholder = placeholder
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.font = .preferredFont(forTextStyle: .body)
        textView.textContainerInset = Self.inset(for: textView.font!)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.setAccessibilityIdentifier("chat.input")
        textView.setAccessibilityLabel(placeholder)
        textView.string = text

        let scroll = NSScrollView()
        scroll.documentView = textView
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -Self.trailingRoom),
            scroll.topAnchor.constraint(equalTo: container.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        context.coordinator.textView = textView
        return container
    }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.parent = self
        guard let textView = context.coordinator.textView else { return }
        if textView.string != text {
            textView.string = text
            textView.needsDisplay = true
        }
        let isFirst = textView.window?.firstResponder === textView
        if focused, !isFirst, let window = textView.window { DispatchQueue.main.async { window.makeFirstResponder(textView) } }
        if !focused, isFirst, let window = textView.window { DispatchQueue.main.async { window.makeFirstResponder(nil) } }
    }

    /// One line up to eight, then it scrolls.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSView, context: Context) -> CGSize? {
        let width = proposal.width ?? 300
        guard let textView = context.coordinator.textView, let layout = textView.layoutManager, let container = textView.textContainer else { return nil }
        let inset = textView.textContainerInset
        container.size = NSSize(width: max(1, width - Self.trailingRoom - inset.width * 2), height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container).height
        let line = layout.defaultLineHeight(for: textView.font ?? .preferredFont(forTextStyle: .body))
        let fitting = max(used, line) + inset.height * 2
        let maximum = line * 8 + inset.height * 2
        return CGSize(width: width, height: max(ChatView.fieldHeight, min(fitting, maximum)))
    }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        weak var textView: ComposerNSTextView?
        init(_ parent: ComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            parent.text = textView.string
            textView.needsDisplay = true
            textView.enclosingScrollView?.superview?.invalidateIntrinsicContentSize()
        }
        func textDidBeginEditing(_ notification: Notification) { if !parent.focused { parent.focused = true } }
        func textDidEndEditing(_ notification: Notification) { if parent.focused { parent.focused = false } }

        /// Return sends; Shift-Return and Option-Return start a new line.
        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.insertNewline(_:)), let onReturn = parent.onReturn,
                  !(NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false) else { return false }
            onReturn()
            return true
        }
    }
}

/// A text view with a placeholder that hands pasted images and files to the chat instead of their names.
final class ComposerNSTextView: NSTextView {
    var onPaste: (([NSItemProvider]) -> Void)?
    var placeholder = ""

    override var acceptsFirstResponder: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        let attributes: [NSAttributedString.Key: Any] = [.font: font ?? .preferredFont(forTextStyle: .body), .foregroundColor: NSColor.placeholderTextColor]
        placeholder.draw(at: NSPoint(x: textContainerOrigin.x, y: textContainerOrigin.y), withAttributes: attributes)
    }

    /// The panel opens ready to type.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window, window is NSPanel { DispatchQueue.main.async { window.makeFirstResponder(self) } }
    }

    override func paste(_ sender: Any?) {
        let providers = Self.mediaProviders(NSPasteboard.general)
        if providers.isEmpty { pasteAsPlainText(sender) } else { onPaste?(providers) }
    }

    /// Copied files (from Finder) and images without text, as item providers; empty when the paste is text.
    static func mediaProviders(_ pasteboard: NSPasteboard) -> [NSItemProvider] {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return urls.compactMap { NSItemProvider(contentsOf: $0) }
        }
        guard pasteboard.string(forType: .string) == nil,
              let images = pasteboard.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage], !images.isEmpty else { return [] }
        return images.map { NSItemProvider(object: $0) }
    }
}
