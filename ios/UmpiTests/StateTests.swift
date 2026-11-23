import Foundation
import XCTest
@testable import Umpi

private final class TestVault: CredentialVault {
    var credentials: PairCredentials?
    init(_ credentials: PairCredentials? = nil) { self.credentials = credentials }
    func load() throws -> PairCredentials? { credentials }
    func save(_ credentials: PairCredentials) throws { self.credentials = credentials }
    func clear() throws { credentials = nil }
}

/// A deterministic protocol peer: maintains revisions and receipts independently
/// of the store under test. Failure switches model interruption, not fake success.
private actor StateTestServer: CompanionTransport {
    var snapshot: DeviceSnapshot
    var mutations: [CompanionMutation] = []
    var mutationReceipts: [String: Data] = [:]
    var messageReceipts: [String: Data] = [:]
    var messages: [MessageRequest] = []
    var pairBodies: [Data] = []
    var offline = false
    var dropMutationReply = false
    var dropMessageReply = false
    var dropPairReply = false
    var rejectPair = false
    var answers: [String] = []
    var holdMutation = false
    var mutationArrived = false
    var arrival: CheckedContinuation<Void, Never>?
    var heldReply: CheckedContinuation<Void, Never>?
    /// Every request path, in order, and the size of each answer to a state read.
    var paths: [String] = []
    var stateReplyBytes: [Int] = []
    /// What the coordinator sends as `extra.widget`.
    var widgetStamp: String?
    let timestamp = "2026-01-01T12:00:00Z"

    init(workflow: Workflow) {
        snapshot = DeviceSnapshot(protocolVersion: 1, revision: 1, serverTime: timestamp,
            device: Device(id: "fixture-device", label: "Companion", capabilities: [], lastSeenAt: timestamp, revoked: false),
            workflows: [workflow], actions: [], jobs: [], reminders: [], choices: [], operations: [])
    }
    func setOffline(_ value: Bool) { offline = value }
    /// A later read of the same state: only the times the coordinator stamps on each answer differ.
    func laterRead() { snapshot.serverTime = "2026-01-01T12:00:12Z"; snapshot.device.lastSeenAt = "2026-01-01T12:00:12Z" }
    func loseMutationReply() { dropMutationReply = true }
    func loseMessageReply() { dropMessageReply = true }
    func losePairReply() { dropPairReply = true }
    func rejectPairing(_ value: Bool) { rejectPair = value }
    func addQuestion() {
        snapshot.choices = [Choice(id: "question", question: "Which approach?", options: ["First", "Second"],
            channel: "control", sessionId: "fixture-session", status: "pending", createdAt: timestamp)]
        // As on the coordinator: a change to owner state moves the revision.
        snapshot.revision += 1
    }
    func answerLog() -> [String] { answers }
    func actionLog() -> [DeviceAction] { snapshot.actions }
    func replaceWorkflow(_ workflow: Workflow) { snapshot.workflows = [workflow]; snapshot.revision += 1 }
    func removeWorkflow() { snapshot.workflows = []; snapshot.revision += 1 }
    func currentWorkflow() -> Workflow { snapshot.workflows[0] }
    func mutationLog() -> [CompanionMutation] { mutations }
    func messageLog() -> [MessageRequest] { messages }
    func claims() -> [Data] { pairBodies }
    func holdNextMutation() { holdMutation = true; mutationArrived = false }
    func waitForMutation() async {
        if mutationArrived { return }
        await withCheckedContinuation { arrival = $0 }
    }
    func releaseMutation() { heldReply?.resume(); heldReply = nil }
    func requestLog() -> [String] { paths }
    func stateReplySizes() -> [Int] { stateReplyBytes }
    /// The coordinator's revision moves with coordinator fields the app does not show.
    func bumpRevision() { snapshot.revision += 1 }
    func setWidgetStamp(_ stamp: String) { widgetStamp = stamp; snapshot.revision += 1 }
    func setCapabilities(_ capabilities: [Capability]) { snapshot.device.capabilities = capabilities }
    private func stateReply(known: Int?) throws -> Data {
        var reply = Data("{\"protocolVersion\":1,\"revision\":\(snapshot.revision),\"unchanged\":true}".utf8)
        if known != snapshot.revision {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any])
            if let widgetStamp { object["extra"] = ["widget": widgetStamp] }
            reply = try JSONSerialization.data(withJSONObject: object)
        }
        stateReplyBytes.append(reply.count)
        return reply
    }

    func send(path: String, method: String, body: Data?) async throws -> Data {
        if offline { throw URLError(.notConnectedToInternet) }
        paths.append(path)
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        if path == "/api/device/state" { return try stateReply(known: nil) }
        let conditional = "/api/device/state?revision="
        if path.hasPrefix(conditional) { return try stateReply(known: Int(path.dropFirst(conditional.count))) }
        if path == "/api/device/register" {
            let registration = try decoder.decode(DeviceRegistration.self, from: XCTUnwrap(body))
            snapshot.device.capabilities = registration.capabilities
            return Data("{\"ok\":true}".utf8)
        }
        if path == "/api/device/session" { return Data("{\"ok\":true}".utf8) }
        if path == "/api/device/pair" {
            struct Claim: Decodable { var deviceId: String }
            let body = try XCTUnwrap(body)
            pairBodies.append(body)
            let claim = try decoder.decode(Claim.self, from: body)
            if rejectPair { throw CompanionClientError.http(status: 401, message: "Invalid or expired claim", current: nil) }
            snapshot.device.id = claim.deviceId
            if dropPairReply { dropPairReply = false; throw URLError(.networkConnectionLost) }
            return try JSONSerialization.data(withJSONObject: ["deviceId": claim.deviceId])
        }
        if path == "/api/device/changes" {
            let request = try decoder.decode(CompanionMutation.self, from: XCTUnwrap(body))
            mutations.append(request)
            if let receipt = mutationReceipts[request.operationId] { return receipt }
            guard let index = snapshot.workflows.firstIndex(where: { $0.id == request.workflowId }),
                  snapshot.workflows[index].revision == request.expectedRevision else {
                throw CompanionClientError.http(status: 409, message: "Revision conflict", current: snapshot.workflows.first { $0.id == request.workflowId })
            }
            var workflow = snapshot.workflows[index]
            if request.kind == "set_values" { workflow.values.merge(request.values ?? [:]) { _, new in new } }
            if request.kind == "define", let definition = request.definition { workflow.definition = definition }
            if request.kind == "archive" { workflow.archived = true }
            if request.kind == "restore" { workflow.archived = false }
            workflow.revision += 1
            snapshot.workflows[index] = workflow
            snapshot.revision += 1
            let receipt = try encoder.encode(workflow)
            mutationReceipts[request.operationId] = receipt
            if holdMutation {
                holdMutation = false
                mutationArrived = true
                arrival?.resume(); arrival = nil
                await withCheckedContinuation { heldReply = $0 }
            }
            if dropMutationReply { dropMutationReply = false; throw URLError(.networkConnectionLost) }
            return receipt
        }
        if path == "/api/device/messages" {
            let message = try decoder.decode(MessageRequest.self, from: XCTUnwrap(body))
            messages.append(message)
            if let receipt = messageReceipts[message.id] { return receipt }
            let operation = Operation(id: message.id, requestId: "device:" + message.id, channel: "control",
                sessionId: "fixture-session", text: message.text, status: "admitted", createdAt: timestamp)
            let receipt = try encoder.encode(operation)
            messageReceipts[message.id] = receipt
            snapshot.operations.append(operation)
            if dropMessageReply { dropMessageReply = false; throw URLError(.networkConnectionLost) }
            return receipt
        }
        if path == "/api/device/actions" {
            let request = try decoder.decode(ActionRequest.self, from: XCTUnwrap(body))
            if let existing = snapshot.actions.first(where: { $0.id == request.id }) {
                guard existing.capability == request.capability, existing.input == request.input else {
                    throw CompanionClientError.http(status: 409, message: "Action identity reused", current: nil)
                }
                return try encoder.encode(existing)
            }
            guard snapshot.device.capabilities.contains(where: { $0.id == request.capability && $0.status != "unsupported" }) else {
                throw CompanionClientError.http(status: 409, message: "Capability not registered", current: nil)
            }
            let action = DeviceAction(id: request.id, deviceId: snapshot.device.id, capability: request.capability,
                input: request.input, status: "pending", createdAt: timestamp, updatedAt: timestamp)
            snapshot.actions.append(action)
            return try encoder.encode(action)
        }
        if path.hasSuffix("/ack") {
            let id = String(path.split(separator: "/").dropLast().last!)
            let ack = try decoder.decode(ActionAcknowledgment.self, from: XCTUnwrap(body))
            let index = try XCTUnwrap(snapshot.actions.firstIndex { $0.id == id })
            guard snapshot.actions[index].status == "pending" ||
                    (snapshot.actions[index].status == ack.status && snapshot.actions[index].result == ack.result) else {
                throw CompanionClientError.http(status: 409, message: "An action outcome is immutable", current: nil)
            }
            snapshot.actions[index].status = ack.status
            snapshot.actions[index].result = ack.result
            return try encoder.encode(snapshot.actions[index])
        }
        if path == "/api/device/choices/question/answer" {
            let answer = try decoder.decode(ChoiceAnswer.self, from: XCTUnwrap(body)).answer
            guard snapshot.choices.first?.status == "pending", !answer.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") else {
                throw CompanionClientError.http(status: 409, message: "Question is no longer pending", current: nil)
            }
            answers.append(answer)
            snapshot.choices[0].status = "answered"
            snapshot.choices[0].answer = answer
            return Data("{\"ok\":true}".utf8)
        }
        throw CompanionClientError.http(status: 404, message: "Unknown fixture route", current: nil)
    }
}

/// Set when something observed changes, which is when SwiftUI would draw again.
private final class Redraw: @unchecked Sendable { var asked = false }

@MainActor
final class StateTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func fixture(buttons: [WorkflowButton] = []) -> Workflow {
        Workflow(id: "fixture-workflow", revision: 1,
            definition: WorkflowDefinition(id: "fixture-workflow", title: "Example workflow",
                fields: [FieldDefinition(id: "title", label: "Title", kind: "text"),
                         FieldDefinition(id: "ready", label: "Ready", kind: "toggle")], actions: buttons),
            values: ["title": .string("Original"), "ready": .bool(false)], archived: false, updatedAt: "2026-01-01T12:00:00Z")
    }
    private func vault() -> TestVault {
        TestVault(PairCredentials(server: "https://companion.example", deviceID: "fixture-device", label: "Companion",
            token: String(repeating: "a", count: 64), pendingCode: nil))
    }
    private func makeStore(server: StateTestServer, directory: URL, vault: TestVault) -> CompanionStore {
        CompanionStore(directory: directory, vault: vault, transportFactory: { _, _ in server })
    }

    func testDraftSurvivesServerChangesDefinitionRemovalAndRestart() async throws {
        let folder = try directory()
        let vault = vault()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault)
        await store.refresh()
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Owner draft"))
        var updated = fixture()
        updated.revision = 2
        updated.values["title"] = .string("Agent value")
        updated.values["ready"] = .bool(true)
        updated.definition.fields.removeAll { $0.id == "title" }
        await server.replaceWorkflow(updated)
        await store.refresh()
        XCTAssertEqual(store.displayedValues(for: updated.id)["title"], .string("Owner draft"))
        XCTAssertEqual(store.displayedValues(for: updated.id)["ready"], .bool(true))
        XCTAssertEqual(store.orphanedDrafts(for: updated.id)["title"], .string("Owner draft"))
        let restored = makeStore(server: server, directory: folder, vault: vault)
        XCTAssertEqual(restored.orphanedDrafts(for: updated.id)["title"], .string("Owner draft"))
        await restored.saveDraft(workflowID: updated.id)
        XCTAssertEqual(restored.conflicts.count, 1)
        let requests = await server.mutationLog()
        XCTAssertEqual(requests.last?.expectedRevision, 1, "Refresh must not silently rebase an older draft")
    }

    func testRemovedWorkflowDraftRemainsVisibleUntilExplicitLocalDiscard() async throws {
        let folder = try directory()
        let vault = vault()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault)
        await store.refresh()
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Preserve this input"))
        await server.removeWorkflow()
        await store.refresh()
        XCTAssertTrue(store.workflows.isEmpty)
        XCTAssertEqual(store.orphanedWorkflowDrafts.first?.values["title"], .string("Preserve this input"))
        let restored = makeStore(server: server, directory: folder, vault: vault)
        XCTAssertEqual(restored.orphanedWorkflowDrafts.first?.id, "fixture-workflow")
        restored.discardWorkflowDraft(id: "fixture-workflow")
        XCTAssertTrue(restored.orphanedWorkflowDrafts.isEmpty)
        XCTAssertTrue(makeStore(server: server, directory: folder, vault: vault).orphanedWorkflowDrafts.isEmpty)
    }

    func testOfflineOutboxSurvivesRestartAndDoesNotRebaseOnReconnect() async throws {
        let folder = try directory()
        let vault = vault()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault)
        await store.refresh()
        await server.setOffline(true)
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Offline input"))
        await store.saveDraft(workflowID: "fixture-workflow")
        let queuedID = try XCTUnwrap(store.queuedChanges.first?.id)
        XCTAssertNotNil(store.errorMessage)
        let restored = makeStore(server: server, directory: folder, vault: vault)
        XCTAssertEqual(restored.queuedChanges.first?.id, queuedID)
        XCTAssertEqual(restored.draftValues(for: "fixture-workflow")["title"], .string("Offline input"))
        var changed = fixture(); changed.revision = 2; changed.values["ready"] = .bool(true)
        await server.replaceWorkflow(changed)
        await server.setOffline(false)
        await restored.synchronize()
        let requests = await server.mutationLog()
        XCTAssertEqual(requests.last?.operationId, queuedID)
        XCTAssertEqual(requests.last?.expectedRevision, 1)
        XCTAssertEqual(restored.conflicts.count, 1)
        XCTAssertEqual(restored.displayedValues(for: changed.id)["title"], .string("Offline input"))
        XCTAssertEqual(restored.displayedValues(for: changed.id)["ready"], .bool(true))
    }

    func testAReadThatChangesNothingRedrawsNothingAndWritesNothing() async throws {
        let folder = try directory()
        let vault = vault()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault)
        await store.refresh()
        let file = folder.appendingPathComponent("companion-state.json")
        let saved = try Data(contentsOf: file)
        let firstRead = try XCTUnwrap(store.lastSyncedAt)
        let redraw = Redraw()
        withObservationTracking { _ = (store.workflows, store.jobs, store.choices, store.pendingMessages.count) } onChange: { redraw.asked = true }

        await server.laterRead()
        await store.refresh()
        XCTAssertFalse(redraw.asked, "the same state must not draw the app again")
        XCTAssertEqual(try Data(contentsOf: file), saved, "nor write the state file again")
        XCTAssertGreaterThan(try XCTUnwrap(store.lastSyncedAt), firstRead)
        XCTAssertEqual(store.statusMessage, "Up to date")

        var updated = fixture(); updated.revision = 2; updated.values["title"] = .string("Changed elsewhere")
        await server.replaceWorkflow(updated)
        await store.refresh()
        XCTAssertTrue(redraw.asked)
        XCTAssertEqual(store.workflows.first?.values["title"], .string("Changed elsewhere"))
        let restored = makeStore(server: server, directory: folder, vault: vault)
        XCTAssertEqual(restored.workflows.first?.revision, 2)
        XCTAssertEqual(restored.lastSyncedAt, store.lastSyncedAt, "a change saves the time of the latest read with it")
    }

    func testAnUnchangedRevisionIsASmallAnswerAndALocalChangeAsksForTheWholeSnapshot() async throws {
        let folder = try directory()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault())
        await store.refresh()
        await store.refresh()
        await store.refresh()
        var log = await server.requestLog()
        XCTAssertEqual(log, ["/api/device/state", "/api/device/state?revision=1", "/api/device/state?revision=1"])
        var sizes = await server.stateReplySizes()
        XCTAssertLessThan(sizes[1], 80, "the answer to a current revision is a few bytes")
        XCTAssertGreaterThan(sizes[0], sizes[1] * 4)
        XCTAssertEqual(store.statusMessage, "Up to date")
        XCTAssertEqual(store.workflows.count, 1, "the app keeps the copy it holds")

        // The coordinator's revision moves for a field the app does not show: the snapshot comes once, changes
        // nothing in the app, and the next read asks about the new revision.
        let file = folder.appendingPathComponent("companion-snapshot.json")
        store.flushStorage()
        let saved = try Data(contentsOf: file)
        let redraw = Redraw()
        withObservationTracking { _ = (store.workflows, store.jobs, store.choices) } onChange: { redraw.asked = true }
        await server.bumpRevision()
        await store.refresh()
        await store.refresh()
        log = await server.requestLog()
        XCTAssertEqual(Array(log.suffix(2)), ["/api/device/state?revision=1", "/api/device/state?revision=2"])
        sizes = await server.stateReplySizes()
        XCTAssertLessThan(sizes[4], 80)
        XCTAssertFalse(redraw.asked)
        store.flushStorage()
        XCTAssertEqual(try Data(contentsOf: file), saved, "the same content is not written again")

        // A message the coordinator accepted is added to the app's copy. The copy is then no longer what a read
        // returned, so the next read asks for the whole snapshot.
        let accepted = await store.sendChat(text: "Water the ferns")
        XCTAssertTrue(accepted)
        await store.refresh()
        await store.refresh()
        log = await server.requestLog()
        XCTAssertEqual(Array(log.suffix(3)), ["/api/device/messages", "/api/device/state", "/api/device/state?revision=2"])
        XCTAssertEqual(store.operations.map(\.text), ["Water the ferns"])
    }

    func testTheWidgetStampComesWithTheSnapshotAndStaysOverAnUnchangedRead() async throws {
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: try directory(), vault: vault())
        XCTAssertNil(store.widgetStamp)
        await store.refresh()
        XCTAssertEqual(store.widgetStamp, "revision:1", "a coordinator without the stamp: every revision counts as a change")
        await server.setWidgetStamp("stamp-a")
        await store.refresh()
        XCTAssertEqual(store.widgetStamp, "stamp-a")
        await store.refresh()
        XCTAssertEqual(store.widgetStamp, "stamp-a", "an unchanged read keeps it")
        await server.setWidgetStamp("stamp-b")
        await store.refresh()
        XCTAssertEqual(store.widgetStamp, "stamp-b")
    }

    func testAnUnchangedRegistrationIsSentOnce() async throws {
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: try directory(), vault: vault())
        let available = [Capability(id: "notification.schedule", status: "available")]
        var current = available
        store.configureEffects(capabilities: { current }, execute: { _ in DeviceEffectOutcome(status: "pending") })
        let token = String(repeating: "ab", count: 32)
        func registrations() async -> Int { await server.requestLog().filter { $0 == "/api/device/register" }.count }
        // One cycle of the phone: its full registration, then the store's own, which repeats the capabilities only.
        for _ in 0..<3 {
            await store.register(capabilities: current, apnsToken: token, apnsEnvironment: "sandbox", activityTokens: [], activityJobIds: [])
            await store.synchronize()
        }
        var count = await registrations()
        XCTAssertEqual(count, 1, "three cycles with nothing new send one registration")
        current = [Capability(id: "notification.schedule", status: "permission_required", reason: "Allow notifications in system settings")]
        await store.synchronize()
        count = await registrations()
        XCTAssertEqual(count, 2, "a changed capability is sent")
        await store.register(capabilities: current, apnsToken: String(repeating: "cd", count: 32), apnsEnvironment: "sandbox")
        await store.register(capabilities: current, apnsToken: String(repeating: "cd", count: 32), apnsEnvironment: "sandbox")
        count = await registrations()
        XCTAssertEqual(count, 3, "and a new push token, once")

        // A registration the coordinator did not confirm is sent again.
        await server.setOffline(true)
        await store.register(capabilities: available)
        await server.setOffline(false)
        await store.register(capabilities: available)
        count = await registrations()
        XCTAssertEqual(count, 4)
    }

    func testTheOutboxAndDraftsAreSavedAtOnceAndApartFromTheSnapshotCopy() async throws {
        let folder = try directory()
        let vault = vault()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault)
        await store.refresh()
        await server.setOffline(true)
        XCTAssertTrue(store.queueChat(text: "Order more seed trays"))
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Half typed"))
        let stateFile = folder.appendingPathComponent("companion-state.json")
        let snapshotFile = folder.appendingPathComponent("companion-snapshot.json")
        // On disk when the calls return, with no wait for the background write.
        let durable = try JSONDecoder().decode(CompanionDiskState.self, from: Data(contentsOf: stateFile))
        XCTAssertEqual(durable.outbox.count, 1)
        XCTAssertEqual(durable.drafts["fixture-workflow"]?.fields["title"]?.value, .string("Half typed"))
        XCTAssertNil(durable.snapshot, "the copy of the coordinator's state is not written with every change")
        store.flushStorage()
        let copy = try JSONDecoder().decode(SnapshotCopy.self, from: Data(contentsOf: snapshotFile))
        XCTAssertEqual(copy.snapshot.workflows.map(\.id), ["fixture-workflow"])
        XCTAssertEqual(copy.deviceID, "fixture-device")

        // A crash before the snapshot copy was written, or a damaged copy: the queued message and the draft are kept,
        // and the message is sent after the next read.
        try Data("not json".utf8).write(to: snapshotFile)
        let restored = makeStore(server: server, directory: folder, vault: vault)
        XCTAssertEqual(restored.pendingMessages.map(\.message.text), ["Order more seed trays"])
        XCTAssertEqual(restored.draftValues(for: "fixture-workflow")["title"], .string("Half typed"))
        XCTAssertTrue(restored.workflows.isEmpty)
        XCTAssertNil(restored.errorMessage)
        await server.setOffline(false)
        await restored.synchronize()
        let sent = await server.messageLog()
        XCTAssertEqual(sent.map(\.text), ["Order more seed trays"])
        XCTAssertEqual(restored.queuedCount, 0)
        XCTAssertEqual(restored.workflows.count, 1)
    }

    func testAStateFileFromAnEarlierBuildStillLoadsItsSnapshot() async throws {
        let folder = try directory()
        let vault = vault()
        let server = StateTestServer(workflow: fixture())
        // The earlier layout: one file with the snapshot inside it.
        var legacy = CompanionDiskState(deviceID: "fixture-device")
        legacy.snapshot = await server.snapshot
        legacy.outbox = [OutboxEntry(id: "queued-earlier", payload: .message(MessageRequest(id: "queued-earlier", text: "Buy potting soil")))]
        legacy.lastSyncedAt = Date(timeIntervalSince1970: 1_800_000_000)
        try JSONEncoder().encode(legacy).write(to: folder.appendingPathComponent("companion-state.json"))
        let store = makeStore(server: server, directory: folder, vault: vault)
        XCTAssertEqual(store.workflows.map(\.id), ["fixture-workflow"])
        XCTAssertEqual(store.lastSyncedAt, legacy.lastSyncedAt)
        XCTAssertEqual(store.pendingMessages.map(\.message.text), ["Buy potting soil"])
        await store.synchronize()
        let sent = await server.messageLog()
        XCTAssertEqual(sent.map(\.text), ["Buy potting soil"])
        // The first save moves the snapshot to its own file.
        let restored = makeStore(server: server, directory: folder, vault: vault)
        XCTAssertEqual(restored.workflows.map(\.id), ["fixture-workflow"])
        XCTAssertEqual(restored.queuedCount, 0)
        let durable = try JSONDecoder().decode(CompanionDiskState.self, from: Data(contentsOf: folder.appendingPathComponent("companion-state.json")))
        XCTAssertNil(durable.snapshot)
    }

    func testDisconnectRemovesBothFiles() async throws {
        let folder = try directory()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault())
        await store.refresh()
        XCTAssertTrue(store.queueChat(text: "Water the ferns"))
        await store.disconnect()
        store.flushStorage()
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("companion-state.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("companion-snapshot.json").path))
    }

    func testAChatMessageIsSavedBeforeItIsReportedQueued() async throws {
        let folder = try directory()
        let vault = vault()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault)
        await store.refresh()
        await server.setOffline(true)
        XCTAssertTrue(store.queueChat(text: "Order more seed trays"))
        XCTAssertEqual(store.pendingMessages.map(\.message.text), ["Order more seed trays"])
        // Nothing was delivered and nothing else ran: the message is in the state file already.
        let restored = makeStore(server: server, directory: folder, vault: vault)
        XCTAssertEqual(restored.pendingMessages.map(\.message.text), ["Order more seed trays"])
        XCTAssertEqual(restored.queuedCount, 1)
        let sent = await server.messageLog()
        XCTAssertTrue(sent.isEmpty)

        // Where the state cannot be saved, the message is not reported queued, so the chat keeps it in the field.
        let blocked = folder.appendingPathComponent("not-a-folder")
        try Data().write(to: blocked)
        let unsaved = makeStore(server: server, directory: blocked.appendingPathComponent("state"), vault: vault)
        XCTAssertFalse(unsaved.queueChat(text: "Order more seed trays"))
        XCTAssertNotNil(unsaved.errorMessage)
    }

    func testStateTheChatDoesNotShowDoesNotRedrawIt() async throws {
        let folder = try directory()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault())
        await store.refresh()
        let chat = Redraw(), badge = Redraw()
        withObservationTracking { _ = store.pendingMessages.count } onChange: { chat.asked = true }
        withObservationTracking { _ = (store.jobs, store.choices) } onChange: { badge.asked = true }

        var updated = fixture(); updated.revision = 2; updated.values["ready"] = .bool(true)
        await server.replaceWorkflow(updated)
        await store.refresh()
        XCTAssertEqual(store.workflows.first?.revision, 2)
        XCTAssertFalse(chat.asked, "a workflow change is not the chat's")
        XCTAssertFalse(badge.asked, "nor the tab bar's")

        await server.addQuestion()
        await store.refresh()
        XCTAssertEqual(store.choices.map(\.id), ["question"])
        XCTAssertTrue(badge.asked, "a new question changes the badge")
        XCTAssertFalse(chat.asked)

        await server.setOffline(true)
        XCTAssertTrue(store.queueChat(text: "Which trays fit the shelf?"))
        XCTAssertTrue(chat.asked, "a queued message shows in the chat at once")
    }

    func testConflictKeepLocalRequiresNewExplicitRevisionBoundOperation() async throws {
        let folder = try directory()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault())
        await store.refresh()
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Owner value"))
        var newer = fixture(); newer.revision = 2; newer.values["title"] = .string("Other writer")
        await server.replaceWorkflow(newer)
        await store.saveDraft(workflowID: newer.id)
        let conflict = try XCTUnwrap(store.conflicts.first)
        XCTAssertEqual(conflict.current?.values["title"], .string("Other writer"))
        XCTAssertEqual(store.displayedValues(for: newer.id)["title"], .string("Owner value"))
        await store.synchronize()
        let requestsBeforeChoice = await server.mutationLog()
        XCTAssertEqual(requestsBeforeChoice.count, 1, "A refresh must not retry or resolve a conflict by itself")
        await store.resolveConflict(id: conflict.id, keepLocal: true)
        let requests = await server.mutationLog()
        XCTAssertEqual(requests.map(\.expectedRevision), [1, 2])
        XCTAssertNotEqual(requests[0].operationId, requests[1].operationId)
        XCTAssertEqual(store.workflow(id: newer.id)?.values["title"], .string("Owner value"))
        XCTAssertTrue(store.conflicts.isEmpty)
    }

    func testUseServerChoiceDoesNotDiscardTypingAfterConflictedSave() async throws {
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: try directory(), vault: vault())
        await store.refresh()
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Submitted"))
        var newer = fixture(); newer.revision = 2
        await server.replaceWorkflow(newer)
        await store.saveDraft(workflowID: newer.id)
        let conflictID = try XCTUnwrap(store.conflicts.first?.id)
        store.setDraft(workflowID: newer.id, fieldID: "title", value: .string("Typed after save"))
        await store.resolveConflict(id: conflictID, keepLocal: false)
        XCTAssertEqual(store.draftValues(for: newer.id)["title"], .string("Typed after save"))
        XCTAssertTrue(store.conflicts.isEmpty)
    }

    func testKeepLocalChoicePreservesLaterTypingWithoutRebasingIt() async throws {
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: try directory(), vault: vault())
        await store.refresh()
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Submitted"))
        var newer = fixture(); newer.revision = 2
        await server.replaceWorkflow(newer)
        await store.saveDraft(workflowID: newer.id)
        let conflictID = try XCTUnwrap(store.conflicts.first?.id)
        store.setDraft(workflowID: newer.id, fieldID: "title", value: .string("Typed after save"))
        await store.resolveConflict(id: conflictID, keepLocal: true)
        XCTAssertEqual(store.workflow(id: newer.id)?.values["title"], .string("Submitted"))
        XCTAssertEqual(store.draftValues(for: newer.id)["title"], .string("Typed after save"))
        await store.saveDraft(workflowID: newer.id)
        let requests = await server.mutationLog()
        XCTAssertEqual(requests.map(\.expectedRevision), [1, 2, 1])
        XCTAssertEqual(store.conflicts.count, 1, "A decision about an older submission must not rebase later typing")
    }

    func testLostMutationReplyReplaysSameIDOnceAcrossRestart() async throws {
        let folder = try directory()
        let vault = vault()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault)
        await store.refresh()
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Saved value"))
        await server.loseMutationReply()
        await store.saveDraft(workflowID: "fixture-workflow")
        XCTAssertEqual(store.queuedCount, 1)
        let restored = makeStore(server: server, directory: folder, vault: vault)
        await restored.synchronize()
        let requests = await server.mutationLog()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0], requests[1])
        let remote = await server.currentWorkflow()
        XCTAssertEqual(remote.revision, 2)
        XCTAssertTrue(restored.draftValues(for: remote.id).isEmpty)
        XCTAssertEqual(restored.queuedCount, 0)
    }

    func testTypingWhileSaveIsInFlightRetainsNewEditWithOwnAcceptedRevision() async throws {
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: try directory(), vault: vault())
        await store.refresh()
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Submitted"))
        await server.holdNextMutation()
        let saving = Task { await store.saveDraft(workflowID: "fixture-workflow") }
        await server.waitForMutation()
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("New typing"))
        await server.releaseMutation()
        await saving.value
        XCTAssertEqual(store.draftValues(for: "fixture-workflow")["title"], .string("New typing"))
        await store.saveDraft(workflowID: "fixture-workflow")
        let requests = await server.mutationLog()
        XCTAssertEqual(requests.map(\.expectedRevision), [1, 2])
        XCTAssertEqual(store.workflow(id: "fixture-workflow")?.values["title"], .string("New typing"))
    }

    func testSequentialButtonBindingsConditionsAndMessageRecoveryDoNotRepeatEffect() async throws {
        let button = WorkflowButton(id: "run", title: "Run", steps: [
            WorkflowStep(kind: "set_value", fieldId: "ready", value: .bool(true)),
            WorkflowStep(kind: "device_action", capability: "notification.schedule",
                input: ["title": BindingValue(fieldId: "title"),
                        "notificationId": BindingValue(value: .string("fixture-notification")),
                        "body": BindingValue(value: .string("")),
                        "date": BindingValue(value: .string("2099-01-01T12:00:00Z"))],
                when: WorkflowCondition(fieldId: "ready", equals: .bool(true))),
            WorkflowStep(kind: "message", text: "Continue the example task"),
            WorkflowStep(kind: "message", text: "Must be skipped", when: WorkflowCondition(fieldId: "ready", equals: .bool(false)))
        ])
        let folder = try directory()
        let vault = vault()
        let server = StateTestServer(workflow: fixture(buttons: [button]))
        let store = makeStore(server: server, directory: folder, vault: vault)
        let capability = Capability(id: "notification.schedule", status: "available")
        var effectIDs: [String] = []
        store.configureEffects(capabilities: { [capability] }, execute: { action in
            effectIDs.append(action.id)
            XCTAssertEqual(action.input["title"], .string("Owner-bound title"))
            XCTAssertTrue(action.isLocal)
            return DeviceEffectOutcome(status: "applied")
        })
        await store.synchronize()
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Owner-bound title"))
        await server.loseMessageReply()
        await store.runButton(workflowID: "fixture-workflow", buttonID: button.id)
        XCTAssertEqual(effectIDs.count, 1)
        XCTAssertEqual(store.runs.first?.nextStep, 2)
        let restored = makeStore(server: server, directory: folder, vault: vault)
        restored.configureEffects(capabilities: { [capability] }, execute: { action in
            effectIDs.append(action.id)
            return DeviceEffectOutcome(status: "applied")
        })
        await restored.synchronize()
        XCTAssertEqual(effectIDs.count, 1, "The persisted effect receipt must prevent a repeated native effect")
        XCTAssertEqual(restored.runs.first?.status, "completed")
        let messages = await server.messageLog()
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages[0].id, messages[1].id)
        XCTAssertEqual(messages[0].text, "Continue the example task")
        XCTAssertEqual(restored.displayedValues(for: "fixture-workflow")["title"], .string("Owner-bound title"))
    }

    func testRevisionConflictStopsButtonBeforeAnyEffect() async throws {
        let button = WorkflowButton(id: "run", title: "Run", steps: [
            WorkflowStep(kind: "set_value", fieldId: "ready", value: .bool(true)),
            WorkflowStep(kind: "device_action", capability: "notification.schedule", input: [:]),
            WorkflowStep(kind: "message", text: "Must not be sent")
        ])
        let server = StateTestServer(workflow: fixture(buttons: [button]))
        let store = makeStore(server: server, directory: try directory(), vault: vault())
        var effects = 0
        store.configureEffects(capabilities: { [Capability(id: "notification.schedule", status: "available")] }, execute: { _ in
            effects += 1; return DeviceEffectOutcome(status: "applied")
        })
        await store.synchronize()
        var changed = fixture(buttons: [button]); changed.revision = 2
        await server.replaceWorkflow(changed)
        await store.runButton(workflowID: changed.id, buttonID: button.id)
        XCTAssertEqual(store.runs.first?.status, "conflict")
        XCTAssertEqual(effects, 0)
        let messages = await server.messageLog()
        XCTAssertTrue(messages.isEmpty)
        XCTAssertEqual(store.draftValues(for: changed.id)["ready"], .bool(true))
    }

    func testPendingPairRecoveryReusesOriginalClaimAndKeepsTokenOutOfCache() async throws {
        let folder = try directory()
        let vault = TestVault()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault)
        store.configureEffects(capabilities: { [Capability(id: "notification.schedule", status: "permission_required")] }, execute: { _ in
            DeviceEffectOutcome(status: "pending")
        })
        await server.losePairReply()
        await store.pair(server: "https://companion.example", code: String(repeating: "b", count: 64))
        XCTAssertTrue(store.hasPendingPairing)
        let token = try XCTUnwrap(vault.credentials?.token)
        XCTAssertEqual(token.count, 64)
        let restored = makeStore(server: server, directory: folder, vault: vault)
        restored.configureEffects(capabilities: { [Capability(id: "notification.schedule", status: "available")] }, execute: { _ in
            DeviceEffectOutcome(status: "pending")
        })
        await restored.recoverPendingPairing()
        XCTAssertTrue(restored.isPaired)
        let claims = await server.claims()
        XCTAssertEqual(claims.count, 2)
        let first = try JSONSerialization.jsonObject(with: claims[0]) as? NSDictionary
        let second = try JSONSerialization.jsonObject(with: claims[1]) as? NSDictionary
        XCTAssertEqual(first, second)
        let cache = try String(contentsOf: folder.appendingPathComponent("companion-state.json"), encoding: .utf8)
        XCTAssertFalse(cache.contains(token))
        XCTAssertFalse(cache.contains(String(repeating: "b", count: 64)))
        XCTAssertNil(vault.credentials?.pendingCode)
    }

    func testAbandonRejectedPendingPairingAllowsNewClaimAndReportsUnknownRevocation() async throws {
        let folder = try directory()
        let vault = TestVault()
        let server = StateTestServer(workflow: fixture())
        let store = makeStore(server: server, directory: folder, vault: vault)
        await server.rejectPairing(true)
        await store.pair(server: "https://companion.example", code: String(repeating: "b", count: 64))
        let oldCredentials = try XCTUnwrap(vault.credentials)
        XCTAssertTrue(store.hasPendingPairing)
        XCTAssertFalse(store.isPaired)
        await server.setOffline(true)
        await store.disconnect()
        XCTAssertNil(vault.credentials)
        XCTAssertFalse(store.hasPendingPairing)
        XCTAssertTrue(store.errorMessage?.contains("revocation was not confirmed") == true)
        let restored = makeStore(server: server, directory: folder, vault: vault)
        XCTAssertFalse(restored.hasPendingPairing)
        await server.setOffline(false)
        await server.rejectPairing(false)
        await restored.pair(server: "https://companion.example", code: String(repeating: "c", count: 64))
        XCTAssertTrue(restored.isPaired)
        XCTAssertNotEqual(vault.credentials?.deviceID, oldCredentials.deviceID)
        XCTAssertNotEqual(vault.credentials?.token, oldCredentials.token)
    }

    func testCustomQuestionAnswerIsAdmittedButInvalidTextNeverQueues() async throws {
        let server = StateTestServer(workflow: fixture())
        await server.addQuestion()
        let store = makeStore(server: server, directory: try directory(), vault: vault())
        await store.refresh()
        for invalid in ["", " \n ", " /approve job", String(repeating: "a", count: 16_385), "nul\0text",
                        String(repeating: "😀", count: 8_193)] {
            await store.answerChoice(id: "question", answer: invalid)
            XCTAssertEqual(store.queuedCount, 0)
            XCTAssertEqual(store.choices.first?.status, "pending")
        }
        await store.answerChoice(id: "question", answer: "Use a third approach")
        let answers = await server.answerLog()
        XCTAssertEqual(answers, ["Use a third approach"])
        XCTAssertEqual(store.choices.first?.answer, "Use a third approach")
        XCTAssertEqual(store.choices.first?.status, "answered")
    }

    func testHistoricalMutationCannotResurrectRemovalOrAdvanceOverNewerRevision() async throws {
        for removed in [true, false] {
            let button = WorkflowButton(id: "run", title: "Run", steps: [
                WorkflowStep(kind: "set_value", fieldId: "ready", value: .bool(true)),
                WorkflowStep(kind: "device_action", capability: "notification.cancel",
                             input: ["notificationId": BindingValue(value: .string("fixture-notification"))]),
                WorkflowStep(kind: "message", text: "Must not continue")
            ])
            let folder = try directory()
            let vault = vault()
            let server = StateTestServer(workflow: fixture(buttons: [button]))
            let store = makeStore(server: server, directory: folder, vault: vault)
            var effects = 0
            store.configureEffects(capabilities: { [Capability(id: "notification.cancel", status: "available")] },
                                   execute: { _ in effects += 1; return DeviceEffectOutcome(status: "applied") })
            await store.synchronize()
            await server.loseMutationReply()
            await store.runButton(workflowID: "fixture-workflow", buttonID: "run")
            store.setDraft(workflowID: "fixture-workflow", fieldID: "ready", value: .bool(false))
            store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("Later owner typing"))
            if removed { await server.removeWorkflow() }
            else {
                var newer = fixture(buttons: [button])
                newer.revision = 3
                newer.values["title"] = .string("Authoritative revision")
                await server.replaceWorkflow(newer)
            }
            let restored = makeStore(server: server, directory: folder, vault: vault)
            restored.configureEffects(capabilities: { [Capability(id: "notification.cancel", status: "available")] },
                                      execute: { _ in effects += 1; return DeviceEffectOutcome(status: "applied") })
            await restored.synchronize()
            XCTAssertEqual(effects, 0)
            let messages = await server.messageLog()
            XCTAssertTrue(messages.isEmpty)
            XCTAssertEqual(restored.runs.first?.status, "conflict")
            XCTAssertEqual(restored.queuedCount, 0, "Historical success acknowledges only the submitted operation")
            XCTAssertEqual(restored.draftValues(for: "fixture-workflow")["ready"], .bool(false))
            XCTAssertEqual(restored.draftValues(for: "fixture-workflow")["title"], .string("Later owner typing"))
            if removed {
                XCTAssertNil(restored.workflow(id: "fixture-workflow"))
                XCTAssertEqual(restored.orphanedWorkflowDrafts.count, 1)
            } else {
                XCTAssertEqual(restored.workflow(id: "fixture-workflow")?.revision, 3)
                XCTAssertEqual(restored.workflow(id: "fixture-workflow")?.values["title"], .string("Authoritative revision"))
                await restored.saveDraft(workflowID: "fixture-workflow")
                XCTAssertEqual(restored.conflicts.count, 1, "A historical receipt must not rebase later drafts")
            }
        }
    }

    func testInvalidBoundNotificationIdentifierNeverQueuesOrExecutesAndCanBeCorrected() async throws {
        let button = WorkflowButton(id: "run", title: "Run", steps: [
            WorkflowStep(kind: "device_action", capability: "notification.cancel",
                         input: ["notificationId": BindingValue(fieldId: "title")])
        ])
        let server = StateTestServer(workflow: fixture(buttons: [button]))
        let store = makeStore(server: server, directory: try directory(), vault: vault())
        var effects = 0
        store.configureEffects(capabilities: { [Capability(id: "notification.cancel", status: "available")] },
                               execute: { _ in effects += 1; return DeviceEffectOutcome(status: "applied") })
        await store.synchronize()
        await server.setOffline(true)
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("my reminder"))
        await store.runButton(workflowID: "fixture-workflow", buttonID: "run")
        XCTAssertEqual(effects, 0)
        XCTAssertEqual(store.queuedCount, 0)
        XCTAssertTrue(store.pendingDeviceActions.isEmpty)
        XCTAssertEqual(store.runs.first?.status, "failed")
        store.setDraft(workflowID: "fixture-workflow", fieldID: "title", value: .string("my-reminder"))
        let runID = try XCTUnwrap(store.runs.first?.id)
        await store.resumeRun(id: runID)
        XCTAssertEqual(effects, 1)
        await server.setOffline(false)
        await store.synchronize()
        XCTAssertEqual(store.queuedCount, 0)
        let registered = await server.actionLog()
        XCTAssertEqual(registered.count, 1)
        XCTAssertEqual(registered.first?.status, "applied")
    }

    func testExplicitUnattemptedRetryUsesNewRegisteredIdentityAndRetainsOldReceipt() async throws {
        for status in ["permission_required", "unsupported", "failed"] {
            let button = WorkflowButton(id: "run", title: "Run", steps: [
                WorkflowStep(kind: "device_action", capability: "notification.cancel",
                             input: ["notificationId": BindingValue(value: .string("fixture-" + UUID().uuidString))])
            ])
            let folder = try directory()
            let ledgerURL = folder.appendingPathComponent("effects.json")
            let vault = vault()
            let server = StateTestServer(workflow: fixture(buttons: [button]))
            let store = makeStore(server: server, directory: folder, vault: vault)
            // Persist the preflight receipt as an OS permission/availability boundary would.
            // All executions, replay, fresh cancellation and ack handling remain real.
            store.configureEffects(capabilities: { [Capability(id: "notification.cancel", status: "available")] },
                execute: { action in
                    do {
                        let ledger = try EffectLedger(url: ledgerURL)
                        let fingerprint = try EffectLedger.fingerprint(action)
                        try ledger.save(EffectIntent(fingerprint: fingerprint, phase: "finished",
                            receipt: EffectReceipt(status: status, result: "Not attempted",
                                                   retryableWithoutEffect: status == "failed" ? true : nil)),
                            key: "local|\(action.deviceId)|\(action.id)")
                        return await DeviceCapabilities(ledgerURL: ledgerURL).execute(action: action, jobs: [])
                    } catch { XCTFail("Unable to persist fixture receipt: \(error)"); return DeviceEffectOutcome(status: "uncertain") }
                })
            await store.synchronize()
            await store.runButton(workflowID: "fixture-workflow", buttonID: "run")
            let firstActions = await server.actionLog()
            let first = try XCTUnwrap(firstActions.first)
            XCTAssertEqual(first.status, status)
            let restored = makeStore(server: server, directory: folder, vault: vault)
            let effects = DeviceCapabilities(ledgerURL: ledgerURL)
            restored.configureEffects(capabilities: { [Capability(id: "notification.cancel", status: "available")] },
                execute: { action in await effects.execute(action: action, jobs: []) })
            let runID = try XCTUnwrap(restored.runs.first?.id)
            await restored.resumeRun(id: runID)
            let actions = await server.actionLog()
            XCTAssertEqual(actions.count, 2)
            XCTAssertNotEqual(actions[0].id, actions[1].id)
            XCTAssertEqual(actions.map(\.status), [status, "applied"])
            XCTAssertEqual(actions[0].input, actions[1].input)
            XCTAssertEqual(restored.runs.first?.status, "completed")
            XCTAssertEqual(restored.queuedCount, 0)
            let ledger = try EffectLedger(url: ledgerURL)
            XCTAssertEqual(ledger.entries["local|fixture-device|\(first.id)"]?.receipt?.status, status)
            await restored.resumeRun(id: runID)
            let afterSecondResume = await server.actionLog()
            XCTAssertEqual(afterSecondResume.count, 2)
        }
    }

    func testExplicitResumeNeverReplaysAnUncertainEffect() async throws {
        let button = WorkflowButton(id: "run", title: "Run", steps: [
            WorkflowStep(kind: "device_action", capability: "notification.cancel",
                         input: ["notificationId": BindingValue(value: .string("fixture-notification"))]),
            WorkflowStep(kind: "message", text: "Must not follow an uncertain effect")
        ])
        let server = StateTestServer(workflow: fixture(buttons: [button]))
        let store = makeStore(server: server, directory: try directory(), vault: vault())
        var attempts = 0
        store.configureEffects(capabilities: { [Capability(id: "notification.cancel", status: "available")] },
                               execute: { _ in attempts += 1; return DeviceEffectOutcome(status: "uncertain", result: "Interrupted") })
        await store.synchronize()
        await store.runButton(workflowID: "fixture-workflow", buttonID: "run")
        let run = try XCTUnwrap(store.runs.first)
        await store.resumeRun(id: run.id)
        await store.synchronize()
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(store.runs.first?.stepIDs, run.stepIDs)
        XCTAssertEqual(store.runs.first?.status, "failed")
        let actions = await server.actionLog()
        XCTAssertEqual(actions.map(\.status), ["uncertain"])
        let messages = await server.messageLog()
        XCTAssertTrue(messages.isEmpty)
    }

    func testExplicitNullBindingAndStepDecodeAsClearNotMissing() throws {
        let step = try JSONDecoder().decode(WorkflowStep.self, from: Data("{\"kind\":\"set_value\",\"fieldId\":\"title\",\"value\":null}".utf8))
        XCTAssertEqual(step.value, .null)
        let binding = try JSONDecoder().decode(BindingValue.self, from: Data("{\"value\":null}".utf8))
        XCTAssertEqual(binding.value, .null)
        let missing = try JSONDecoder().decode(BindingValue.self, from: Data("{}".utf8))
        XCTAssertNil(missing.value)
    }

    func testPairingRejectsUnsafeServerOrigins() throws {
        for server in ["http://companion.example", "https://user:secret@companion.example", "https://companion.example/path", "https://companion.example?token=value", "https://companion.example#fragment", "file:///tmp/state"] {
            XCTAssertThrowsError(try CompanionClient.validateServer(server))
        }
        XCTAssertEqual(try CompanionClient.validateServer("https://companion.example").host, "companion.example")
        #if DEBUG
        XCTAssertNoThrow(try CompanionClient.validateServer("http://127.0.0.1:8787"))
        #endif
    }
}
