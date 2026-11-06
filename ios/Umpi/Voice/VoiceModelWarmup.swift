import Foundation
#if os(iOS)
import UIKit
#endif

/// After an install, an update, or a new system version, Core ML compiles each model again for this device's Neural
/// Engine (minutes for Phonon-2 on an iPhone 13). Apps cannot run anything while they install, so the first time the
/// app comes to the front on a new build, the chosen voice models are prepared in the background, before voice mode is
/// needed. Once ready they are unloaded again unless voice mode is open, so they hold no memory; Core ML keeps the
/// compiled result, and voice mode then loads them in about two seconds. Unfinished, it runs again next time.
@MainActor
enum VoiceModelWarmup {
    private static let key = "voice.preparedFor"
    private static var running = false

    /// This build of the app on this system version.
    static var build: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = "\(info["CFBundleShortVersionString"] ?? "")-\(info["CFBundleVersion"] ?? "")"
        // Builds of the same version differ in their executable; its date tells them apart.
        let executable = Bundle.main.executableURL.flatMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }
        return "\(version)-\(Int(executable?.timeIntervalSince1970 ?? 0))-\(ProcessInfo.processInfo.operatingSystemVersionString)"
    }

    /// Prepares the chosen, downloaded models when this build has not prepared them yet.
    static func run() {
        let build = build
        guard !running, UserDefaults.standard.string(forKey: key) != build else { return }
        let settings = VoiceSettings.shared
        let kokoro = settings.kokoroVoice != nil && KokoroVoice.downloaded
        let phonon = settings.usesPhonon && PhononTranscriber.downloaded
        guard kokoro || phonon else { UserDefaults.standard.set(build, forKey: key); return }
        running = true
        voiceLog("new build: preparing voice models in the background (natural voice: \(kokoro), Phonon-2: \(phonon))")
        #if os(iOS)
        // A little time to keep going if the owner leaves the app; the rest happens the next time it opens.
        let background = UIApplication.shared.beginBackgroundTask(withName: "voice models")
        #endif
        Task {
            let started = Date()
            var ready = true
            if kokoro {
                do { try await KokoroVoice.shared.prepare() } catch { ready = false }
            }
            if phonon {
                do { try await PhononTranscriber.shared.prepare() } catch { ready = false }
            }
            if ready { UserDefaults.standard.set(build, forKey: key) }
            voiceLog(String(format: "new build: voice models %@ after %.0f s", ready ? "prepared" : "not all prepared", Date().timeIntervalSince(started)))
            // Kept loaded only while voice mode is open.
            if !VoiceConversation.active {
                await KokoroVoice.shared.unload()
                await PhononTranscriber.shared.unload()
            }
            running = false
            #if os(iOS)
            UIApplication.shared.endBackgroundTask(background)
            #endif
        }
    }
}
