import JavaScriptCore
import os
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Colors code with highlight.js (BSD-3-Clause, bundled) running in JavaScriptCore. The result is native text in an
/// Xcode-like palette for light and dark mode. A block without a language is detected; unknown or long code stays plain.
///
/// The script runs on a queue of its own, never on the main actor: a view draws its code plain, asks for the colours
/// with `highlighted`, and reads them from `cached` when it draws again. The last 200 results are kept; the one used
/// longest ago is dropped first.
final class SyntaxHighlighter: @unchecked Sendable {
    static let shared = SyntaxHighlighter()
    /// Longer code stays plain.
    static let longestCode = 20_000
    /// A block without a language is detected from its first characters only, up to this many: detection tries every
    /// language the script has.
    static let detectionSample = 1_500

    private struct Key: Hashable { var language: String; var code: String }
    private let cache = RecentCache<Key, AttributedString>(limit: 200)
    /// Everything below runs on this queue.
    private let queue = DispatchQueue(label: "umpi.highlight", qos: .userInitiated)
    private var context: JSContext?
    private var loaded = false

    /// The colored code, if it has been colored already.
    func cached(_ code: String, language: String?) -> AttributedString? {
        cache[Key(language: language ?? "", code: code)]
    }

    /// The colored code. It waits for the script, so call it off the main actor; a view uses `highlighted`.
    func highlight(_ code: String, language: String?) -> AttributedString {
        if let cached = cached(code, language: language) { return cached }
        return queue.sync { color(code, language: language) }
    }

    /// The colored code, worked out off the caller's actor.
    func highlighted(_ code: String, language: String?) async -> AttributedString {
        if let cached = cached(code, language: language) { return cached }
        return await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.color(code, language: language)) }
        }
    }

    /// Colors the code in the background, so a view that shows it later finds the colours ready.
    func warm(_ code: String, language: String?) {
        guard cached(code, language: language) == nil else { return }
        queue.async { _ = self.color(code, language: language) }
    }

    func removeAll() { cache.removeAll() }

    private func color(_ code: String, language: String?) -> AttributedString {
        let key = Key(language: language ?? "", code: code)
        if let cached = cache[key] { return cached }
        let signpost = RenderSignposts.highlight.beginInterval("highlight", "\(code.utf8.count) bytes")
        defer { RenderSignposts.highlight.endInterval("highlight", signpost) }
        var result = AttributedString(code)
        if code.count <= Self.longestCode, let html = html(code, language: language) { result = SyntaxHighlighter.attributed(html) }
        cache.set(result, for: key)
        return result
    }

    private func script() -> JSContext? {
        if loaded { return context }
        loaded = true
        let signpost = RenderSignposts.highlight.beginInterval("load script")
        defer { RenderSignposts.highlight.endInterval("load script", signpost) }
        guard let url = Bundle.main.url(forResource: "highlight.min", withExtension: "js"), let script = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext() else { return nil }
        context.evaluateScript(script)
        self.context = context.objectForKeyedSubscript("hljs").isUndefined ? nil : context
        return self.context
    }

    private func html(_ code: String, language: String?) -> String? {
        guard let context = script(), let hljs = context.objectForKeyedSubscript("hljs") else { return nil }
        let name = language?.lowercased().trimmingCharacters(in: .whitespaces) ?? ""
        if !name.isEmpty, hljs.invokeMethod("getLanguage", withArguments: [name])?.isUndefined == false {
            return html(code, as: name, hljs, context)
        }
        // Detection needs a few lines to be reliable.
        guard name.isEmpty || name == "code", code.split(separator: "\n").count >= 2 else { return nil }
        let sample = Self.sample(code)
        let result = hljs.invokeMethod("highlightAuto", withArguments: [sample])
        guard let relevance = result?.objectForKeyedSubscript("relevance")?.toInt32(), relevance >= 5 else { return nil }
        if sample.count == code.count { return result?.objectForKeyedSubscript("value")?.toString() }
        // The language found in the sample colors the whole block.
        guard let found = result?.objectForKeyedSubscript("language"), found.isString, let detected = found.toString() else { return nil }
        return html(code, as: detected, hljs, context)
    }

    private func html(_ code: String, as language: String, _ hljs: JSValue, _ context: JSContext) -> String? {
        let options = JSValue(object: ["language": language, "ignoreIllegals": true], in: context)!
        return hljs.invokeMethod("highlight", withArguments: [code, options])?.objectForKeyedSubscript("value")?.toString()
    }

    /// The start of the code that detection reads: whole lines, up to `detectionSample` characters.
    static func sample(_ code: String) -> String {
        guard code.count > detectionSample else { return code }
        let head = code.prefix(detectionSample)
        guard let lineEnd = head.lastIndex(of: "\n"), lineEnd > head.startIndex else { return String(head) }
        return String(head[..<lineEnd])
    }

    /// highlight.js HTML (nested spans with `hljs-*` classes and escaped text) to colored text.
    static func attributed(_ html: String) -> AttributedString {
        var result = AttributedString()
        var stack: [String] = []
        var index = html.startIndex
        while index < html.endIndex {
            if html[index] == "<" {
                guard let close = html[index...].firstIndex(of: ">") else { break }
                let tag = html[html.index(after: index)..<close]
                if tag.hasPrefix("/") { _ = stack.popLast() }
                else if let match = tag.firstMatch(of: /class="([^"]*)"/) { stack.append(String(match.1)) }
                else { stack.append("") }
                index = html.index(after: close)
                continue
            }
            let next = html[index...].firstIndex(of: "<") ?? html.endIndex
            var run = AttributedString(unescape(String(html[index..<next])))
            if let color = color(for: stack) { run.foregroundColor = color }
            if stack.contains(where: { $0.contains("hljs-comment") || $0.contains("hljs-quote") }) { run.inlinePresentationIntent = .emphasized }
            result += run
            index = next
        }
        return result
    }
    private static func unescape(_ text: String) -> String {
        text.replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#x27;", with: "'")
            .replacingOccurrences(of: "&#39;", with: "'").replacingOccurrences(of: "&amp;", with: "&")
    }
    private static func color(for stack: [String]) -> Color? {
        for classes in stack.reversed() where !classes.isEmpty {
            for name in classes.split(separator: " ") {
                if let color = palette[String(name).replacingOccurrences(of: "hljs-", with: "")] { return color }
            }
        }
        return nil
    }
    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        #if canImport(UIKit)
        func ui(_ hex: UInt32) -> UIColor { UIColor(red: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1) }
        return Color(UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
        #else
        func ns(_ hex: UInt32) -> NSColor { NSColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1) }
        return Color(NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? ns(dark) : ns(light) })
        #endif
    }
    /// Close to Xcode's default themes.
    private static let palette: [String: Color] = {
        let keyword = dynamic(0x9B2393, 0xFF7AB2), string = dynamic(0xC41A16, 0xFF8170), number = dynamic(0x1C00CF, 0xD9C97C)
        let comment = dynamic(0x5D6C79, 0x7F8C98), type = dynamic(0x0B4F79, 0x6BDFFF), function = dynamic(0x326D74, 0x67B7A4)
        let attribute = dynamic(0x815F03, 0xBF8555), variable = dynamic(0x3900A0, 0xA167E6), meta = dynamic(0x643820, 0xFD8F3F)
        return ["keyword": keyword, "built_in": type, "literal": keyword, "type": type, "class": type, "title": function,
                "function": function, "string": string, "regexp": string, "char": string, "subst": variable, "number": number,
                "comment": comment, "quote": comment, "doctag": comment, "attr": attribute, "attribute": attribute,
                "property": variable, "variable": variable, "params": variable, "meta": meta, "tag": keyword, "name": keyword,
                "selector-tag": keyword, "selector-class": type, "selector-id": type, "symbol": number, "bullet": meta,
                "section": function, "addition": dynamic(0x1A7F37, 0x7EE787), "deletion": dynamic(0xCF222E, 0xFF7B72), "link": type]
    }()
}
