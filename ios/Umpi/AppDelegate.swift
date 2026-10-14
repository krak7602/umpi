import Foundation
import UIKit
import UserNotifications

@MainActor
final class UmpiAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    // Created before didFinishLaunching so silent-push/BG launches do not depend on a SwiftUI scene.
    let store = CompanionStore()
    let capabilities = DeviceCapabilities()
    private let backgroundSync = BackgroundSync()
    private var attached = false

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        attach(store: store, capabilities: capabilities)
        backgroundSync.register()
        application.registerForRemoteNotifications()
        return true
    }

    func attach(store: CompanionStore, capabilities: DeviceCapabilities) {
        guard !attached else { return }
        attached = true
        capabilities.attach(store: store)
        store.configureEffects(capabilities: { [weak capabilities] in
            await capabilities?.refreshCapabilities() ?? []
        }, execute: { [weak capabilities, weak store] action in
            guard let capabilities, let store else {
                return DeviceEffectOutcome(status: "pending", result: "Device runtime is not attached")
            }
            return await capabilities.execute(action: action, jobs: store.jobs)
        }, onSnapshot: { [weak capabilities] jobs in
            await capabilities?.updateJobs(jobs)
        })
        backgroundSync.synchronize = { [weak self] in await self?.synchronize() ?? false }
        backgroundSync.reportStatus = { [weak capabilities] status in capabilities?.setBackgroundStatus(status) }
    }

    @discardableResult
    func synchronize() async -> Bool {
        guard store.isPaired, !Task.isCancelled else { return false }
        let previous = store.lastSyncedAt
        await capabilities.registerCurrentState()
        guard !Task.isCancelled else { return false }
        await store.synchronize()
        return store.lastSyncedAt != previous
    }

    func scheduleBackgroundRefresh() { backgroundSync.schedule() }

    func applicationDidEnterBackground(_ application: UIApplication) { scheduleBackgroundRefresh() }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await capabilities.receivePushToken(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Provider errors can contain identifiers. Surface a bounded explanation, never log tokens/errors.
        capabilities.pushRegistrationFailed()
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        // Push payloads are wakeup hints, not executable device actions or authoritative job state.
        let completion = FetchCompletion(completionHandler)
        let work = Task { [weak self] in
            let changed = await self?.synchronize() ?? false
            completion.finish(Task.isCancelled ? .failed : (changed ? .newData : .noData))
        }
        Task {
            try? await Task.sleep(for: .seconds(25))
            work.cancel()
            completion.finish(.failed)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
        Task { @MainActor [weak self] in await self?.synchronize() }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        // No approve/cancel notification actions: protected reviews live in trusted app UI only.
        completionHandler()
        Task { @MainActor [weak self] in await self?.synchronize() }
    }
}

@MainActor
private final class FetchCompletion {
    private var handler: ((UIBackgroundFetchResult) -> Void)?

    init(_ handler: @escaping (UIBackgroundFetchResult) -> Void) { self.handler = handler }

    func finish(_ result: UIBackgroundFetchResult) {
        guard let handler else { return }
        self.handler = nil
        handler(result)
    }
}
