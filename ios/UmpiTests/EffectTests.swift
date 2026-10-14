import ActivityKit
import Foundation
import UserNotifications
import XCTest
@testable import Umpi

@MainActor
final class EffectTests: XCTestCase {
    private func temporaryLedger() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("receipts.json")
    }

    private func action(capability: String = "notification.cancel", input: [String: FieldValue]? = nil) -> DeviceAction {
        DeviceAction(id: UUID().uuidString, deviceId: "test-device", capability: capability,
                     input: input ?? ["notificationId": .string("test-" + UUID().uuidString)], status: "pending",
                     createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
    }

    func testDurableIntentAndReceiptSurviveReopening() throws {
        let url = temporaryLedger()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let request = action()
        let fingerprint = try EffectLedger.fingerprint(request)
        let ledger = try EffectLedger(url: url)
        var intent = EffectIntent(fingerprint: fingerprint, phase: "cancelling", approved: true)
        try ledger.save(intent, key: request.id)
        let interrupted = try EffectLedger(url: url)
        XCTAssertEqual(try interrupted.entry(key: request.id, fingerprint: fingerprint), intent)
        XCTAssertNil(try interrupted.entry(key: request.id, fingerprint: fingerprint)?.receipt)

        intent.phase = "finished"
        intent.receipt = EffectReceipt(status: "applied", result: "Registration is absent")
        try interrupted.save(intent, key: request.id)
        let reopened = try EffectLedger(url: url)
        XCTAssertEqual(try reopened.entry(key: request.id, fingerprint: fingerprint)?.receipt, intent.receipt)
        XCTAssertThrowsError(try reopened.entry(key: request.id, fingerprint: "different"))
        XCTAssertThrowsError(try reopened.save(EffectIntent(fingerprint: "different"), key: request.id))
        XCTAssertEqual(try EffectLedger(url: url).entry(key: request.id, fingerprint: fingerprint)?.receipt, intent.receipt)
    }

    func testFingerprintIsCanonicalAndBindsExactEffect() throws {
        var first = action(capability: "notification.schedule", input: ["title": .string("Test"), "body": .string("Body")])
        var second = first
        second.input = ["body": .string("Body"), "title": .string("Test")]
        second.status = "applied"
        second.isLocal = true
        XCTAssertEqual(try EffectLedger.fingerprint(first), try EffectLedger.fingerprint(second))
        second.input["title"] = .string("Different")
        XCTAssertNotEqual(try EffectLedger.fingerprint(first), try EffectLedger.fingerprint(second))
        first.deviceId = "another-device"
        XCTAssertNotEqual(try EffectLedger.fingerprint(first), try EffectLedger.fingerprint(second))
    }

    func testRemoteActionNeedsTrustedConsentBeforeAnyEffect() async {
        let url = temporaryLedger()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let effects = DeviceCapabilities(ledgerURL: url)
        let request = action()
        let result = await effects.execute(action: request, jobs: [])
        XCTAssertEqual(result.status, "pending")
        XCTAssertEqual(effects.pendingReview.map(\.id), [request.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testRealNotificationCancellationAndReceiptReplay() async throws {
        let url = temporaryLedger()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var request = action()
        request.isLocal = true
        let first = await DeviceCapabilities(ledgerURL: url).execute(action: request, jobs: [])
        XCTAssertEqual(first.status, "applied")
        let replay = await DeviceCapabilities(ledgerURL: url).execute(action: request, jobs: [])
        XCTAssertEqual(replay, first)
        request.input["notificationId"] = .string("different-" + UUID().uuidString)
        let conflict = await DeviceCapabilities(ledgerURL: url).execute(action: request, jobs: [])
        XCTAssertEqual(conflict.status, "conflict")
    }

    func testInterruptedScheduleWithoutRegistrationIsNeverRepeated() async throws {
        let url = temporaryLedger()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let identifier = "test-" + UUID().uuidString
        var request = action(capability: "notification.schedule", input: [
            "notificationId": .string(identifier), "title": .string("Test"), "body": .string("Test body"),
            "date": .string(ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)))
        ])
        request.isLocal = true
        let fingerprint = try EffectLedger.fingerprint(request)
        let ledger = try EffectLedger(url: url)
        try ledger.save(EffectIntent(fingerprint: fingerprint, phase: "scheduling"),
                        key: "local|\(request.deviceId)|\(request.id)")
        let result = await DeviceCapabilities(ledgerURL: url).execute(action: request, jobs: [])
        XCTAssertEqual(result.status, "uncertain")
        let pending = await UNUserNotificationCenter.current().pendingNotificationRequests()
        XCTAssertFalse(pending.contains(where: { $0.identifier == identifier }))
        let replay = await DeviceCapabilities(ledgerURL: url).execute(action: request, jobs: [])
        XCTAssertEqual(replay, result)
    }

    func testInterruptedCancellationObservesAbsence() async throws {
        let url = temporaryLedger()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let request = action()
        let ledger = try EffectLedger(url: url)
        try ledger.save(EffectIntent(fingerprint: EffectLedger.fingerprint(request), phase: "cancelling", approved: true),
                        key: "local|\(request.deviceId)|\(request.id)")
        let result = await DeviceCapabilities(ledgerURL: url).execute(action: request, jobs: [])
        XCTAssertEqual(result.status, "applied")
    }

    func testCorruptLedgerFailsClosed() async throws {
        let url = temporaryLedger()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("invalid receipt data".utf8).write(to: url)
        let effects = DeviceCapabilities(ledgerURL: url)
        let result = await effects.execute(action: action(), jobs: [])
        XCTAssertEqual(result.status, "uncertain")
        XCTAssertNotNil(effects.errorMessage)
        XCTAssertTrue(effects.pendingReview.isEmpty)
    }

    func testOlderSystemsDoNotFallbackFromAlarmToNotification() async throws {
        if #available(iOS 26.0, *) { throw XCTSkip("Requires an iOS 18–25 runtime") }
        let url = temporaryLedger()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let identifier = UUID().uuidString
        var request = action(capability: "alarm.schedule", input: [
            "alarmId": .string(identifier), "title": .string("Test alarm"),
            "date": .string(ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)))
        ])
        request.isLocal = true
        let effects = DeviceCapabilities(ledgerURL: url)
        let capabilities = await effects.refreshCapabilities()
        XCTAssertEqual(capabilities.first(where: { $0.id == "alarm.schedule" })?.status, "unsupported")
        let result = await effects.execute(action: request, jobs: [])
        XCTAssertEqual(result.status, "unsupported")
        let pending = await UNUserNotificationCenter.current().pendingNotificationRequests()
        XCTAssertFalse(pending.contains(where: { $0.identifier == identifier }))
    }

    func testWireActionValidationRejectsInvalidIdentifiersTypesBoundsAndCalendarDates() {
        let valid: [String: FieldValue] = [
            "notificationId": .string("reminder:one"),
            "title": .string(String(repeating: "😀", count: 128)),
            "body": .string(String(repeating: "b", count: 4_096)),
            "date": .string("2096-02-29T23:59:59.123+01:00")
        ]
        func accepts(_ input: [String: FieldValue], id: String = "action", device: String = "device") -> Bool {
            DeviceActionValidation.valid(id: id, deviceID: device, capability: "notification.schedule", input: input)
        }
        XCTAssertTrue(accepts(valid))
        var emptyBody = valid
        emptyBody["body"] = .string("")
        XCTAssertTrue(accepts(emptyBody))
        for id in ["my reminder", "", "_prefix", String(repeating: "a", count: 129), "line\n", "line\r", "éclair"] {
            var input = valid
            input["notificationId"] = .string(id)
            XCTAssertFalse(accepts(input), id)
            XCTAssertFalse(accepts(valid, id: id), id)
            XCTAssertFalse(accepts(valid, device: id), id)
        }
        for (key, value) in [
            ("notificationId", FieldValue.number(12)), ("title", .bool(true)), ("body", .null),
            ("title", .string("")), ("title", .string(String(repeating: "😀", count: 129))),
            ("body", .string(String(repeating: "b", count: 4_097))), ("title", .string("null\0character")),
            ("date", .number(4_000_000_000))
        ] {
            var input = valid
            input[key] = value
            XCTAssertFalse(accepts(input), key)
        }
        for date in ["2099-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2099-04-31T00:00:00Z",
                     "2099-00-01T00:00:00Z", "2099-13-01T00:00:00Z", "2099-01-00T00:00:00Z",
                     "2099-01-01T24:00:00Z", "2099-01-01T00:60:00Z", "2099-01-01T00:00:60Z",
                     "2099-01-01", "2099-01-01T00:00:00", "2099-01-01T00:00:00Z\n",
                     "2099-01-01T00:00:00+25:00", "2099-01-01T00:00:00+01:60"] {
            var input = valid
            input["date"] = .string(date)
            XCTAssertFalse(accepts(input), date)
        }
        var extra = valid
        extra["unexpected"] = .string("value")
        XCTAssertFalse(accepts(extra))
        var missing = valid
        missing.removeValue(forKey: "body")
        XCTAssertFalse(accepts(missing))
        XCTAssertFalse(DeviceActionValidation.valid(id: "action", deviceID: "device", capability: "alarm.cancel",
                                                   input: ["alarmId": .string("not-a-uuid")]))
        XCTAssertTrue(DeviceActionValidation.valid(id: "action", deviceID: "device", capability: "alarm.cancel",
                                                  input: ["alarmId": .string(UUID().uuidString)]))
        XCTAssertFalse(DeviceActionValidation.valid(id: "action", deviceID: "device", capability: "activity.track",
                                                   input: ["jobId": .string("invalid job")]))
    }

    func testInvalidNotificationInputGetsDurableFailureWithoutOSRegistration() async throws {
        let url = temporaryLedger()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var request = action(input: ["notificationId": .string("my reminder")])
        request.isLocal = true
        let effects = DeviceCapabilities(ledgerURL: url)
        let result = await effects.execute(action: request, jobs: [])
        XCTAssertEqual(result.status, "failed")
        XCTAssertNotEqual(result.retryableWithoutEffect, true)
        let ledger = try EffectLedger(url: url)
        let entry = try XCTUnwrap(ledger.entries["local|\(request.deviceId)|\(request.id)"])
        XCTAssertNil(entry.registrationID)
        XCTAssertNil(entry.observedAt)
        XCTAssertEqual(entry.receipt?.status, "failed")
        let replay = await DeviceCapabilities(ledgerURL: url).execute(action: request, jobs: [])
        XCTAssertEqual(replay, result)
    }

    func testLiveActivityWireStateContainsOnlyTitleAndStatus() throws {
        let state = TaskActivityAttributes.ContentState(title: "Umpi task test-job", status: "running")
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: String])
        XCTAssertEqual(Set(payload.keys), ["title", "status"])
        XCTAssertFalse(state.isTerminal)
        for terminal in ["succeeded", "failed", "cancelled", "uncertain"] {
            XCTAssertTrue(TaskActivityAttributes.ContentState(title: "Task", status: terminal).isTerminal)
        }
    }
}
