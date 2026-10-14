import Foundation
import Observation

@MainActor @Observable
final class CompanionStore {
    private var state = CompanionDiskState()
    private(set) var isPaired = false
    private(set) var hasPendingPairing = false
    private(set) var serverURL = ""
    private(set) var deviceID = ""
    private(set) var isRefreshing = false
    private(set) var errorMessage: String?
    private(set) var statusMessage = "Not paired"
    private(set) var capabilities: [Capability] = []

    @ObservationIgnored private let vault: any CredentialVault
    @ObservationIgnored private let persistence: CompanionPersistence?
    @ObservationIgnored private let transportFactory: (URL, String?) -> any CompanionTransport
    @ObservationIgnored private var credentials: PairCredentials?
    @ObservationIgnored private var client: (any CompanionTransport)?
    @ObservationIgnored private var isFlushing = false
    @ObservationIgnored private var isSynchronizing = false
    @ObservationIgnored private var isPairing = false
    @ObservationIgnored private var sendingID: String?
    @ObservationIgnored private var runningIDs: Set<String> = []
    @ObservationIgnored private var executingIDs: Set<String> = []
    @ObservationIgnored private var sessionGeneration = 0
    @ObservationIgnored private var stateEpoch = 0
    @ObservationIgnored private var storageReady = true
    @ObservationIgnored private var successfulRefreshCount = 0
    private static let timestampFormatter = ISO8601DateFormatter()
    @ObservationIgnored private var capabilityProvider: (@MainActor () async -> [Capability])?
    @ObservationIgnored private var effectExecutor: (@MainActor (DeviceAction) async -> DeviceEffectOutcome)?
    @ObservationIgnored private var snapshotObserver: (@MainActor ([Job]) async -> Void)?

    init(directory: URL? = nil, vault: any CredentialVault = KeychainCredentialVault(),
         transportFactory: @escaping (URL, String?) -> any CompanionTransport = { CompanionClient(server: $0, token: $1) }) {
        self.vault = vault
        self.transportFactory = transportFactory
        var storage: CompanionPersistence?
        do { storage = try CompanionPersistence(directory: directory) }
        catch { errorMessage = "Local storage is unavailable. No changes will be sent." }
        persistence = storage
        do {
            credentials = try vault.load()
            if let credentials {
                let origin = try CompanionClient.validateServer(credentials.server)
                serverURL = credentials.server
                deviceID = credentials.deviceID
                hasPendingPairing = credentials.pendingCode != nil
                isPaired = !hasPendingPairing
                if isPaired { client = transportFactory(origin, credentials.token) }
                if let saved = try storage?.load(CompanionDiskState.self), saved.deviceID == credentials.deviceID {
                    state = saved
                }
                state.deviceID = credentials.deviceID
                capabilities = state.snapshot?.device.capabilities ?? []
                statusMessage = hasPendingPairing ? "Pairing needs recovery" : "Cached state — refresh to synchronize"
            }
        } catch {
            storageReady = false
            errorMessage = "Stored pairing or local state could not be read. Unlock the device before trying again."
        }
    }

    var workflows: [Workflow] { state.snapshot?.workflows ?? [] }
    var jobs: [Job] { state.snapshot?.jobs ?? [] }
    var choices: [Choice] { state.snapshot?.choices ?? [] }
    var reminders: [Reminder] { state.snapshot?.reminders ?? [] }
    var operations: [Operation] { state.snapshot?.operations ?? [] }
    var conflicts: [WorkflowConflict] { state.conflicts }
    var runs: [WorkflowRun] { state.runs }
    var lastSyncedAt: Date? { state.lastSyncedAt }
    var queuedCount: Int { state.outbox.count }
    var remoteEffectsAllowed: Bool {
        get { state.remoteEffectsAllowed }
        set { state.remoteEffectsAllowed = newValue; _ = persist() }
    }
    var pendingDeviceActions: [DeviceAction] {
        var byID = Dictionary(uniqueKeysWithValues: (state.snapshot?.actions ?? []).filter { $0.status == "pending" }.map { ($0.id, $0) })
        for (id, var action) in state.localActions where action.status == "pending" {
            action.isLocal = true
            byID[id] = action
        }
        return byID.values.filter { state.effectOutcomes[$0.id] == nil }.sorted { $0.createdAt < $1.createdAt }
    }

    func clearError() { errorMessage = nil }
    func workflow(id: String) -> Workflow? { workflows.first { $0.id == id } }
    func draftValues(for workflowID: String) -> [String: FieldValue] {
        state.drafts[workflowID]?.fields.mapValues(\.value) ?? [:]
    }
    func displayedValues(for workflowID: String) -> [String: FieldValue] {
        (workflow(id: workflowID)?.values ?? [:]).merging(draftValues(for: workflowID)) { _, draft in draft }
    }
    func orphanedDrafts(for workflowID: String) -> [String: FieldValue] {
        let visible = Set(workflow(id: workflowID)?.definition.fields.map(\.id) ?? [])
        return draftValues(for: workflowID).filter { !visible.contains($0.key) }
    }
    var orphanedWorkflowDrafts: [OrphanedWorkflowDraft] {
        let knownIDs = Set(workflows.map(\.id))
        return state.drafts.filter { !knownIDs.contains($0.key) && !$0.value.fields.isEmpty }
            .map { OrphanedWorkflowDraft(id: $0.key, values: $0.value.fields.mapValues(\.value)) }
            .sorted { $0.id < $1.id }
    }
    func discardWorkflowDraft(id: String) {
        state.drafts.removeValue(forKey: id)
        _ = persist()
    }
    func setDraft(workflowID: String, fieldID: String, value: FieldValue) {
        guard let workflow = workflow(id: workflowID) else { report("The workflow is no longer available. Existing drafts remain stored."); return }
        var draft = state.drafts[workflowID] ?? WorkflowDraft(baseRevision: workflow.revision, fields: [:])
        draft.fields[fieldID] = FieldDraft(value: value, editID: UUID().uuidString)
        state.drafts[workflowID] = draft
        _ = persist()
    }
    func discardDraft(workflowID: String, fieldID: String) {
        state.drafts[workflowID]?.fields.removeValue(forKey: fieldID)
        if state.drafts[workflowID]?.fields.isEmpty == true { state.drafts.removeValue(forKey: workflowID) }
        _ = persist()
    }

    func saveDraft(workflowID: String) async {
        guard let draft = state.drafts[workflowID], !draft.fields.isEmpty else { return }
        guard !hasPendingMutation(workflowID) else { report("A change for this workflow is already queued. Your newer draft is still saved locally."); return }
        let mutation = CompanionMutation(operationId: UUID().uuidString, workflowId: workflowID,
            expectedRevision: draft.baseRevision, kind: "set_values", values: draft.fields.mapValues(\.value))
        guard enqueueMutation(mutation, edits: draft.fields.mapValues(\.editID)) else { return }
        await flushOutbox()
    }

    @discardableResult func createWorkflow(title: String, fields: [FieldDefinition]) async -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, fields.count <= 32 else { report("A workflow needs a title and at most 32 fields."); return false }
        let id = UUID().uuidString
        let definition = WorkflowDefinition(id: id, title: title, fields: fields, actions: [])
        let mutation = CompanionMutation(operationId: UUID().uuidString, workflowId: id,
            expectedRevision: 0, kind: "create", definition: definition, values: [:])
        guard enqueueMutation(mutation) else { return false }
        await flushOutbox()
        return true
    }

    func updateDefinition(workflowID: String, definition: WorkflowDefinition) async {
        guard definition.id == workflowID else { report("A definition must retain its workflow identifier."); return }
        await mutateWorkflow(id: workflowID, kind: "define", definition: definition)
    }
    func archiveWorkflow(id: String) async { await mutateWorkflow(id: id, kind: "archive") }
    func restoreWorkflow(id: String) async { await mutateWorkflow(id: id, kind: "restore") }
    func removeWorkflow(id: String) async { await mutateWorkflow(id: id, kind: "remove") }

    private func mutateWorkflow(id: String, kind: String, definition: WorkflowDefinition? = nil) async {
        guard let workflow = workflow(id: id) else { report("The workflow is no longer available."); return }
        guard !hasPendingMutation(id) else { report("Resolve the queued change before making another change to this workflow."); return }
        let mutation = CompanionMutation(operationId: UUID().uuidString, workflowId: id,
            expectedRevision: workflow.revision, kind: kind, definition: definition)
        guard enqueueMutation(mutation) else { return }
        await flushOutbox()
    }

    func resolveConflict(id: String, keepLocal: Bool) async {
        guard let index = state.outbox.firstIndex(where: { $0.id == id }),
              case .mutation(let old, let edits) = state.outbox[index].payload,
              let conflict = state.conflicts.first(where: { $0.id == id }) else { return }
        if keepLocal {
            // This revision change is permitted ONLY by this explicit owner decision.
            guard let current = conflict.current, old.kind != "create" else {
                report("The workflow was removed or its identity already exists. Your draft is retained; create a new workflow explicitly.")
                return
            }
            var replacement = old
            replacement.operationId = UUID().uuidString
            replacement.expectedRevision = current.revision
            state.outbox[index] = OutboxEntry(id: replacement.operationId, payload: .mutation(replacement, edits: edits))
            for i in state.runs.indices where state.runs[i].waitingOperationID == id && state.runs[i].status != "cancelled" {
                state.runs[i].waitingOperationID = replacement.operationId
                state.runs[i].status = "waiting"
                state.runs[i].error = nil
            }
        } else {
            // Only the submitted edits are discarded. Typing that happened later survives this choice.
            clearSubmittedDraft(old.workflowId, edits: edits, acceptedRevision: nil, expectedRevision: old.expectedRevision)
            state.outbox.remove(at: index)
            for i in state.runs.indices where state.runs[i].waitingOperationID == id {
                state.runs[i].status = "cancelled"
                state.runs[i].error = "Stopped by owner conflict resolution. Completed effects were not reversed."
            }
        }
        state.conflicts.removeAll { $0.id == id }
        guard persist() else { return }
        await synchronize()
    }

    @discardableResult func requestAgent(text: String) async -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, DeviceActionValidation.text(text, limit: 16_384) else {
            report("Enter a request of at most 16,384 characters without null characters."); return false
        }
        let message = MessageRequest(id: UUID().uuidString, text: text)
        guard enqueue(OutboxEntry(id: message.id, payload: .message(message))) else { return false }
        await flushOutbox()
        return true
    }
    @discardableResult func approveJob(id: String, version: Int) async -> Bool { await decideJob(id: id, version: version, decision: "approve") }
    @discardableResult func cancelJob(id: String, version: Int) async -> Bool { await decideJob(id: id, version: version, decision: "cancel") }
    private func decideJob(id: String, version: Int, decision: String) async -> Bool {
        guard let job = jobs.first(where: { $0.id == id }), job.version == version,
              decision != "approve" || job.status == "pending_approval" else {
            report("This job changed. Review its latest exact command before deciding."); return false
        }
        guard enqueue(OutboxEntry(id: UUID().uuidString, payload: .job(id: id, decision: decision, version: version))) else { return false }
        await flushOutbox()
        return true
    }
    func answerChoice(id: String, answer: String) async {
        guard let choice = choices.first(where: { $0.id == id }), choice.status == "pending" else {
            report("This choice is no longer available."); return
        }
        let answer = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard DeviceActionValidation.identifier(id), DeviceActionValidation.text(answer, limit: 16_384),
              !answer.hasPrefix("/") else {
            report("Enter an ordinary answer of at most 16,384 characters, not a slash command."); return
        }
        guard enqueue(OutboxEntry(id: UUID().uuidString, payload: .choice(id: id, answer: answer))) else { return }
        await flushOutbox()
    }

    func configureEffects(capabilities: @escaping @MainActor () async -> [Capability],
                          execute: @escaping @MainActor (DeviceAction) async -> DeviceEffectOutcome,
                          onSnapshot: (@MainActor ([Job]) async -> Void)? = nil) {
        capabilityProvider = capabilities
        effectExecutor = execute
        snapshotObserver = onSnapshot
    }

    func pair(server: String, code: String, label: String = "Companion") async {
        guard !isPaired, credentials == nil, !isPairing else {
            report(hasPendingPairing ? "Recover or disconnect the pending pairing before starting another." : "Disconnect the current device before pairing again."); return
        }
        isPairing = true
        let generation = sessionGeneration
        defer { if generation == sessionGeneration { isPairing = false } }
        do {
            guard try vault.load() == nil, storageReady else {
                report("An existing identity or unreadable local state must be recovered before pairing. Unlock and reopen the app."); return
            }
            let origin = try CompanionClient.validateServer(server)
            let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !code.isEmpty else { report("Enter the one-use pairing code."); return }
            if let capabilityProvider { capabilities = await capabilityProvider() }
            guard generation == sessionGeneration, !Task.isCancelled else { return }
            let pending = PairCredentials(server: origin.absoluteString, deviceID: UUID().uuidString,
                label: label.isEmpty ? "Companion" : label, token: try KeychainCredentialVault.randomToken(),
                pendingCode: code, pendingCapabilities: capabilities)
            // The recoverable claim is in Keychain before the first byte goes to the server.
            try vault.save(pending)
            credentials = pending
            serverURL = pending.server
            deviceID = pending.deviceID
            hasPendingPairing = true
            state = CompanionDiskState(deviceID: pending.deviceID)
            guard persist() else { return }
            isPairing = false
            await recoverPendingPairing()
        } catch { report(error.localizedDescription) }
    }

    func recoverPendingPairing() async {
        guard !isPairing, var pending = credentials, let code = pending.pendingCode else { return }
        isPairing = true
        let generation = sessionGeneration
        defer { if generation == sessionGeneration { isPairing = false } }
        do {
            struct Claim: Encodable { var code: String; var deviceId: String; var label: String; var token: String; var capabilities: [Capability] }
            struct ClaimResult: Decodable { var deviceId: String }
            let origin = try CompanionClient.validateServer(pending.server)
            let anonymous = transportFactory(origin, nil)
            let data = try await anonymous.send(path: "/api/device/pair", method: "POST", body: try JSONEncoder().encode(
                Claim(code: code, deviceId: pending.deviceID, label: pending.label, token: pending.token,
                    capabilities: pending.pendingCapabilities ?? [])))
            guard generation == sessionGeneration else { return }
            let result = try JSONDecoder().decode(ClaimResult.self, from: data)
            guard result.deviceId == pending.deviceID else { throw CompanionClientError.invalidResponse }
            pending.pendingCode = nil
            pending.pendingCapabilities = nil
            try vault.save(pending)
            credentials = pending
            client = transportFactory(origin, pending.token)
            hasPendingPairing = false
            isPaired = true
            statusMessage = "Paired"
            errorMessage = nil
            await synchronize()
        } catch {
            if generation == sessionGeneration {
                report("Pairing was not confirmed. The pending identity is retained for safe recovery. \(error.localizedDescription)")
            }
        }
    }

    func disconnect() async {
        var oldClient = client
        if oldClient == nil, let credentials, let origin = try? CompanionClient.validateServer(credentials.server) {
            // A lost pairing reply may still have created this server-side device.
            oldClient = transportFactory(origin, credentials.token)
        }
        // Remove local authority first, so in-flight replies cannot restore the old identity.
        do { try vault.clear() } catch { report(error.localizedDescription); return }
        sessionGeneration += 1
        isPairing = false
        isRefreshing = false
        isSynchronizing = false
        isFlushing = false
        sendingID = nil
        credentials = nil
        client = nil
        isPaired = false
        hasPendingPairing = false
        serverURL = ""
        deviceID = ""
        capabilities = []
        state = CompanionDiskState()
        stateEpoch += 1
        do { try persistence?.clear(); storageReady = true }
        catch { storageReady = false; report("Disconnected, but local storage could not be removed.") }
        statusMessage = "Disconnected"
        if let oldClient {
            do { _ = try await oldClient.send(path: "/api/device/session", method: "DELETE", body: nil) }
            catch { report("Disconnected locally. Server revocation was not confirmed; revoke this device from the trusted control interface.") }
        }
    }

    func refresh() async {
        guard let client, !isRefreshing else { return }
        isRefreshing = true
        let generation = sessionGeneration
        defer { if generation == sessionGeneration { isRefreshing = false } }
        let epoch = stateEpoch
        do {
            let data = try await client.send(path: "/api/device/state", method: "GET", body: nil)
            guard generation == sessionGeneration else { return }
            let snapshot = try JSONDecoder().decode(DeviceSnapshot.self, from: data)
            guard snapshot.protocolVersion == 1, snapshot.device.id == deviceID, !snapshot.device.revoked,
                  snapshot.revision >= 0 else { throw CompanionClientError.invalidResponse }
            // A reply started before a local accepted mutation must not replace its newer result.
            guard epoch == stateEpoch, snapshot.revision >= (state.snapshot?.revision ?? 0) else { return }
            state.snapshot = snapshot
            state.lastSyncedAt = Date()
            for i in state.conflicts.indices {
                state.conflicts[i].current = snapshot.workflows.first { $0.id == state.conflicts[i].workflowID }
            }
            guard persist() else { return }
            successfulRefreshCount += 1
            statusMessage = state.outbox.isEmpty ? "Up to date" : "\(state.outbox.count) changes need synchronization"
            errorMessage = nil
            if let snapshotObserver { await snapshotObserver(snapshot.jobs) }
        } catch {
            if generation == sessionGeneration { report("Refresh failed. Cached state and drafts are retained. \(error.localizedDescription)") }
        }
    }

    func synchronize() async {
        guard !isSynchronizing, isPaired, !Task.isCancelled else { return }
        isSynchronizing = true
        let generation = sessionGeneration
        defer { if generation == sessionGeneration { isSynchronizing = false } }
        let refreshCountBeforeSync = successfulRefreshCount
        await refresh()
        guard !Task.isCancelled, generation == sessionGeneration else { return }
        if let capabilityProvider {
            let current = await capabilityProvider()
            guard generation == sessionGeneration else { return }
            await register(capabilities: current)
        }
        await flushOutbox()
        guard generation == sessionGeneration else { return }
        for id in state.runs.filter({ ["running", "waiting"].contains($0.status) }).map(\.id) { await driveRun(id) }
        if successfulRefreshCount != refreshCountBeforeSync { await processPendingEffects() }
        await flushOutbox()
    }

    func register(capabilities: [Capability], apnsToken: String? = nil, apnsEnvironment: String? = nil,
                  activityTokens: [ActivityToken]? = nil, activityJobIds: [String]? = nil) async {
        self.capabilities = capabilities
        guard let client else { return }
        let generation = sessionGeneration
        do {
            let body = DeviceRegistration(capabilities: capabilities, apnsToken: apnsToken,
                apnsEnvironment: apnsEnvironment, activityTokens: activityTokens, activityJobIds: activityJobIds)
            _ = try await client.send(path: "/api/device/register", method: "POST", body: JSONEncoder().encode(body))
            guard generation == sessionGeneration else { return }
        } catch { if generation == sessionGeneration { report("Device registration was not confirmed. \(error.localizedDescription)") } }
    }

    func acknowledgeAction(id: String, status: String, result: String? = nil, retryableWithoutEffect: Bool? = nil) async {
        guard ["applied", "failed", "permission_required", "unsupported", "conflict", "uncertain"].contains(status) else {
            report("An effect acknowledgment must report an actual terminal outcome."); return
        }
        guard state.localActions[id] != nil || state.snapshot?.actions.contains(where: { $0.id == id && $0.deviceId == deviceID }) == true else {
            report("The effect does not belong to this device."); return
        }
        state.effectOutcomes[id] = DeviceEffectOutcome(status: status, result: result, retryableWithoutEffect: retryableWithoutEffect)
        if state.localActions[id] != nil {
            state.localActions[id]?.status = status
            state.localActions[id]?.result = result
        }
        let ackID = "ack:\(id)"
        let entry = OutboxEntry(id: ackID, payload: .acknowledgment(actionID: id, ActionAcknowledgment(status: status, result: result)))
        if let existing = state.outbox.firstIndex(where: { $0.id == ackID }) { state.outbox[existing] = entry }
        else { state.outbox.append(entry) }
        guard persist() else { return }
        await flushOutbox()
        for run in state.runs where run.nextStep < run.stepIDs.count && run.stepIDs[run.nextStep] == id {
            if status == "applied" { advanceRun(run.id); await driveRun(run.id) }
            else { stopRun(run.id, status: "failed", message: result ?? status) }
        }
    }

    private func processPendingEffects() async {
        guard let effectExecutor else { return }
        for action in pendingDeviceActions where !executingIDs.contains(action.id) {
            guard !Task.isCancelled else { return }
            // Local run progression owns its effects; remote snapshot effects come through here.
            if action.isLocal { continue }
            executingIDs.insert(action.id)
            let generation = sessionGeneration
            guard persist() else { executingIDs.remove(action.id); return }
            let outcome = await effectExecutor(action)
            executingIDs.remove(action.id)
            guard generation == sessionGeneration else { return }
            if outcome.status != "pending" {
                await acknowledgeAction(id: action.id, status: outcome.status, result: outcome.result,
                                        retryableWithoutEffect: outcome.retryableWithoutEffect)
            }
        }
    }

    private func hasPendingMutation(_ workflowID: String) -> Bool {
        state.outbox.contains {
            if case .mutation(let mutation, _) = $0.payload { return mutation.workflowId == workflowID }
            return false
        }
    }
    @discardableResult private func enqueueMutation(_ mutation: CompanionMutation, edits: [String: String] = [:]) -> Bool {
        enqueue(OutboxEntry(id: mutation.operationId, payload: .mutation(mutation, edits: edits)))
    }
    @discardableResult private func enqueue(_ entry: OutboxEntry) -> Bool {
        guard isPaired else { report("Pair this device before sending changes."); return false }
        if case .action(let action) = entry.payload,
           !DeviceActionValidation.valid(id: action.id, deviceID: deviceID, capability: action.capability, input: action.input) {
            report("Invalid device action input. No effect or queued request was created."); return false
        }
        if !state.outbox.contains(where: { $0.id == entry.id }) { state.outbox.append(entry) }
        statusMessage = "\(state.outbox.count) changes queued"
        return persist()
    }

    var queuedChanges: [QueuedChange] {
        state.outbox.map { entry in
            let kind: String
            let target: String
            switch entry.payload {
            case .mutation(let mutation, _): kind = mutation.kind; target = mutation.workflowId
            case .message: kind = "message"; target = "Agent request"
            case .action(let action): kind = "device_action"; target = action.capability
            case .acknowledgment(let id, _): kind = "acknowledgment"; target = id
            case .job(let id, let decision, _): kind = "job_\(decision)"; target = id
            case .choice(let id, _): kind = "choice"; target = id
            }
            return QueuedChange(id: entry.id, kind: kind, target: target, status: entry.status, error: entry.error)
        }
    }

    func retryQueuedChange(id: String) async {
        guard let index = state.outbox.firstIndex(where: { $0.id == id }), state.outbox[index].status == "failed" else { return }
        if case .job = state.outbox[index].payload {
            report("Review the current exact job command again. Stale job decisions cannot be retried."); return
        }
        state.outbox[index].status = "queued"
        state.outbox[index].error = nil
        guard persist() else { return }
        await flushOutbox()
    }

    func discardQueuedChange(id: String) {
        guard sendingID != id else { report("This request is already in flight. Wait for its result before discarding it."); return }
        guard let entry = state.outbox.first(where: { $0.id == id }) else { return }
        if case .acknowledgment = entry.payload {
            report("Device effect receipts must be retained until the server acknowledges them."); return
        }
        if case .action(let action) = entry.payload, state.effectOutcomes[action.id] != nil {
            report("An effect already has a local outcome. Its registration and receipt must be synchronized."); return
        }
        state.outbox.removeAll { $0.id == id }
        state.conflicts.removeAll { $0.id == id }
        for index in state.runs.indices where state.runs[index].waitingOperationID == id {
            state.runs[index].status = "cancelled"
            state.runs[index].error = "The owner discarded this queued step. Local drafts are retained."
        }
        _ = persist()
    }
    @discardableResult private func persist() -> Bool {
        guard let persistence, storageReady else { report("Local storage is unavailable. No changes will be sent."); return false }
        do { try persistence.save(state); return true }
        catch { report("Could not save local state. No new network request or device effect will start."); return false }
    }
    private func report(_ message: String) { errorMessage = message }

    private func clearSubmittedDraft(_ workflowID: String, edits: [String: String], acceptedRevision: Int?, expectedRevision: Int) {
        guard var draft = state.drafts[workflowID] else { return }
        for (fieldID, editID) in edits where draft.fields[fieldID]?.editID == editID { draft.fields.removeValue(forKey: fieldID) }
        // Advancing past OUR accepted write is not a rebase onto somebody else's changes.
        if let acceptedRevision, draft.baseRevision == expectedRevision, acceptedRevision == expectedRevision + 1,
           (workflow(id: workflowID)?.revision ?? acceptedRevision) <= acceptedRevision {
            draft.baseRevision = acceptedRevision
        }
        if draft.fields.isEmpty { state.drafts.removeValue(forKey: workflowID) }
        else { state.drafts[workflowID] = draft }
    }

    private func installWorkflow(_ workflow: Workflow) {
        guard state.snapshot != nil else { return }
        if let index = state.snapshot?.workflows.firstIndex(where: { $0.id == workflow.id }) {
            if state.snapshot!.workflows[index].revision <= workflow.revision { state.snapshot!.workflows[index] = workflow }
        } else { state.snapshot?.workflows.append(workflow) }
        stateEpoch += 1
    }

    private func flushOutbox() async {
        guard !isFlushing, let client, state.snapshot != nil, !Task.isCancelled else { return }
        isFlushing = true
        let generation = sessionGeneration
        defer { if generation == sessionGeneration { isFlushing = false; sendingID = nil } }
        var attempted: Set<String> = []
        while let entry = state.outbox.first(where: { $0.status == "queued" && !attempted.contains($0.id) }) {
            guard !Task.isCancelled, generation == sessionGeneration else { return }
            sendingID = entry.id
            attempted.insert(entry.id)
            guard persist() else { return }
            do {
                let encoder = JSONEncoder()
                let decoder = JSONDecoder()
                switch entry.payload {
                case .mutation(let mutation, let edits):
                    let data = try await client.send(path: "/api/device/changes", method: "POST", body: encoder.encode(mutation))
                    guard generation == sessionGeneration else { return }
                    let acceptedRevision: Int
                    if mutation.kind == "remove" {
                        let removed = try decoder.decode(RemovedWorkflow.self, from: data)
                        guard removed.id == mutation.workflowId, removed.removed else { throw CompanionClientError.invalidResponse }
                        acceptedRevision = removed.revision
                    } else {
                        let workflow = try decoder.decode(Workflow.self, from: data)
                        guard workflow.id == mutation.workflowId else { throw CompanionClientError.invalidResponse }
                        acceptedRevision = workflow.revision
                    }
                    // Receipts prove a past write, not the current workflow. A replay can
                    // succeed after removal or a newer revision; never install its payload.
                    let refreshCount = successfulRefreshCount
                    await refresh()
                    guard generation == sessionGeneration else { return }
                    guard successfulRefreshCount > refreshCount else {
                        throw URLError(.networkConnectionLost)
                    }
                    let current = workflow(id: mutation.workflowId)
                    clearSubmittedDraft(mutation.workflowId, edits: edits,
                        acceptedRevision: current?.revision == acceptedRevision ? acceptedRevision : nil,
                        expectedRevision: mutation.expectedRevision)
                    for i in state.runs.indices where state.runs[i].waitingOperationID == entry.id && state.runs[i].status != "cancelled" {
                        if let current, !current.archived, current.revision == acceptedRevision {
                            state.runs[i].revision = current.revision
                        } else {
                            state.runs[i].waitingOperationID = nil
                            state.runs[i].status = "conflict"
                            state.runs[i].error = "The accepted step is historical. The workflow was removed, archived, or changed; remaining effects were stopped."
                        }
                    }
                case .message(let message):
                    let data = try await client.send(path: "/api/device/messages", method: "POST", body: encoder.encode(message))
                    guard generation == sessionGeneration else { return }
                    let operation = try decoder.decode(Operation.self, from: data)
                    state.snapshot?.operations.removeAll { $0.id == operation.id }
                    state.snapshot?.operations.append(operation)
                    stateEpoch += 1
                case .action(let action):
                    let data = try await client.send(path: "/api/device/actions", method: "POST", body: encoder.encode(action))
                    guard generation == sessionGeneration else { return }
                    let accepted = try decoder.decode(DeviceAction.self, from: data)
                    guard accepted.id == action.id, accepted.deviceId == deviceID else { throw CompanionClientError.invalidResponse }
                    state.snapshot?.actions.removeAll { $0.id == accepted.id }
                    state.snapshot?.actions.append(accepted)
                    stateEpoch += 1
                case .acknowledgment(let id, let acknowledgment):
                    // A local effect may have completed offline, but cannot be acked before its action is admitted.
                    if state.outbox.contains(where: { if case .action(let action) = $0.payload { return action.id == id }; return false }) { continue }
                    let data = try await client.send(path: "/api/device/actions/\(id)/ack", method: "POST", body: encoder.encode(acknowledgment))
                    guard generation == sessionGeneration else { return }
                    let action = try decoder.decode(DeviceAction.self, from: data)
                    guard action.id == id, action.deviceId == deviceID else { throw CompanionClientError.invalidResponse }
                    state.snapshot?.actions.removeAll { $0.id == id }
                    state.snapshot?.actions.append(action)
                    stateEpoch += 1
                case .job(let id, let decision, let version):
                    let data = try await client.send(path: "/api/device/jobs/\(id)/\(decision)", method: "POST", body: encoder.encode(JobDecision(version: version)))
                    guard generation == sessionGeneration else { return }
                    let job = try decoder.decode(Job.self, from: data)
                    state.snapshot?.jobs.removeAll { $0.id == job.id }
                    state.snapshot?.jobs.append(job)
                    stateEpoch += 1
                    guard persist() else { return }
                    if let snapshotObserver { await snapshotObserver(jobs) }
                case .choice(let id, let answer):
                    _ = try await client.send(path: "/api/device/choices/\(id)/answer", method: "POST", body: encoder.encode(ChoiceAnswer(answer: answer)))
                    guard generation == sessionGeneration else { return }
                    if let index = state.snapshot?.choices.firstIndex(where: { $0.id == id }) {
                        state.snapshot?.choices[index].status = "answered"
                        state.snapshot?.choices[index].answer = answer
                    }
                    stateEpoch += 1
                }
                state.outbox.removeAll { $0.id == entry.id }
                state.conflicts.removeAll { $0.id == entry.id }
                for i in state.runs.indices where state.runs[i].waitingOperationID == entry.id && ["running", "waiting"].contains(state.runs[i].status) {
                    state.runs[i].waitingOperationID = nil
                    state.runs[i].nextStep += 1
                    state.runs[i].status = "running"
                    state.runs[i].error = nil
                }
                guard persist() else { return }
                statusMessage = state.outbox.isEmpty ? "Synchronized" : "\(state.outbox.count) changes queued"
            } catch {
                guard generation == sessionGeneration else { return }
                if case CompanionClientError.http(let status, let message, let current) = error, status == 409 {
                    if case .mutation(let mutation, _) = entry.payload {
                        if let current { installWorkflow(current) }
                        state.conflicts.removeAll { $0.id == entry.id }
                        state.conflicts.append(WorkflowConflict(id: entry.id, workflowID: mutation.workflowId,
                            localValues: mutation.values ?? [:], current: current, message: message, kind: mutation.kind))
                    }
                    markEntry(entry.id, status: "conflict", error: message)
                    stopWaitingRuns(entry.id, status: "conflict", message: message)
                    report("A queued change conflicts with newer server state. Your local input is retained.")
                    guard persist() else { return }
                    continue
                }
                if let clientError = error as? CompanionClientError, !clientError.retryable {
                    markEntry(entry.id, status: "failed", error: clientError.localizedDescription)
                    stopWaitingRuns(entry.id, status: "failed", message: clientError.localizedDescription)
                    _ = persist()
                }
                report("Synchronization paused. Queued changes are retained. \(error.localizedDescription)")
                return
            }
        }
    }

    private func markEntry(_ id: String, status: String, error: String) {
        if let index = state.outbox.firstIndex(where: { $0.id == id }) {
            state.outbox[index].status = status
            state.outbox[index].error = error
        }
    }
    private func stopWaitingRuns(_ operationID: String, status: String, message: String) {
        for i in state.runs.indices where state.runs[i].waitingOperationID == operationID && state.runs[i].status != "cancelled" {
            state.runs[i].status = status
            state.runs[i].error = message
        }
    }

    func runButton(workflowID: String, buttonID: String) async {
        guard isPaired, let workflow = workflow(id: workflowID), !workflow.archived,
              let button = workflow.definition.actions.first(where: { $0.id == buttonID }) else {
            report("This workflow button is unavailable."); return
        }
        guard !state.runs.contains(where: { $0.workflowID == workflowID && !["completed", "cancelled"].contains($0.status) }) else {
            report("Finish or stop the existing run before starting another."); return
        }
        guard !hasPendingMutation(workflowID) else { report("Resolve the queued workflow change before starting its button."); return }
        let run = WorkflowRun(id: UUID().uuidString, workflowID: workflowID, buttonID: buttonID,
            title: button.title, nextStep: 0, steps: button.steps, status: "running",
            revision: state.drafts[workflowID]?.baseRevision ?? workflow.revision,
            stepIDs: button.steps.map { _ in UUID().uuidString })
        state.runs.append(run)
        guard persist() else { return }
        await driveRun(run.id)
    }

    func resumeRun(id: String) async {
        let generation = sessionGeneration
        if let capabilityProvider {
            let current = await capabilityProvider()
            guard generation == sessionGeneration else { return }
            await register(capabilities: current)
            guard generation == sessionGeneration else { return }
        }
        guard let index = state.runs.firstIndex(where: { $0.id == id }),
              !["completed", "cancelled", "conflict"].contains(state.runs[index].status) else { return }
        let run = state.runs[index]
        if run.nextStep < run.stepIDs.count, let outcome = state.effectOutcomes[run.stepIDs[run.nextStep]] {
            // Permission/unsupported receipts are emitted only at native preflight.
            // Other failures need explicit evidence that no OS operation was started.
            guard ["permission_required", "unsupported"].contains(outcome.status) ||
                    (outcome.status == "failed" && outcome.retryableWithoutEffect == true) else {
                report("This effect already has an immutable outcome. Applied or uncertain effects cannot be retried."); return
            }
            // Keep the original registration, ledger receipt and acknowledgement intact.
            // A deliberate retry is a separate action, never a conflicting second ack.
            state.runs[index].stepIDs[run.nextStep] = UUID().uuidString
        }
        if let operationID = run.waitingOperationID, let queued = state.outbox.firstIndex(where: { $0.id == operationID }), state.outbox[queued].status == "failed" {
            state.outbox[queued].status = "queued"
            state.outbox[queued].error = nil
        }
        state.runs[index].status = "running"
        state.runs[index].error = nil
        guard persist() else { return }
        await flushOutbox()
        await driveRun(id)
    }

    func cancelRun(id: String) {
        guard let index = state.runs.firstIndex(where: { $0.id == id }) else { return }
        if let waiting = state.runs[index].waitingOperationID, waiting != sendingID {
            state.outbox.removeAll { $0.id == waiting }
            state.conflicts.removeAll { $0.id == waiting }
        }
        state.runs[index].status = "cancelled"
        state.runs[index].error = "Stopped. Started steps may already have been admitted; completed device effects are not reversed."
        _ = persist()
    }

    private func advanceRun(_ id: String) {
        guard let index = state.runs.firstIndex(where: { $0.id == id }), state.runs[index].status != "cancelled" else { return }
        state.runs[index].nextStep += 1
        state.runs[index].waitingOperationID = nil
        state.runs[index].status = "running"
        state.runs[index].error = nil
        _ = persist()
    }
    private func stopRun(_ id: String, status: String, message: String?) {
        guard let index = state.runs.firstIndex(where: { $0.id == id }), state.runs[index].status != "cancelled" else { return }
        state.runs[index].status = status
        state.runs[index].error = message
        _ = persist()
    }

    private func driveRun(_ id: String) async {
        guard !runningIDs.contains(id), isPaired, !Task.isCancelled else { return }
        runningIDs.insert(id)
        defer { runningIDs.remove(id) }
        let generation = sessionGeneration
        while let run = state.runs.first(where: { $0.id == id }), ["running", "waiting"].contains(run.status) {
            guard !Task.isCancelled else { return }
            guard run.waitingOperationID == nil else { return }
            guard run.nextStep < run.steps.count else { stopRun(id, status: "completed", message: nil); return }
            guard let workflow = workflow(id: run.workflowID), !workflow.archived else {
                stopRun(id, status: "conflict", message: "The workflow was removed or archived. Drafts are retained."); return
            }
            // Never resume remaining effects against another actor's workflow revision.
            guard workflow.revision == run.revision else {
                stopRun(id, status: "conflict", message: "The workflow changed. Stop this run and review the newer workflow before starting again."); return
            }
            let step = run.steps[run.nextStep]
            let stepID = run.stepIDs[run.nextStep]
            let values = displayedValues(for: run.workflowID)
            if state.localActions[stepID] == nil, let condition = step.when {
                guard workflow.definition.fields.contains(where: { $0.id == condition.fieldId }) else {
                    stopRun(id, status: "failed", message: "The condition has an invalid field binding."); return
                }
                if (values[condition.fieldId] ?? .null) != condition.equals {
                    advanceRun(id)
                    continue
                }
            }
            switch step.kind {
            case "set_value":
                guard let fieldID = step.fieldId, let value = step.value,
                      workflow.definition.fields.contains(where: { $0.id == fieldID }) else {
                    stopRun(id, status: "failed", message: "The set-value step has an invalid field binding."); return
                }
                setDraft(workflowID: run.workflowID, fieldID: fieldID, value: value)
                guard let editID = state.drafts[run.workflowID]?.fields[fieldID]?.editID,
                      let index = state.runs.firstIndex(where: { $0.id == id }) else { return }
                let mutation = CompanionMutation(operationId: stepID, workflowId: run.workflowID,
                    expectedRevision: run.revision, kind: "set_values", values: [fieldID: value])
                state.runs[index].waitingOperationID = stepID
                state.runs[index].status = "waiting"
                guard enqueueMutation(mutation, edits: [fieldID: editID]) else { return }
                await flushOutbox()
            case "message":
                guard let text = step.text, !text.isEmpty, let index = state.runs.firstIndex(where: { $0.id == id }) else {
                    stopRun(id, status: "failed", message: "The message step is empty."); return
                }
                state.runs[index].waitingOperationID = stepID
                state.runs[index].status = "waiting"
                guard enqueue(OutboxEntry(id: stepID, payload: .message(MessageRequest(id: stepID, text: text)))) else { return }
                await flushOutbox()
            case "device_action":
                guard let capability = step.capability, capabilities.contains(where: { $0.id == capability && $0.version == 1 && $0.status != "unsupported" }) else {
                    stopRun(id, status: "failed", message: "This device does not support the requested capability."); return
                }
                guard let effectExecutor else { stopRun(id, status: "waiting", message: "Device capability dispatcher is not connected."); return }
                var action: DeviceAction
                if var stored = state.localActions[stepID] { stored.isLocal = true; action = stored }
                else {
                    var input: [String: FieldValue] = [:]
                    for (key, binding) in step.input ?? [:] {
                        if let fieldID = binding.fieldId {
                            guard workflow.definition.fields.contains(where: { $0.id == fieldID }), binding.value == nil else {
                                stopRun(id, status: "failed", message: "The device step has an invalid field binding."); return
                            }
                            input[key] = values[fieldID] ?? .null
                        } else if let value = binding.value { input[key] = value }
                        else { stopRun(id, status: "failed", message: "The device step has an empty binding."); return }
                    }
                    let now = Self.timestampFormatter.string(from: Date())
                    action = DeviceAction(id: stepID, deviceId: deviceID, capability: capability, input: input,
                        status: "pending", createdAt: now, updatedAt: now, isLocal: true)
                    guard DeviceActionValidation.valid(id: action.id, deviceID: action.deviceId,
                                                       capability: action.capability, input: action.input) else {
                        stopRun(id, status: "failed", message: "Invalid device action input. Correct its fields before retrying; no effect was attempted."); return
                    }
                    if capability == "activity.track", !jobs.contains(where: { $0.id == input["jobId"]?.stringValue }) {
                        stopRun(id, status: "failed", message: "Live Activity tracking requires a known job. No effect or request was created."); return
                    }
                    state.localActions[stepID] = action
                    guard enqueue(OutboxEntry(id: stepID, payload: .action(ActionRequest(id: stepID, capability: capability, input: input)))) else { return }
                }
                if let outcome = state.effectOutcomes[stepID] {
                    if outcome.status == "applied" { advanceRun(id); continue }
                    stopRun(id, status: "failed", message: outcome.result ?? outcome.status); return
                }
                guard persist(), !executingIDs.contains(stepID) else { return }
                executingIDs.insert(stepID)
                let outcome = await effectExecutor(action)
                executingIDs.remove(stepID)
                guard generation == sessionGeneration else { return }
                if outcome.status == "pending" {
                    stopRun(id, status: "waiting", message: outcome.result ?? "Waiting for device effect review."); return
                }
                await acknowledgeAction(id: stepID, status: outcome.status, result: outcome.result,
                                        retryableWithoutEffect: outcome.retryableWithoutEffect)
                if outcome.status != "applied" { return }
            default:
                stopRun(id, status: "failed", message: "This workflow uses an unsupported step type."); return
            }
            guard generation == sessionGeneration else { return }
        }
    }
}
