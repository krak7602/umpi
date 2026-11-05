#if os(iOS)
import AppIntents

/// Opens Umpi straight into voice mode. Discoverable, so it is in the Shortcuts app, Siri, and Settings › Accessibility
/// › Touch › Back Tap, where a double tap on the back of the phone can run it; apps cannot assign Back Tap themselves.
struct TalkToUmpiIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Umpi"
    static let description = IntentDescription("Opens Umpi in voice mode, ready to listen.")
    static let openAppWhenRun = true

    @MainActor func perform() async throws -> some IntentResult {
        // The same route as the widget's Talk button: kept until the app's screens are ready, so a cold launch keeps it.
        UmpiRoute.request("talk")
        return .result()
    }
}

/// Handed to the app's scene before the app comes to the front, as `OpenUmpiAction` is.
@available(iOS 26.0, *)
extension TalkToUmpiIntent: TargetContentProvidingIntent {}

/// Umpi's actions that need no setup in the Shortcuts app.
struct UmpiShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: TalkToUmpiIntent(), phrases: ["Talk to \(.applicationName)", "Open \(.applicationName) voice mode"],
                    shortTitle: "Talk to Umpi", systemImageName: "waveform")
    }
}
#endif
