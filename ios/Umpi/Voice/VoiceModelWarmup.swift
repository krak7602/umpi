import Foundation
#if os(iOS)
import BackgroundTasks
import UIKit
#endif

/// Downloads and prepares voice models so that they keep going when the owner leaves the app or locks the phone.
///
/// After an install, an update, or a new system version, Core ML compiles each model again for this device's Neural
/// Engine (minutes for Phonon-2 on an iPhone 13). Apps cannot run anything while they install, so the first time the
/// app comes to the front on a new build, the chosen models are prepared. On iOS 26 and later this is a continued
/// processing task: iOS keeps it running in the background and shows its progress, which must keep moving, so a compile
/// (which reports none) is shown against how long the last one took. Once ready, models are unloaded unless voice mode
/// is open, so they hold no memory; Core ML keeps the compiled result, and voice mode loads them in about two seconds.
/// Unfinished, it runs again the next time the app opens. The Mac keeps running in the menu bar, so it needs none of this.
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
        voiceLog("new build: preparing voice models (natural voice: \(kokoro), Phonon-2: \(phonon))")
        prepare(kokoro: kokoro, phonon: phonon, markBuild: build)
    }

    /// Downloads (the first time) and prepares models; chosen in settings, or after a new build.
    static func prepare(kokoro: Bool, phonon: Bool, markBuild: String? = nil) {
        guard kokoro || phonon else { return }
        guard !running else {
            // Already under way for another model: these join it, as each model prepares once at a time.
            Task { if kokoro { try? await KokoroVoice.shared.prepare() }; if phonon { try? await PhononTranscriber.shared.prepare() } }
            return
        }
        running = true
        #if os(iOS)
        if #available(iOS 26.0, *), submitInBackground(kokoro: kokoro, phonon: phonon, markBuild: markBuild) { return }
        // Earlier systems: about 30 s after leaving the app, then it continues the next time.
        let background = UIApplication.shared.beginBackgroundTask(withName: "voice models")
        Task {
            await work(kokoro: kokoro, phonon: phonon, markBuild: markBuild, report: nil)
            UIApplication.shared.endBackgroundTask(background)
        }
        #else
        Task { await work(kokoro: kokoro, phonon: phonon, markBuild: markBuild, report: nil) }
        #endif
    }

    /// The preparation itself. `report` receives the overall fraction done and what is happening, about once a second.
    private static func work(kokoro: Bool, phonon: Bool, markBuild: String?, report: ((Double, String) -> Void)?) async -> Bool {
        let started = Date()
        let ticker = report.map { report in
            Task {
                let kokoroStart = Date()
                var phononStart: Date?
                while !Task.isCancelled {
                    let status = VoiceModelStatus.shared
                    if phonon, phononStart == nil, status.phonon == .preparing { phononStart = Date() }
                    let (fraction, detail) = progress(kokoro: kokoro ? status.kokoro : nil, phonon: phonon ? status.phonon : nil,
                                                      kokoroFor: Date().timeIntervalSince(kokoroStart), phononFor: phononStart.map { Date().timeIntervalSince($0) } ?? 0)
                    report(fraction, detail)
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
        var ready = true
        if kokoro { do { try await KokoroVoice.shared.prepare() } catch { ready = false } }
        if phonon { do { try await PhononTranscriber.shared.prepare() } catch { ready = false } }
        ticker?.cancel()
        if ready, let markBuild { UserDefaults.standard.set(markBuild, forKey: key) }
        voiceLog(String(format: "voice models %@ after %.0f s", ready ? "prepared" : "not all prepared", Date().timeIntervalSince(started)))
        // Kept loaded only while voice mode is open.
        if !VoiceConversation.active {
            await KokoroVoice.shared.unload()
            await PhononTranscriber.shared.unload()
        }
        running = false
        return ready
    }

    /// The share of the work done: a download's own fraction, and a compile against how long the last one took here.
    private static func progress(kokoro: KokoroVoice.State?, phonon: PhononTranscriber.State?, kokoroFor: TimeInterval, phononFor: TimeInterval) -> (Double, String) {
        func estimate(_ seconds: TimeInterval, key: String, fallback: TimeInterval) -> Double {
            let expected = UserDefaults.standard.double(forKey: key)
            return min(0.95, seconds / (expected > 0 ? expected : fallback))
        }
        // Weights: Phonon-2's compile is most of the time.
        let kokoroWeight = phonon == nil ? 1.0 : (kokoro == nil ? 0 : 0.15)
        var done = 0.0, detail = ""
        if let kokoro {
            switch kokoro {
            case .downloading(let fraction): done += kokoroWeight * fraction * 0.5; detail = "Natural voice · downloading \(Int(fraction * 100))%"
            case .preparing: done += kokoroWeight * (0.5 + 0.5 * estimate(kokoroFor, key: "kokoro.prepareSeconds", fallback: 45)); detail = "Natural voice · preparing"
            default: done += kokoroWeight
            }
        }
        if let phonon {
            let weight = 1 - kokoroWeight
            switch phonon {
            case .downloading(let fraction): done += weight * fraction * 0.3; detail = "Recognition · downloading \(Int(fraction * 100))%"
            case .preparing:
                let expected = UserDefaults.standard.double(forKey: "phonon.prepareSeconds")
                done += weight * (0.3 + 0.7 * estimate(phononFor, key: "phonon.prepareSeconds", fallback: 420))
                let left = max(0, (expected > 0 ? expected : 420) - phononFor)
                detail = left > 60 ? "Recognition · preparing, about \(Int((left / 60).rounded(.up))) min" : "Recognition · preparing, almost done"
            case .ready: done += weight
            default: break
            }
        }
        return (min(done, 0.99), detail)
    }

    #if os(iOS)
    /// Starts the work as a continued processing task, which iOS keeps running in the background with its progress
    /// shown; false when iOS will not start one now.
    @available(iOS 26.0, *)
    private static func submitInBackground(kokoro: Bool, phonon: Bool, markBuild: String?) -> Bool {
        guard let bundle = Bundle.main.bundleIdentifier else { return false }
        let identifier = "\(bundle).voice-models.\(UUID().uuidString.prefix(8))"
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            guard let task = task as? BGContinuedProcessingTask else { task.setTaskCompleted(success: false); return }
            MainActor.assumeIsolated {
                task.progress.totalUnitCount = 1000
                let job = Task {
                    let ready = await work(kokoro: kokoro, phonon: phonon, markBuild: markBuild) { fraction, detail in
                        task.progress.completedUnitCount = Int64(fraction * 1000)
                        task.updateTitle("Preparing voice models", subtitle: detail)
                    }
                    task.progress.completedUnitCount = 1000
                    task.setTaskCompleted(success: ready)
                }
                // iOS can stop it (low power, the owner swipes it away): it runs again the next time the app opens.
                task.expirationHandler = {
                    voiceLog("voice models: iOS stopped the background preparation; it continues the next time Umpi opens")
                    job.cancel()
                }
            }
        }
        guard registered else { voiceLog("voice models: background preparation not registered"); return false }
        let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: "Preparing voice models", subtitle: "So voice mode is ready")
        request.strategy = .fail
        do {
            try BGTaskScheduler.shared.submit(request)
            voiceLog("voice models: preparing in the background with progress shown")
            return true
        } catch {
            voiceLog("voice models: background preparation refused (\(error.localizedDescription)); preparing while the app is open")
            return false
        }
    }
    #endif
}
