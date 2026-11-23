import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The chat's message field: a UIKit text view so pasting images, videos, and files works like in Messages and
/// WhatsApp. Text pastes as text; anything else is handed to the chat as an attachment. It grows to eight lines.
///
/// The text view owns what is typed. It reports each change to the draft at once, and takes the draft's text back only
/// when the app replaced it (`ChatDraft.revision` changed), so an update can never write an older text over what was
/// just typed. Typing itself asks nothing of SwiftUI: the field is laid out again only when its height changes.
/// For that the text view sits in a plain container (`ComposerField`), because a text view on its own announces a new
/// size on every change of its text, and SwiftUI then checks the layout of the whole conversation again.
struct ComposerTextView: UIViewRepresentable {
    let draft: ChatDraft
    /// `draft.revision` and `draft.focused` as the composer last drew them. They are here so that SwiftUI updates the
    /// field when either changes; the update itself reads the draft, which is never older.
    let revision: Int
    let focused: Bool
    let placeholder: String
    let onPaste: ([NSItemProvider]) -> Void

    static let insets = UIEdgeInsets(top: 9.5, left: 14, bottom: 7, right: 42)

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ComposerField {
        let field = ComposerField()
        let view = field.textView
        view.delegate = context.coordinator
        view.onPaste = { providers in context.coordinator.parent.onPaste(providers) }
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = ComposerTextView.insets
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.accessibilityIdentifier = "chat.input"
        view.accessibilityLabel = placeholder
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // Images, video, and files can be pasted, as well as text.
        view.pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.image, .movie, .pdf, .fileURL, .data, .plainText, .text, .url].map(\.identifier))
        view.placeholder.text = placeholder
        view.text = draft.text
        context.coordinator.applied = draft.revision
        return field
    }

    func updateUIView(_ field: ComposerField, context: Context) {
        let view = field.textView
        let coordinator = context.coordinator
        coordinator.parent = self
        // Only text the app set is written to the field, and only once.
        if coordinator.applied != draft.revision {
            coordinator.applied = draft.revision
            if view.text != draft.text { view.text = draft.text }
        }
        view.placeholder.isHidden = !view.text.isEmpty
        // Set text, or a new text size setting, can need another height.
        ComposerTextView.resizeIfNeeded(view)
        // The draft is asked again when the change is made: focus may have moved on by then.
        let draft = draft
        if draft.focused, !view.isFirstResponder { DispatchQueue.main.async { if draft.focused, !view.isFirstResponder { view.becomeFirstResponder() } } }
        if !draft.focused, view.isFirstResponder { DispatchQueue.main.async { if !draft.focused, view.isFirstResponder { view.resignFirstResponder() } } }
    }

    /// The height the field wants at `width`: one line up to eight, and whether the text then scrolls.
    static func fit(_ view: UITextView, width: CGFloat) -> (height: CGFloat, scrolls: Bool) {
        let fitting = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let line = view.font?.lineHeight ?? 22
        let maximum = line * 8 + ComposerTextView.insets.top + ComposerTextView.insets.bottom
        return (max(ChatView.fieldHeight, min(fitting, maximum)), fitting > maximum)
    }

    /// Asks SwiftUI to measure the field again, but only when the height it has is not the height its text needs (a
    /// new line, or a line fewer). Asked on every keystroke, SwiftUI checked the layout of the whole conversation each
    /// time.
    static func resizeIfNeeded(_ view: UITextView) {
        let fit = fit(view, width: view.bounds.width)
        if view.bounds.width <= 0 || abs(fit.height - view.bounds.height) > 1 || fit.scrolls != view.isScrollEnabled {
            view.superview?.invalidateIntrinsicContentSize()
        }
    }

    /// One line up to eight, then it scrolls.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerField, context: Context) -> CGSize? {
        let width = proposal.width ?? 300
        let view = uiView.textView
        let fit = ComposerTextView.fit(view, width: width)
        if view.isScrollEnabled != fit.scrolls { DispatchQueue.main.async { view.isScrollEnabled = fit.scrolls } }
        return CGSize(width: width, height: fit.height)
    }

    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        /// The draft revision whose text the field holds.
        var applied = 0
        init(_ parent: ComposerTextView) { self.parent = parent }

        func textViewDidChange(_ view: UITextView) {
            // The draft has the new text before anything else can run.
            parent.draft.typed(view.text)
            (view as? PastingTextView)?.placeholder.isHidden = !view.text.isEmpty
            ComposerTextView.resizeIfNeeded(view)
        }
        func textViewDidBeginEditing(_ view: UITextView) { if !parent.draft.focused { parent.draft.focused = true } }
        func textViewDidEndEditing(_ view: UITextView) { if parent.draft.focused { parent.draft.focused = false } }
    }
}

/// Holds the message field's text view and fills itself with it. Being a plain view, it tells SwiftUI about a new size
/// only when `ComposerTextView` asks it to.
final class ComposerField: UIView {
    let textView = PastingTextView()
    /// How often the field asked SwiftUI for a new size, for tests: typing within a line must not.
    private(set) var sizeRequests = 0
    override func invalidateIntrinsicContentSize() {
        sizeRequests += 1
        super.invalidateIntrinsicContentSize()
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        textView.frame = bounds
        textView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(textView)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// A text view that hands pasted images, videos, and files to the chat instead of dropping them.
final class PastingTextView: UITextView {
    var onPaste: (([NSItemProvider]) -> Void)?
    let placeholder = UILabel()

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholder.font = .preferredFont(forTextStyle: .body)
        placeholder.adjustsFontForContentSizeCategory = true
        placeholder.textColor = .placeholderText
        placeholder.isAccessibilityElement = false
        addSubview(placeholder)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let insets = ComposerTextView.insets
        placeholder.frame = CGRect(x: insets.left, y: insets.top, width: bounds.width - insets.left - insets.right, height: placeholder.font.lineHeight)
    }

    private static let mediaTypes: [UTType] = [.image, .movie, .pdf, .fileURL]
    private func hasMedia(_ pasteboard: UIPasteboard = .general) -> Bool {
        pasteboard.hasImages || pasteboard.contains(pasteboardTypes: PastingTextView.mediaTypes.map(\.identifier))
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), hasMedia() { return true }
        return super.canPerformAction(action, withSender: sender)
    }
    override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
        itemProviders.contains { provider in PastingTextView.mediaTypes.contains { provider.hasItemConformingToTypeIdentifier($0.identifier) } }
            || super.canPaste(itemProviders)
    }
    /// The edit menu's Paste and the keyboard's paste suggestion.
    override func paste(_ sender: Any?) {
        if hasMedia() { onPaste?(UIPasteboard.general.itemProviders) } else { super.paste(sender) }
    }
    /// Paste through the paste control (UIPasteConfigurationSupporting).
    override func paste(itemProviders: [NSItemProvider]) {
        let media = itemProviders.filter { provider in PastingTextView.mediaTypes.contains { provider.hasItemConformingToTypeIdentifier($0.identifier) } }
        if media.isEmpty { super.paste(itemProviders: itemProviders) } else { onPaste?(media) }
    }
}
