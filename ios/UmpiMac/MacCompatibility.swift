import AppKit
import SwiftUI

// Mac stand-ins for the iOS-only names the shared screens use. Each one either has no meaning on the Mac (the
// keyboard type, an inline navigation bar title) or maps to the nearest Mac equivalent (system colors, toolbar places).

extension NSColor {
    static var systemBackground: NSColor { .windowBackgroundColor }
    static var secondarySystemBackground: NSColor { .quaternarySystemFill }
    static var separator: NSColor { .separatorColor }
}

enum NavigationBarTitleDisplayModeStandIn { case automatic, inline, large }
enum KeyboardTypeStandIn { case `default`, URL, numbersAndPunctuation, numberPad, decimalPad, emailAddress }
enum TextInputAutocapitalizationStandIn { case never, words, sentences, characters }

extension View {
    /// The Mac has no navigation bar; titles show in the window or sidebar.
    func navigationBarTitleDisplayMode(_ mode: NavigationBarTitleDisplayModeStandIn) -> some View { self }
    /// A Mac keyboard has every key.
    func keyboardType(_ type: KeyboardTypeStandIn) -> some View { self }
    /// Mac text fields do not capitalize on their own.
    func textInputAutocapitalization(_ style: TextInputAutocapitalizationStandIn?) -> some View { self }
}

extension ToolbarItemPlacement {
    static var topBarTrailing: ToolbarItemPlacement { .primaryAction }
    static var topBarLeading: ToolbarItemPlacement { .navigation }
}
