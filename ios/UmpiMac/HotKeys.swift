import AppKit
import Carbon.HIToolbox

/// Global shortcuts through Carbon's hot keys, which work from any app without Accessibility permission. The system
/// gives a registered key combination to Umpi only; other apps no longer receive it.
@MainActor
final class HotKeys {
    private var references: [ShortcutSettings.Action: EventHotKeyRef] = [:]
    private var handler: EventHandlerRef?
    var onPress: ((ShortcutSettings.Action) -> Void)?

    private static let signature: OSType = 0x554D_5049 // "UMPI"
    private static func number(_ action: ShortcutSettings.Action) -> UInt32 { action == .chat ? 1 : 2 }

    init() {
        var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard status == noErr, id.signature == HotKeys.signature else { return OSStatus(eventNotHandledErr) }
            let number = id.id
            // Carbon delivers hot key events on the main thread.
            MainActor.assumeIsolated {
                let keys = Unmanaged<HotKeys>.fromOpaque(context).takeUnretainedValue()
                if let action = ShortcutSettings.Action.allCases.first(where: { HotKeys.number($0) == number }) { keys.onPress?(action) }
            }
            return noErr
        }, 1, &pressed, context, &handler)
    }

    /// Registers the saved shortcuts. Returns the actions whose shortcut the system refused, such as one already taken.
    @discardableResult func registerSaved() -> [ShortcutSettings.Action] {
        ShortcutSettings.Action.allCases.filter { !register(ShortcutSettings.shortcut(for: $0), for: $0) }
    }

    /// Replaces an action's shortcut; nil turns it off. False when the system refused it.
    func register(_ shortcut: Shortcut?, for action: ShortcutSettings.Action) -> Bool {
        unregister(action)
        guard let shortcut else { return true }
        var reference: EventHotKeyRef?
        let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, EventHotKeyID(signature: Self.signature, id: Self.number(action)),
                                         GetApplicationEventTarget(), 0, &reference)
        guard status == noErr, let reference else { return false }
        references[action] = reference
        return true
    }

    func unregister(_ action: ShortcutSettings.Action) {
        if let reference = references.removeValue(forKey: action) { UnregisterEventHotKey(reference) }
    }

    /// While a new shortcut is recorded, the current ones are off, so pressing one records it instead of running it.
    func pause() { ShortcutSettings.Action.allCases.forEach(unregister) }
}
