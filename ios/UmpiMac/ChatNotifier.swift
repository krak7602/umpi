import Foundation

/// Which chat entries become Mac notifications, and how their text reads there. Kept free of app state so it can be
/// tested on its own.
enum ChatNotices {
    /// Umpi's entries after `baseline`, oldest first. The owner's own messages never notify, and neither does an
    /// approval's outcome note (the chat shows the card itself).
    static func fresh<Entry>(_ entries: [Entry], after baseline: Int, seq: (Entry) -> Int, role: (Entry) -> String, id: (Entry) -> String) -> [Entry] {
        entries
            .filter { seq($0) > baseline && role($0) == "umpi" }
            .filter { !(id($0).hasPrefix("umpi:t3-request:") && id($0).hasSuffix(":outcome")) }
            .sorted { seq($0) < seq($1) }
    }

    /// The newest position to remember after a read: the highest one seen, never lower than before.
    static func baseline(_ previous: Int?, seqs: [Int]) -> Int { max(previous ?? 0, seqs.max() ?? 0) }

    /// A Markdown message as one short plain line for a notification.
    static func preview(_ markdown: String, limit: Int = 200) -> String {
        var text = markdown
        // What Umpi marks to be seen is a table, code, or a list: not worth a notification line.
        text = text.replacingOccurrences(of: #"(?s)```.*?(```|$)"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\[\[([^\]|]*\|)?([^\]]*)\]\]"#, with: "$2", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^\s{0,3}(#{1,6}|>|[-*+]( \[[ xX]\])?|\d+\.)\s+"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"[*_`~|]|=="#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        guard text.count > limit else { return text }
        let cut = text.prefix(limit)
        let end = cut.lastIndex(of: " ").map { cut[..<$0] } ?? cut
        return end.trimmingCharacters(in: .whitespaces) + "…"
    }
}
