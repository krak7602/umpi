import AppKit
import Carbon.HIToolbox

/// A global keyboard shortcut: a key and its modifiers, as Carbon's hot keys take them. It reads and writes the way the
/// Mac shows shortcuts, such as "⌥Space" or "⌃⌥⇧K", which is also how it is stored.
struct Shortcut: Equatable, Hashable, Sendable {
    /// A virtual key code (`kVK_…`).
    var keyCode: UInt32
    /// Carbon modifier bits: `cmdKey`, `optionKey`, `controlKey`, `shiftKey`.
    var modifiers: UInt32

    static let chatDefault = Shortcut(keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey))
    static let voiceDefault = Shortcut(keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey | shiftKey))

    init(keyCode: UInt32, modifiers: UInt32) {
        self.keyCode = keyCode
        self.modifiers = modifiers & Self.allModifiers
    }

    /// A key pressed in the recorder. Nil when it cannot be a global shortcut: it needs Control, Option, or Command
    /// (Shift alone would take a typed character from every app), except for function keys. Escape is kept for
    /// cancelling.
    init?(keyCode: UInt16, flags: NSEvent.ModifierFlags) {
        let shortcut = Shortcut(keyCode: UInt32(keyCode), modifiers: Self.carbonModifiers(flags))
        guard shortcut.isAllowed else { return nil }
        self = shortcut
    }

    /// Reads the displayed form, such as "⌥⇧Space"; nil for anything else.
    init?(_ text: String) {
        var rest = Substring(text.trimmingCharacters(in: .whitespaces))
        var modifiers: UInt32 = 0
        while let first = rest.first, let bit = Self.symbols.first(where: { $0.symbol == first })?.bit {
            modifiers |= bit
            rest = rest.dropFirst()
        }
        guard let code = Self.keys.first(where: { $0.name.caseInsensitiveCompare(rest) == .orderedSame })?.code else { return nil }
        let shortcut = Shortcut(keyCode: code, modifiers: modifiers)
        guard shortcut.isAllowed else { return nil }
        self = shortcut
    }

    /// As the Mac writes it, and as it is stored: modifiers in the order ⌃⌥⇧⌘, then the key.
    var display: String { keycaps.joined() }

    /// Each key on its own, in the same order, for drawing as keycaps: ["⌥", "⇧", "Space"].
    var keycaps: [String] {
        Self.symbols.filter { modifiers & $0.bit != 0 }.map { String($0.symbol) } + [keyName]
    }

    /// For tooltips and sentences: the keys with thin spaces between them, such as "⌥ ⇧ Space".
    var spaced: String { keycaps.joined(separator: "\u{2009}") }

    var keyName: String { Self.keys.first { $0.code == keyCode }?.name ?? "Key \(keyCode)" }

    var isAllowed: Bool {
        guard keyCode != UInt32(kVK_Escape), Self.keys.contains(where: { $0.code == keyCode }) else { return false }
        return modifiers & UInt32(cmdKey | optionKey | controlKey) != 0 || Self.functionKeys.contains(keyCode)
    }

    /// The character a menu item shows for this key, when it has one.
    var menuCharacter: Character? {
        if keyCode == UInt32(kVK_Space) { return " " }
        let name = keyName
        guard name.count == 1, let character = name.lowercased().first, character.isLetter || character.isNumber else { return nil }
        return character
    }

    static func carbonModifiers(_ flags: NSEvent.ModifierFlags) -> UInt32 {
        var bits: UInt32 = 0
        if flags.contains(.control) { bits |= UInt32(controlKey) }
        if flags.contains(.option) { bits |= UInt32(optionKey) }
        if flags.contains(.shift) { bits |= UInt32(shiftKey) }
        if flags.contains(.command) { bits |= UInt32(cmdKey) }
        return bits
    }

    var eventModifiers: NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if modifiers & UInt32(controlKey) != 0 { flags.insert(.control) }
        if modifiers & UInt32(optionKey) != 0 { flags.insert(.option) }
        if modifiers & UInt32(shiftKey) != 0 { flags.insert(.shift) }
        if modifiers & UInt32(cmdKey) != 0 { flags.insert(.command) }
        return flags
    }

    private static let allModifiers = UInt32(cmdKey | optionKey | controlKey | shiftKey)
    private static let symbols: [(symbol: Character, bit: UInt32)] = [
        ("⌃", UInt32(controlKey)), ("⌥", UInt32(optionKey)), ("⇧", UInt32(shiftKey)), ("⌘", UInt32(cmdKey)),
    ]
    private static let functionKeys: Set<UInt32> = Set([kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
                                                        kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19].map(UInt32.init))
    /// Key names for the US layout's key positions, which Carbon hot keys use.
    private static let keys: [(code: UInt32, name: String)] = {
        let named: [(Int, String)] = [
            (kVK_ANSI_A, "A"), (kVK_ANSI_B, "B"), (kVK_ANSI_C, "C"), (kVK_ANSI_D, "D"), (kVK_ANSI_E, "E"), (kVK_ANSI_F, "F"),
            (kVK_ANSI_G, "G"), (kVK_ANSI_H, "H"), (kVK_ANSI_I, "I"), (kVK_ANSI_J, "J"), (kVK_ANSI_K, "K"), (kVK_ANSI_L, "L"),
            (kVK_ANSI_M, "M"), (kVK_ANSI_N, "N"), (kVK_ANSI_O, "O"), (kVK_ANSI_P, "P"), (kVK_ANSI_Q, "Q"), (kVK_ANSI_R, "R"),
            (kVK_ANSI_S, "S"), (kVK_ANSI_T, "T"), (kVK_ANSI_U, "U"), (kVK_ANSI_V, "V"), (kVK_ANSI_W, "W"), (kVK_ANSI_X, "X"),
            (kVK_ANSI_Y, "Y"), (kVK_ANSI_Z, "Z"),
            (kVK_ANSI_0, "0"), (kVK_ANSI_1, "1"), (kVK_ANSI_2, "2"), (kVK_ANSI_3, "3"), (kVK_ANSI_4, "4"),
            (kVK_ANSI_5, "5"), (kVK_ANSI_6, "6"), (kVK_ANSI_7, "7"), (kVK_ANSI_8, "8"), (kVK_ANSI_9, "9"),
            (kVK_ANSI_Minus, "-"), (kVK_ANSI_Equal, "="), (kVK_ANSI_LeftBracket, "["), (kVK_ANSI_RightBracket, "]"),
            (kVK_ANSI_Semicolon, ";"), (kVK_ANSI_Quote, "'"), (kVK_ANSI_Comma, ","), (kVK_ANSI_Period, "."),
            (kVK_ANSI_Slash, "/"), (kVK_ANSI_Backslash, "\\"), (kVK_ANSI_Grave, "`"),
            (kVK_Space, "Space"), (kVK_Return, "Return"), (kVK_Tab, "Tab"), (kVK_Delete, "Delete"), (kVK_Escape, "Escape"),
            (kVK_LeftArrow, "←"), (kVK_RightArrow, "→"), (kVK_UpArrow, "↑"), (kVK_DownArrow, "↓"),
            (kVK_F1, "F1"), (kVK_F2, "F2"), (kVK_F3, "F3"), (kVK_F4, "F4"), (kVK_F5, "F5"), (kVK_F6, "F6"), (kVK_F7, "F7"),
            (kVK_F8, "F8"), (kVK_F9, "F9"), (kVK_F10, "F10"), (kVK_F11, "F11"), (kVK_F12, "F12"), (kVK_F13, "F13"),
            (kVK_F14, "F14"), (kVK_F15, "F15"), (kVK_F16, "F16"), (kVK_F17, "F17"), (kVK_F18, "F18"), (kVK_F19, "F19"),
        ]
        return named.map { (UInt32($0.0), $0.1) }
    }()
}

/// The two global shortcuts, kept in this Mac's user defaults in their displayed form. An empty value turns one off.
enum ShortcutSettings {
    enum Action: String, CaseIterable, Sendable {
        case chat, voice
        var title: String { self == .chat ? "Chat with Umpi" : "Talk to Umpi" }
        var fallback: Shortcut { self == .chat ? .chatDefault : .voiceDefault }
        var key: String { "shortcut.\(rawValue)" }
    }

    static func shortcut(for action: Action, in defaults: UserDefaults = .standard) -> Shortcut? {
        guard let stored = defaults.string(forKey: action.key) else { return action.fallback }
        return Shortcut(stored)
    }

    static func set(_ shortcut: Shortcut?, for action: Action, in defaults: UserDefaults = .standard) {
        defaults.set(shortcut?.display ?? "", forKey: action.key)
    }
}
