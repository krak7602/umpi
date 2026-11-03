import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The chat's message field: a UIKit text view so pasting images, videos, and files works like in Messages and
/// WhatsApp. Text pastes as text; anything else is handed to the chat as an attachment. It grows to eight lines.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    let onPaste: ([NSItemProvider]) -> Void

    static let insets = UIEdgeInsets(top: 9.5, left: 14, bottom: 7, right: 42)

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> PastingTextView {
        let view = PastingTextView()
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
        return view
    }

    func updateUIView(_ view: PastingTextView, context: Context) {
        if view.text != text { view.text = text }
        view.placeholder.isHidden = !text.isEmpty
        if focused, !view.isFirstResponder { DispatchQueue.main.async { view.becomeFirstResponder() } }
        if !focused, view.isFirstResponder { DispatchQueue.main.async { view.resignFirstResponder() } }
    }

    /// One line up to eight, then it scrolls.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: PastingTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 300
        let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let line = uiView.font?.lineHeight ?? 22
        let maximum = line * 8 + ComposerTextView.insets.top + ComposerTextView.insets.bottom
        let scrolls = fitting > maximum
        if uiView.isScrollEnabled != scrolls { DispatchQueue.main.async { uiView.isScrollEnabled = scrolls } }
        return CGSize(width: width, height: max(ChatView.fieldHeight, min(fitting, maximum)))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        init(_ parent: ComposerTextView) { self.parent = parent }
        func textViewDidChange(_ view: UITextView) {
            parent.text = view.text
            (view as? PastingTextView)?.placeholder.isHidden = !view.text.isEmpty
            view.invalidateIntrinsicContentSize()
        }
        func textViewDidBeginEditing(_ view: UITextView) { if !parent.focused { parent.focused = true } }
        func textViewDidEndEditing(_ view: UITextView) { if parent.focused { parent.focused = false } }
    }
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
