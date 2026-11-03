import Markdown
import SwiftUI
import UIKit

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
        Document(parsing: text).children.compactMap(block)
    }

    private static func block(_ markup: Markup) -> MarkdownBlock? {
        switch markup {
        case let heading as Heading: return .heading(level: heading.level, text: inline(heading.children))
        case let paragraph as Paragraph: return .paragraph(inline(paragraph.children))
        case let list as UnorderedList: return .list(ordered: false, start: 1, items: list.listItems.map(item))
        case let list as OrderedList: return .list(ordered: true, start: Int(list.startIndex), items: list.listItems.map(item))
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
        MarkdownListItem(checkbox: item.checkbox.map { $0 == .checked }, blocks: item.children.compactMap(block))
    }

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
            var run = AttributedString("\u{2009}\(code.code)\u{2009}")
            run.font = .system(.callout, design: .monospaced)
            run.backgroundColor = Color(.tertiarySystemFill)
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
        case let html as InlineHTML: return AttributedString(html.rawHTML)
        default: return inline(markup.children)
        }
    }

    /// Plain text with Obsidian's `==highlight==` and `[[wiki link|alias]]`.
    static func obsidianText(_ string: String) -> AttributedString {
        var result = AttributedString()
        var rest = Substring(string)
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
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let onOwnerTint: Bool

    var body: some View {
        switch block {
        case .heading(let level, let text):
            // Apple Notes: Title, Heading, Subheading.
            Text(text).font(level == 1 ? .title2.weight(.bold) : level == 2 ? .title3.weight(.semibold) : .headline)
                .padding(.top, level <= 2 ? 4 : 0)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(text).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        marker(ordered: ordered, number: start + index, checkbox: item.checkbox)
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

    @ViewBuilder private func marker(ordered: Bool, number: Int, checkbox: Bool?) -> some View {
        if let checked = checkbox {
            // Apple Notes checklist shape in the system tint: an empty circle, or a filled circle with a checkmark.
            Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                .symbolRenderingMode(.palette)
                .foregroundStyle(checked ? Color.white : Color.secondary.opacity(0.6), checked ? (onOwnerTint ? Color.white.opacity(0.35) : Color.accentColor) : Color.clear)
                .font(.title3)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
                .accessibilityLabel(checked ? "Done" : "Not done")
        } else if ordered {
            Text("\(number).").monospacedDigit().foregroundStyle(.secondary).frame(minWidth: 18, alignment: .trailing)
        } else {
            Text("•").foregroundStyle(.secondary).frame(minWidth: 10)
        }
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
                        self.cell(Text(cell).fontWeight(.semibold), column: column).background(Color(.secondarySystemFill))
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow { ForEach(Array(row.enumerated()), id: \.offset) { column, cell in self.cell(Text(cell), column: column) } }
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
                    UIPasteboard.general.string = text
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
