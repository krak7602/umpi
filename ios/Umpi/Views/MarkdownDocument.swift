import Foundation
import Markdown
import os
import SwiftUI

/// Signpost intervals for Instruments (subsystem `umpi.render`): how long Markdown parsing, code colouring, and the
/// chat's first layout take.
enum RenderSignposts {
    static let markdown = OSSignposter(subsystem: "umpi.render", category: "markdown")
    static let highlight = OSSignposter(subsystem: "umpi.render", category: "highlight")
    static let chat = OSSignposter(subsystem: "umpi.render", category: "chat")
}

/// A cache with a size bound that drops the entry used longest ago. Safe to use from any thread.
final class RecentCache<Key: Hashable, Value>: @unchecked Sendable {
    private struct Entry { var value: Value; var cost: Int; var used: UInt64 }
    private let lock = NSLock()
    private var entries: [Key: Entry] = [:]
    private var clock: UInt64 = 0
    private var total = 0
    private let limit: Int
    private let costLimit: Int

    /// At most `limit` entries, and at most `costLimit` as the sum of their costs.
    init(limit: Int, costLimit: Int = .max) {
        self.limit = max(1, limit)
        self.costLimit = costLimit
    }

    /// The value, which also counts as a use of it.
    subscript(key: Key) -> Value? {
        lock.lock(); defer { lock.unlock() }
        guard let index = entries.index(forKey: key) else { return nil }
        clock += 1
        entries.values[index].used = clock
        return entries.values[index].value
    }

    func contains(_ key: Key) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return entries[key] != nil
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return entries.count
    }

    func set(_ value: Value, for key: Key, cost: Int = 1) {
        lock.lock(); defer { lock.unlock() }
        clock += 1
        if let old = entries.updateValue(Entry(value: value, cost: cost, used: clock), forKey: key) { total -= old.cost }
        total += cost
        while entries.count > limit || (total > costLimit && entries.count > 1) {
            guard let oldest = entries.min(by: { $0.value.used < $1.value.used }) else { break }
            total -= oldest.value.cost
            entries.removeValue(forKey: oldest.key)
        }
    }

    func removeAll() {
        lock.lock(); defer { lock.unlock() }
        entries.removeAll()
        total = 0
    }
}

/// A text's parsed blocks, each with a place that does not change, so a view can keep a block it has already drawn.
///
/// `complete` parses a finished text. `growing` parses a text that is still being written, such as a reply while it
/// arrives: it keeps the blocks that can no longer change and parses only the end of the text again.
struct MarkdownDocument: Equatable, Sendable {
    struct Block: Equatable, Identifiable, Sendable {
        /// The block's place in the document, from 0. A block keeps its place while the text grows.
        let id: Int
        let content: MarkdownBlock
        /// Later text cannot change the block. A pending block (not stable) is parsed again when the text grows.
        let isStable: Bool
        /// The block has a code fence that is not closed yet: its code shows plain, and a diagram shows as its source.
        let hasOpenFence: Bool
    }

    let source: String
    let blocks: [Block]
    /// Where the pending part of `source` starts, as a UTF-8 offset; the length of `source` when nothing is pending.
    let pendingStart: Int
    /// The number of lines before `pendingStart`, so list items keep their line in the whole text.
    let pendingLine: Int
    /// A link or footnote definition, or an HTML comment, is in the text. Either can change earlier blocks, so each
    /// call parses the whole text and a stable block can still change.
    let parsesWhole: Bool
    /// Made by `growing`, so the next call can continue from it.
    let grows: Bool

    /// The blocks that later text cannot change; they are first.
    var stable: ArraySlice<Block> { blocks.prefix { $0.isStable } }
    /// The blocks that later text can still change; they are last.
    var pending: ArraySlice<Block> { blocks[stable.count...] }

    /// The blocks of a finished text.
    static func complete(_ text: String) -> MarkdownDocument {
        let blocks = MarkdownBlock.parse(text).enumerated().map { Block(id: $0.offset, content: $0.element, isStable: true, hasOpenFence: false) }
        return MarkdownDocument(source: text, blocks: blocks, pendingStart: text.utf8.count, pendingLine: 0, parsesWhole: false, grows: false)
    }

    /// The blocks of a text that can still grow. When `previous` came from this function for a text that `text` starts
    /// with, its stable blocks are kept as they are and only the text after them is parsed.
    ///
    /// A block is stable when another block starts after it on a complete line, because the parser closes a block
    /// before it starts the next one. A paragraph, a heading, a rule, and a closed code fence are also stable once a
    /// complete blank line follows them. A list, a quote, a table, and an open code fence can change until another block
    /// follows, so a blank line inside or after one is not a boundary.
    ///
    /// The pending part is parsed from a repaired copy; the source is never changed. In the copy, an open code fence is
    /// closed, a closing fence that is only part written is left out, emphasis marks at the very end are plain text
    /// (they can be half of a longer mark), a link whose address is not finished is plain text, and an HTML comment
    /// that is not closed is hidden.
    static func growing(_ text: String, after previous: MarkdownDocument? = nil) -> MarkdownDocument {
        if let previous, previous.grows, previous.source == text { return previous }
        let signpost = RenderSignposts.markdown.beginInterval("parse tail")
        defer { RenderSignposts.markdown.endInterval("parse tail", signpost) }

        var kept: [Block] = []
        var start = 0, line = 0
        var whole = false
        if let previous, previous.grows, text.utf8.count >= previous.source.utf8.count, text.utf8.starts(with: previous.source.utf8) {
            whole = previous.parsesWhole
            if !whole { kept = Array(previous.stable); start = previous.pendingStart; line = previous.pendingLine }
        }
        var region = text[text.utf8.index(text.utf8.startIndex, offsetBy: start)...]
        if !whole, changesEarlierBlocks(region) {
            whole = true
            kept = []; start = 0; line = 0
            region = text[...]
        }

        var display = whole ? MarkdownBlock.withoutComments(String(region)) : String(region)
        if whole, let unclosed = display.range(of: "<!--") { display = String(display[..<unclosed.lowerBound]) }
        let fence = openFence(in: display)
        if let fence { display = withoutPartClosingFence(display, fence: fence) } else { display = escapingTrailingMarks(display) }
        let children = Array(Document(parsing: display).children)

        // A block is closed for good when another block starts after it on a complete line. A last line that is still
        // being written proves nothing: `|` after a table reads as a new paragraph and `| Moss | 5 |` as one more row.
        // Lines 1 to `lineBreaks` are complete; what follows the last line break is still being written.
        let lines = region.split(separator: "\n", omittingEmptySubsequences: false)
        let lineBreaks = lines.count - 1
        var stableCount = children.lastIndex { ($0.range?.lowerBound.line ?? Int.max) <= lineBreaks } ?? 0
        // A complete blank line closes a paragraph, a heading, a rule, and a closed code fence, whatever follows.
        if let closed = children.indices.last(where: { index in
            guard let end = children[index].range?.upperBound.line, end < lineBreaks, lines[end].allSatisfy(\.isWhitespace) else { return false }
            return closesAtBlankLine(children[index], in: display, canBeOpen: fence != nil && index == children.count - 1)
        }) { stableCount = max(stableCount, closed + 1) }
        var pendingStart = text.utf8.count
        var pendingLine = line + lineBreaks
        if stableCount < children.count {
            if let first = children[stableCount].range?.lowerBound.line, let offset = utf8Offset(ofLine: first, in: region) {
                pendingStart = start + offset
                pendingLine = line + first - 1
            } else {
                // The parser gave no place for the block: nothing more is taken as stable this time.
                stableCount = 0
                pendingStart = start
                pendingLine = line
            }
        }

        var blocks = kept
        for (index, child) in children.enumerated() {
            guard var content = MarkdownBlock.block(child, lineOffset: line) else { continue }
            let stable = index < stableCount, last = index == children.count - 1
            if !stable, last, fence == nil { content = content.changingLastText(MarkdownBlock.withoutUnfinishedLink) }
            blocks.append(Block(id: blocks.count, content: content, isStable: stable, hasOpenFence: !stable && last && fence != nil))
        }
        return MarkdownDocument(source: text, blocks: blocks, pendingStart: pendingStart, pendingLine: pendingLine, parsesWhole: whole, grows: true)
    }

    /// A link reference definition or a footnote definition (a line such as `[name]: address`) gives earlier text a
    /// link, and an HTML comment is removed across blocks, so with either the whole text is parsed.
    static func changesEarlierBlocks(_ text: Substring) -> Bool {
        text.contains("<!--") || text.contains(/(?m)^ {0,3}\[[^\]\n]+\]:/)
    }

    /// The code fence that is open at the end of the text, if one is. It reads fence lines only, also inside quotes and
    /// list items, and is used to mark the last block and to choose the repairs; the parser decides the blocks.
    static func openFence(in text: String) -> (mark: Character, count: Int)? {
        var open: (mark: Character, count: Int)?
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var rest = line.drop { $0 == " " || $0 == "\t" }
            while rest.first == ">" { rest = rest.dropFirst().drop { $0 == " " } }
            if let fence = open {
                let count = rest.prefix { $0 == fence.mark }.count
                if count >= fence.count, rest.dropFirst(count).allSatisfy({ $0 == " " || $0 == "\t" || $0 == "\r" }) { open = nil }
                continue
            }
            if let marker = rest.prefixMatch(of: /(?:[-*+]|\d{1,9}[.)])[ \t]+/) { rest = rest[marker.range.upperBound...] }
            guard let mark = rest.first, mark == "`" || mark == "~" else { continue }
            let count = rest.prefix { $0 == mark }.count
            guard count >= 3, !(mark == "`" && rest.dropFirst(count).contains("`")) else { continue }
            open = (mark, count)
        }
        return open
    }

    /// Inside an open fence, a last line with only some of the closing marks is left out until the fence closes.
    private static func withoutPartClosingFence(_ text: String, fence: (mark: Character, count: Int)) -> String {
        let lineStart = text.lastIndex(of: "\n").map(text.index(after:)) ?? text.startIndex
        let last = text[lineStart...].drop { $0 == " " || $0 == "\t" }
        guard lineStart > text.startIndex, !last.isEmpty, last.count < fence.count, last.allSatisfy({ $0 == fence.mark }) else { return text }
        return String(text[..<lineStart])
    }

    /// Emphasis marks at the very end can be half of a longer mark (`*` of `**`), so they are escaped in the copy.
    private static func escapingTrailingMarks(_ text: String) -> String {
        let run = text.reversed().prefix { $0 == "*" || $0 == "_" || $0 == "~" }.count
        guard run > 0 else { return text }
        let head = text.dropLast(run)
        // The owner already escaped the mark, or the line is indented code, where a backslash would show.
        guard head.reversed().prefix(while: { $0 == "\\" }).count % 2 == 0 else { return text }
        let lastLine = text[(text.lastIndex(of: "\n").map(text.index(after:)) ?? text.startIndex)...]
        guard !lastLine.hasPrefix("    "), !lastLine.hasPrefix("\t") else { return text }
        return String(head) + text.suffix(run).map { "\\\($0)" }.joined()
    }

    /// A blank line closes these for good. A code block counts only when it is fenced and closed: an indented one can
    /// go on after a blank line, and so can the last block while a fence is open (`canBeOpen`).
    private static func closesAtBlankLine(_ markup: Markup, in display: String, canBeOpen: Bool) -> Bool {
        if markup is Paragraph || markup is Heading || markup is ThematicBreak { return true }
        guard !canBeOpen, markup is CodeBlock, let line = markup.range?.lowerBound.line, let offset = utf8Offset(ofLine: line, in: display[...]) else { return false }
        let first = display[display.utf8.index(display.utf8.startIndex, offsetBy: offset)...].drop { $0 == " " }
        return first.hasPrefix("```") || first.hasPrefix("~~~")
    }

    /// Where line `line` (from 1) starts in the text, as a UTF-8 offset.
    private static func utf8Offset(ofLine line: Int, in text: Substring) -> Int? {
        guard line > 1 else { return line == 1 ? 0 : nil }
        var seen = 0, offset = 0
        for byte in text.utf8 {
            offset += 1
            if byte == UInt8(ascii: "\n") {
                seen += 1
                if seen == line - 1 { return offset }
            }
        }
        return nil
    }
}

extension MarkdownBlock {
    /// The block with `change` applied to its last text: the place where a text that grows is still being written.
    func changingLastText(_ change: (AttributedString) -> AttributedString) -> MarkdownBlock {
        switch self {
        case .heading(let level, let text): return .heading(level: level, text: change(text))
        case .paragraph(let text): return .paragraph(change(text))
        case .list(let ordered, let start, var items):
            guard var item = items.last, let inner = item.blocks.last else { return self }
            item.blocks[item.blocks.count - 1] = inner.changingLastText(change)
            items[items.count - 1] = item
            return .list(ordered: ordered, start: start, items: items)
        case .quote(var blocks):
            guard let inner = blocks.last else { return self }
            blocks[blocks.count - 1] = inner.changingLastText(change)
            return .quote(blocks)
        case .callout(let kind, let title, var blocks):
            guard let inner = blocks.last else { return self }
            blocks[blocks.count - 1] = inner.changingLastText(change)
            return .callout(kind: kind, title: title, blocks: blocks)
        case .table(var header, var rows, let alignments):
            if var row = rows.last, let cell = row.last {
                row[row.count - 1] = change(cell)
                rows[rows.count - 1] = row
            } else if let cell = header.last {
                header[header.count - 1] = change(cell)
            }
            return .table(header: header, rows: rows, alignments: alignments)
        case .code, .mermaid, .rule: return self
        }
    }

    /// A link whose address is still being written (`[text](https://exam`) shows as typed: the part of an address it
    /// has so far is not made a link.
    static func withoutUnfinishedLink(_ text: AttributedString) -> AttributedString {
        let plain = String(text.characters)
        guard let open = plain.range(of: "](", options: .backwards), !plain[open.upperBound...].contains(")") else { return text }
        var result = text
        let lower = result.characters.index(result.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: open.lowerBound))
        result[lower..<result.endIndex].link = nil
        return result
    }

    /// Every code block in the block, with its language.
    func code(into found: inout [(language: String?, text: String)]) {
        switch self {
        case .code(let language, let text): found.append((language, text))
        case .list(_, _, let items): for item in items { for block in item.blocks { block.code(into: &found) } }
        case .quote(let blocks), .callout(_, _, let blocks): for block in blocks { block.code(into: &found) }
        case .heading, .paragraph, .mermaid, .table, .rule: break
        }
    }
}

/// The parsed blocks of the texts shown lately, shared by every Markdown view, so a text is parsed once.
enum MarkdownCache {
    private static let documents = RecentCache<String, MarkdownDocument>(limit: 400, costLimit: 2_000_000)
    /// A view parses a new text longer than this off the main actor, and shows what it had until then.
    static let longText = 3_000

    static func cached(_ text: String) -> MarkdownDocument? { documents[text] }
    static func has(_ text: String) -> Bool { documents.contains(text) }
    static var count: Int { documents.count }

    /// The text's blocks, parsed now if they are not kept. It can be called from any thread.
    static func document(_ text: String) -> MarkdownDocument {
        if let cached = documents[text] { return cached }
        let signpost = RenderSignposts.markdown.beginInterval("parse", "\(text.utf8.count) bytes")
        let document = MarkdownDocument.complete(text)
        RenderSignposts.markdown.endInterval("parse", signpost)
        documents.set(document, for: text, cost: text.utf8.count + 256)
        return document
    }

    /// Parses the texts that are not kept yet, off the main actor, so the views that show them find them ready.
    static func prepare(_ texts: [String]) async {
        let missing = texts.filter { !documents.contains($0) }
        guard !missing.isEmpty else { return }
        await Task.detached(priority: .userInitiated) { for text in missing { _ = document(text) } }.value
    }

    static func removeAll() { documents.removeAll() }
}
