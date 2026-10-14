import BackgroundTasks
import Foundation

/// This is only an opportunistic wakeup. The server and owner UI remain authoritative.
@MainActor
final class BackgroundSync {
    private let identifier = (Bundle.main.bundleIdentifier ?? "com.example.umpi") + ".refresh"
    private var registered = false
    var synchronize: (@MainActor () async -> Bool)?
    var reportStatus: (@MainActor (String) -> Void)?

    func register() {
        guard !registered else { return }
        registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { [weak self] task in
            MainActor.assumeIsolated {
                guard let self, let refresh = task as? BGAppRefreshTask else {
                    task.setTaskCompleted(success: false)
                    return
                }
                self.handle(refresh)
            }
        }
    }

    func schedule() {
        guard registered else {
            reportStatus?("Background refresh handler is not registered")
            return
        }
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date().addingTimeInterval(15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
            reportStatus?("Background refresh requested; iOS decides whether and when it runs")
        } catch {
            reportStatus?("Background refresh is unavailable or denied; open Umpi to synchronize")
        }
    }

    private func handle(_ task: BGAppRefreshTask) {
        schedule()
        let completion = BackgroundCompletion(task: task)
        let operation = Task { [weak self] in
            let succeeded = await self?.synchronize?() ?? false
            completion.finish(success: succeeded && !Task.isCancelled)
        }
        task.expirationHandler = {
            operation.cancel()
            Task { @MainActor in completion.finish(success: false) }
        }
    }
}

@MainActor
private final class BackgroundCompletion {
    private var task: BGTask?

    init(task: BGTask) { self.task = task }

    func finish(success: Bool) {
        guard let task else { return }
        self.task = nil
        task.setTaskCompleted(success: success)
    }
}
