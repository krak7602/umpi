import JavaScriptCore
import SwiftUI
import UIKit

/// Colors code with highlight.js (BSD-3-Clause, bundled) running in JavaScriptCore. The result is native text in an
/// Xcode-like palette for light and dark mode. A block without a language is detected; unknown or long code stays plain.
@MainActor
final class SyntaxHighlighter {
    static let shared = SyntaxHighlighter()
    private lazy var context: JSContext? = {
        guard let url = Bundle.main.url(forResource: "highlight.min", withExtension: "js"), let script = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext() else { return nil }
        context.evaluateScript(script)
        return context.objectForKeyedSubscript("hljs").isUndefined ? nil : context
    }()
    private var cache: [String: AttributedString] = [:]

    func highlight(_ code: String, language: String?) -> AttributedString {
        let key = "\(language ?? "")\u{0}\(code)"
        if let cached = cache[key] { return cached }
        var result = AttributedString(code)
        if code.count <= 20_000, let html = html(code, language: language) { result = SyntaxHighlighter.attributed(html) }
        if cache.count > 200 { cache.removeAll() }
        cache[key] = result
        return result
    }

    private func html(_ code: String, language: String?) -> String? {
        guard let context, let hljs = context.objectForKeyedSubscript("hljs") else { return nil }
        let name = language?.lowercased().trimmingCharacters(in: .whitespaces) ?? ""
        if !name.isEmpty, hljs.invokeMethod("getLanguage", withArguments: [name])?.isUndefined == false {
            let options = JSValue(object: ["language": name, "ignoreIllegals": true], in: context)!
            return hljs.invokeMethod("highlight", withArguments: [code, options])?.objectForKeyedSubscript("value")?.toString()
        }
        // Detection needs a few lines to be reliable.
        guard name.isEmpty || name == "code", code.split(separator: "\n").count >= 2 else { return nil }
        let result = hljs.invokeMethod("highlightAuto", withArguments: [code])
        guard let relevance = result?.objectForKeyedSubscript("relevance")?.toInt32(), relevance >= 5 else { return nil }
        return result?.objectForKeyedSubscript("value")?.toString()
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
        func ui(_ hex: UInt32) -> UIColor { UIColor(red: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1) }
        return Color(UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
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
