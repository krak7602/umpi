import Markdown
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Renders Markdown the way the owner's notes look: Apple Notes for text, checklists, and tables; Obsidian for code,
/// quotes, callouts (`> [!note]`), highlights (`==text==`), wiki links (`[[Note]]`), and Mermaid diagrams.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    var onOwnerTint = false

    init(_ text: String, onOwnerTint: Bool = false) {
        blocks = MarkdownBlock.parse(text)
        self.onOwnerTint = onOwnerTint
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block, onOwnerTint: onOwnerTint)
            }
        }
    }
}

enum CalloutKind: String, Equatable {
    case note, info, tip, success, question, warning, danger, failure, bug, example, quote, todo, abstract

    init(raw: String) {
        switch raw.lowercased() {
        case "summary", "tldr": self = .abstract
        case "hint", "important": self = .tip
        case "check", "done": self = .success
        case "help", "faq": self = .question
        case "caution", "attention": self = .warning
        case "fail", "missing": self = .failure
        case "error": self = .danger
        case "cite": self = .quote
        default: self = CalloutKind(rawValue: raw.lowercased()) ?? .note
        }
    }
    var color: Color {
        switch self {
        case .note, .info, .todo: .blue
        case .abstract, .tip: .teal
        case .success: .green
        case .question, .warning: .orange
        case .danger, .failure, .bug: .red
        case .example: .purple
        case .quote: .gray
        }
    }
    var symbol: String {
        switch self {
        case .note: "pencil"
        case .info: "info.circle"
        case .todo: "checkmark.circle"
        case .abstract: "list.bullet.clipboard"
        case .tip: "flame"
        case .success: "checkmark"
        case .question: "questionmark.circle"
        case .warning: "exclamationmark.triangle"
        case .danger: "bolt"
        case .failure: "xmark"
        case .bug: "ladybug"
        case .example: "list.bullet"
        case .quote: "quote.opening"
        }
    }
}

/// A parsed block, kept as plain values so views stay cheap to rebuild.
indirect enum MarkdownBlock: Equatable {
    case heading(level: Int, text: AttributedString)
    case paragraph(AttributedString)
    case list(ordered: Bool, start: Int, items: [MarkdownListItem])
    case quote([MarkdownBlock])
    case callout(kind: CalloutKind, title: String, blocks: [MarkdownBlock])
    case code(language: String?, text: String)
    case mermaid(String)
    case table(header: [AttributedString], rows: [[AttributedString]], alignments: [HorizontalAlignment?])
    case rule

    static func parse(_ text: String) -> [MarkdownBlock] {
        Document(parsing: withoutComments(text)).children.compactMap(block)
    }

    /// HTML comments are hidden, as in Obsidian, such as the markers Umpi puts on planned lines. Line breaks inside a
    /// comment are kept, so line numbers still match the note for ticking.
    static func withoutComments(_ text: String) -> String {
        guard text.contains("<!--") else { return text }
        return text.replacing(/<!--[\s\S]*?-->/) { match in String(repeating: "\n", count: match.output.filter { $0 == "\n" }.count) }
            .replacing(/[ \t]+(?=\n|$)/, with: "")
    }

    private static func block(_ markup: Markup) -> MarkdownBlock? {
        switch markup {
        case let heading as Heading: return .heading(level: heading.level, text: inline(heading.children))
        case let paragraph as Paragraph:
            let text = inline(paragraph.children)
            return text.characters.allSatisfy(\.isWhitespace) ? nil : .paragraph(text)
        // Empty items, such as a template's blank "- [ ]", are left out; the note itself keeps them.
        case let list as UnorderedList:
            let items = Array(list.listItems.map(item)).filter { !$0.isEmpty }
            return items.isEmpty ? nil : .list(ordered: false, start: 1, items: items)
        case let list as OrderedList:
            let items = Array(list.listItems.map(item)).filter { !$0.isEmpty }
            return items.isEmpty ? nil : .list(ordered: true, start: Int(list.startIndex), items: items)
        case let quote as BlockQuote: return callout(quote) ?? .quote(quote.children.compactMap(block))
        case let code as CodeBlock:
            let body = code.code.hasSuffix("\n") ? String(code.code.dropLast()) : code.code
            return code.language?.lowercased() == "mermaid" ? .mermaid(body) : .code(language: code.language, text: body)
        case let table as Markdown.Table:
            let alignments = table.columnAlignments.map { alignment -> HorizontalAlignment? in
                switch alignment { case .center: .center; case .right: .trailing; case .left: .leading; default: nil }
            }
            return .table(header: table.head.cells.map { inline($0.children) },
                          rows: table.body.rows.map { row in row.cells.map { inline($0.children) } },
                          alignments: alignments)
        case is ThematicBreak: return .rule
        case let html as HTMLBlock: return .paragraph(AttributedString(html.rawHTML.trimmingCharacters(in: .whitespacesAndNewlines)))
        default:
            let text = markup.format().trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : .paragraph(AttributedString(text))
        }
    }

    /// Obsidian callout: a quote whose first line is `[!kind] Optional title`.
    private static func callout(_ quote: BlockQuote) -> MarkdownBlock? {
        guard let first = quote.child(at: 0) as? Paragraph else { return nil }
        // The source text of the first paragraph; format() would escape the brackets.
        let raw = first.children.map { child -> String in
            if let text = child as? Markdown.Text { return text.string }
            return child is SoftBreak || child is LineBreak ? "\n" : child.format()
        }.joined()
        guard let match = raw.firstMatch(of: /^\s*\[!([A-Za-z]+)\][+-]?[ \t]*([^\n]*)\n?/) else { return nil }
        let kind = CalloutKind(raw: String(match.1))
        let title = String(match.2).trimmingCharacters(in: .whitespaces)
        let rest = String(raw[match.range.upperBound...])
        var blocks = rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : parse(rest)
        blocks += quote.children.dropFirst().compactMap(block)
        return .callout(kind: kind, title: title.isEmpty ? kind.rawValue.capitalized : title, blocks: blocks)
    }

    private static func item(_ item: ListItem) -> MarkdownListItem {
        var blocks = item.children.compactMap(block)
        var mark: String?
        // A plan mark ([target], [tentative], [confirmed]) at the start of a plain item replaces its bullet.
        if item.checkbox == nil, case .paragraph(let text)? = blocks.first, let first = text.runs.first, first.font == planMarkFont,
           case let word = String(text[first.range].characters), planMarks.contains(word.lowercased()) {
            mark = word
            var rest = AttributedString(text[first.range.upperBound...])
            while rest.characters.first == " " { rest.characters.removeFirst() }
            blocks[0] = .paragraph(rest)
        }
        return MarkdownListItem(checkbox: item.checkbox.map { $0 == .checked }, blocks: blocks, line: item.range?.lowerBound.line, mark: mark)
    }

    static let planMarks: Set<String> = ["target", "tentative", "confirmed"]
    /// Each plan mark's colour: a target is the plan's aim, tentative may move, confirmed is fixed.
    static func planColor(_ mark: String) -> Color {
        switch mark.lowercased() {
        case "tentative": .orange
        case "confirmed": .green
        default: .blue
        }
    }
    private static let planMarkFont = Font.caption.weight(.semibold)

    static func inline(_ children: some Sequence<Markup>) -> AttributedString {
        var result = AttributedString()
        for child in children { result += inlineRun(child) }
        return result
    }

    private static func inlineRun(_ markup: Markup) -> AttributedString {
        switch markup {
        case let text as Markdown.Text: return obsidianText(text.string)
        case is SoftBreak: return AttributedString(" ")
        case is LineBreak: return AttributedString("\n")
        case let code as InlineCode:
            // Drawn as a rounded pill per line by InlineCodeRenderer; no padding characters, so a wrap leaves nothing behind.
            var run = AttributedString(code.code)
            run.font = .system(.callout, design: .monospaced)
            run.inlinePresentationIntent = .code
            return run
        case let strong as Strong: return styled(strong.children, .stronglyEmphasized)
        case let emphasis as Emphasis: return styled(emphasis.children, .emphasized)
        case let strike as Strikethrough: return styled(strike.children, .strikethrough)
        case let link as Markdown.Link:
            var run = inline(link.children)
            if let destination = link.destination, let url = URL(string: destination) { run.link = url }
            return run
        case let image as Markdown.Image:
            return AttributedString("[\(image.plainText.isEmpty ? "image" : image.plainText)]")
        case let html as InlineHTML: return html.rawHTML.hasPrefix("<!--") ? AttributedString() : AttributedString(html.rawHTML)
        default: return inline(markup.children)
        }
    }

    /// Plain text with Obsidian's `==highlight==` and `[[wiki link|alias]]`, and Umpi's plan marks ([target],
    /// [tentative], [confirmed]) as small tags.
    static func obsidianText(_ string: String) -> AttributedString {
        var result = AttributedString()
        var rest = Substring(string)
        if let mark = rest.prefixMatch(of: /\[(target|tentative|confirmed)\][ \t]*/) {
            var tag = AttributedString(String(mark.1).capitalized)
            tag.font = planMarkFont
            tag.foregroundColor = planColor(String(mark.1))
            tag.inlinePresentationIntent = .code
            result += tag + AttributedString(" ")
            rest = rest[mark.range.upperBound...]
        }
        while let match = rest.firstMatch(of: /==([^=\n]+)==|\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/) {
            result += AttributedString(String(rest[..<match.range.lowerBound]))
            if let highlighted = match.1 {
                var run = AttributedString(String(highlighted))
                run.backgroundColor = Color.yellow.opacity(0.35)
                result += run
            } else if let target = match.2 {
                var run = AttributedString(String(match.3 ?? target))
                run.foregroundColor = Color.accentColor
                result += run
            }
            rest = rest[match.range.upperBound...]
        }
        result += AttributedString(String(rest))
        return result
    }

    private static func styled(_ children: some Sequence<Markup>, _ intent: InlinePresentationIntent) -> AttributedString {
        var run = inline(children)
        for range in run.runs.map(\.range) {
            run[range].inlinePresentationIntent = (run[range].inlinePresentationIntent ?? []).union(intent)
        }
        return run
    }
}

struct MarkdownListItem: Equatable {
    var checkbox: Bool?
    var blocks: [MarkdownBlock]
    /// The item's first line in the source, from 1, so a checkbox can be ticked in the note it came from.
    var line: Int? = nil
    /// Umpi's plan mark, such as "Target", shown as a tag in place of the bullet.
    var mark: String? = nil

    /// Nothing to show: no text, or only a bare checkbox such as a template's blank "- [ ]".
    var isEmpty: Bool {
        if blocks.isEmpty { return mark == nil }
        guard blocks.count == 1, case .paragraph(let text) = blocks[0] else { return false }
        return String(text.characters).trimmingCharacters(in: .whitespaces).wholeMatch(of: /\[[ xX]?\]/) != nil
    }
}

/// Set by a view that can tick checkboxes in its source note, such as Today: (source line from 1, new state).
extension EnvironmentValues {
    @Entry var markdownTaskToggle: (@MainActor @Sendable (Int, Bool) -> Void)? = nil
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let onOwnerTint: Bool

    var body: some View {
        switch block {
        case .heading(let level, let text):
            // Apple Notes: Title, Heading, Subheading.
            SwiftUI.Text(markdown: text).font(level == 1 ? .title2.weight(.bold) : level == 2 ? .title3.weight(.semibold) : .headline).inlineCodePills(onTint: onOwnerTint)
                .padding(.top, level <= 2 ? 4 : 0)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            SwiftUI.Text(markdown: text).lineSpacing(3).fixedSize(horizontal: false, vertical: true).inlineCodePills(onTint: onOwnerTint)
        case .list(let ordered, let start, let items):
            let marked = !ordered && items.contains { $0.mark != nil }
            let widest = items.compactMap(\.mark).max { $0.count < $1.count } ?? ""
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if marked && item.checkbox == nil {
                            // Plan tags stand in for bullets, each as wide as the list's widest, so the text lines up.
                            ZStack(alignment: .leading) {
                                planTag(widest).hidden()
                                if let mark = item.mark { planTag(mark) } else { Text("•").foregroundStyle(.secondary).frame(minWidth: 10) }
                            }
                        } else {
                            marker(ordered: ordered, number: start + index, checkbox: item.checkbox, line: item.line)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(item.blocks.enumerated()), id: \.offset) { _, inner in MarkdownBlockView(block: inner, onOwnerTint: onOwnerTint) }
                        }
                        .foregroundStyle(item.checkbox == true ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    }
                }
            }
        case .quote(let blocks):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.accentColor.opacity(onOwnerTint ? 0.9 : 0.6)).frame(width: 3)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, inner in MarkdownBlockView(block: inner, onOwnerTint: onOwnerTint) }
                }
                .foregroundStyle(.secondary)
            }
        case .callout(let kind, let title, let blocks):
            VStack(alignment: .leading, spacing: 6) {
                Label(title, systemImage: kind.symbol).font(.subheadline.weight(.semibold)).foregroundStyle(kind.color)
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, inner in MarkdownBlockView(block: inner, onOwnerTint: onOwnerTint) }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(kind.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .code(let language, let text):
            CodeBlockView(language: language, text: text)
        case .mermaid(let source):
            MermaidView(source: source)
        case .table(let header, let rows, let alignments):
            NotesTable(header: header, rows: rows, alignments: alignments)
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }

    @Environment(\.markdownTaskToggle) private var toggle

    @ViewBuilder private func marker(ordered: Bool, number: Int, checkbox: Bool?, line: Int?) -> some View {
        if let checked = checkbox, let toggle, let line {
            Button { toggle(line, !checked) } label: { checkmark(checked) }
                .buttonStyle(.plain)
                .accessibilityLabel(checked ? "Done" : "Not done")
                .accessibilityHint(checked ? "Marks it not done in the note" : "Marks it done in the note")
        } else if let checked = checkbox {
            checkmark(checked)
        } else if ordered {
            Text("\(number).").monospacedDigit().foregroundStyle(.secondary).frame(minWidth: 18, alignment: .trailing)
        } else {
            Text("•").foregroundStyle(.secondary).frame(minWidth: 10)
        }
    }
    private func planTag(_ text: String) -> some View {
        let color = MarkdownBlock.planColor(text)
        return Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(onOwnerTint ? Color.white : color)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(onOwnerTint ? Color.white.opacity(0.22) : color.opacity(0.16), in: Capsule())
    }
    private func checkmark(_ checked: Bool) -> some View {
        Group {
            // Apple Notes checklist shape in the system tint: an empty circle, or a filled circle with a checkmark.
            Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                .symbolRenderingMode(.palette)
                .foregroundStyle(checked ? Color.white : Color.secondary.opacity(0.6), checked ? (onOwnerTint ? Color.white.opacity(0.35) : Color.accentColor) : Color.clear)
                .font(.title3)
                .accessibilityLabel(checked ? "Done" : "Not done")
        }
        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
    }
}

/// A table drawn like Apple Notes: hairline cell borders, a bold header, rounded corners, scrolling when wide.
private struct NotesTable: View {
    let header: [AttributedString]
    let rows: [[AttributedString]]
    let alignments: [HorizontalAlignment?]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { column, cell in
                        self.cell(SwiftUI.Text(markdown: cell).fontWeight(.semibold), column: column).background(Color(.secondarySystemFill))
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow { ForEach(Array(row.enumerated()), id: \.offset) { column, cell in self.cell(SwiftUI.Text(markdown: cell), column: column).inlineCodePills() } }
                }
            }
            .font(.callout)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Color(.separator), lineWidth: 0.5))
            .padding(1)
        }
    }
    private func cell(_ text: SwiftUI.Text, column: Int) -> some View {
        let alignment = alignments.indices.contains(column) ? alignments[column] ?? .leading : .leading
        return text
            .multilineTextAlignment(alignment == .trailing ? .trailing : alignment == .center ? .center : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(minWidth: 60, maxWidth: 260, maxHeight: .infinity, alignment: Alignment(horizontal: alignment, vertical: .top))
            .padding(.horizontal, 10).padding(.vertical, 7)
            .border(Color(.separator), width: 0.25)
            .gridColumnAlignment(alignment)
    }
}

/// A code block like Obsidian's: monospaced on a soft background, its language, and a copy button.
private struct CodeBlockView: View {
    let language: String?
    let text: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(language?.isEmpty == false ? language! : "code").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button {
                    Clipboard.copy(text)
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(copied ? "Copied" : "Copy code")
                .accessibilityIdentifier("markdown.code.copy")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(SyntaxHighlighter.shared.highlight(text, language: language)).font(.system(.footnote, design: .monospaced)).lineSpacing(2).textSelection(.enabled).fixedSize()
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
    }
}

/// Marks inline code inside a Text so the renderer can draw its pill.
struct InlineCodeAttribute: TextAttribute {}

extension SwiftUI.Text {
    /// Text from parsed Markdown, with inline code marked for `inlineCodePills()`.
    init(markdown: AttributedString) {
        var result = SwiftUI.Text(verbatim: "")
        let runs = Array(markdown.runs)
        for (index, run) in runs.enumerated() {
            let piece = SwiftUI.Text(AttributedString(markdown[run.range]))
            let isCode = run.inlinePresentationIntent?.contains(.code) == true
            // A thin space on each side keeps the pill, drawn beyond the code's glyphs, clear of the text around it.
            let gap = SwiftUI.Text(verbatim: "\u{2009}")
            if isCode {
                result = SwiftUI.Text("\(result)\(gap)\(piece.customAttribute(InlineCodeAttribute()))\(index < runs.count - 1 ? gap : SwiftUI.Text(verbatim: ""))")
            } else {
                result = SwiftUI.Text("\(result)\(piece)")
            }
        }
        self = result
    }
}

/// Draws a rounded pill behind each line's piece of inline code, like Obsidian and GitHub.
struct InlineCodeRenderer: TextRenderer {
    var fill: Color
    func draw(layout: SwiftUI.Text.Layout, in context: inout GraphicsContext) {
        for line in layout {
            for run in line where run[InlineCodeAttribute.self] != nil {
                let rect = run.typographicBounds.rect.insetBy(dx: -3.5, dy: -0.5)
                context.fill(Path(roundedRect: rect, cornerRadius: 5, style: .continuous), with: .color(fill))
            }
            context.draw(line)
        }
    }
}

extension View {
    func inlineCodePills(onTint: Bool = false) -> some View { textRenderer(InlineCodeRenderer(fill: onTint ? Color.white.opacity(0.22) : Color(.tertiarySystemFill))) }
}
