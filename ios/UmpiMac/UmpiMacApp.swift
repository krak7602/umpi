import AppKit
import SwiftUI

/// Umpi on the Mac: the phone app's chat, Today, Work, settings, and voice mode in a window, a floating chat panel on
/// global shortcuts, and a menu bar item that keeps Umpi running with its window closed.
@main
struct UmpiMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuBarMenu().environment(MacApp.shared).environment(MacApp.shared.store)
        } label: {
            // The voice orb's three flowing layers, as a template image that macOS tints for the menu bar.
            Image("MenuBarIcon").accessibilityLabel("Umpi")
        }
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { MacApp.shared.showMain(.settings) }.keyboardShortcut(",")
            }
            CommandGroup(replacing: .newItem) {
                Button("New Message") { MacApp.shared.newMessage() }.keyboardShortcut("n")
            }
            // The View menu: the sidebar's sections, as Mac apps number them.
            CommandGroup(before: .sidebar) {
                ForEach(MacSection.allCases) { section in
                    Button(section.title) { MacApp.shared.showMain(section) }
                        .keyboardShortcut(KeyEquivalent(Character(String(section.number))))
                }
                Divider()
            }
            CommandGroup(after: .windowArrangement) {
                Button("Umpi Window") { MacApp.shared.showMain() }.keyboardShortcut("0")
            }
        }
    }
}

/// The menu bar item's menu.
private struct MenuBarMenu: View {
    @Environment(MacApp.self) private var app
    @Environment(CompanionStore.self) private var store

    var body: some View {
        item("Chat with Umpi", .chat) { app.showPanel(.chat) }
        item("Talk to Umpi", .voice) { app.showPanel(.voice) }
        Divider()
        Button("Open Umpi") { app.showMain() }
        Button("Settings…") { app.showMain(.settings) }
        Divider()
        // Always quits, also when quitting from the window only closes it.
        Button("Quit Umpi") { app.quitCompletely() }.keyboardShortcut("q")
    }

    /// A menu item that shows its global shortcut, when the menu can show that key.
    @ViewBuilder private func item(_ title: String, _ action: ShortcutSettings.Action, perform: @escaping () -> Void) -> some View {
        let button = Button(title, action: perform).disabled(!store.isPaired)
        if let shortcut = ShortcutSettings.shortcut(for: action), let character = shortcut.menuCharacter {
            button.keyboardShortcut(KeyEquivalent(character), modifiers: EventModifiers(shortcut.eventModifiers))
        } else {
            button
        }
    }
}

private extension EventModifiers {
    init(_ flags: NSEvent.ModifierFlags) {
        self = []
        if flags.contains(.control) { insert(.control) }
        if flags.contains(.option) { insert(.option) }
        if flags.contains(.shift) { insert(.shift) }
        if flags.contains(.command) { insert(.command) }
    }
}
