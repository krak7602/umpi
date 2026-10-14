import XCTest

/// These tests use a real isolated coordinator. Supply a fresh one-use pairing
/// code and origin to the test runner; no app data, network, or effects are mocked.
@MainActor
final class CompanionUITests: XCTestCase {
    func testPairCreateEditAndRefreshPreservesDraft() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let origin = environment["UMPI_UI_TEST_ORIGIN"],
              let code = environment["UMPI_UI_TEST_CODE"],
              !origin.isEmpty, !code.isEmpty else {
            throw XCTSkip("Set UMPI_UI_TEST_ORIGIN and a fresh UMPI_UI_TEST_CODE for an isolated real coordinator.")
        }
        let app = XCUIApplication()
        app.launchEnvironment["UMPI_UI_TEST_ORIGIN"] = origin
        app.launchEnvironment["UMPI_UI_TEST_CODE"] = code
        app.launch()

        let connect = app.buttons["pairing.connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 10), "Use a clean simulator app installation; this test must exercise real pairing.")
        XCTAssertEqual(app.textFields["pairing.server"].value as? String, origin)
        connect.tap()
        let create = app.buttons["workflows.create"]
        XCTAssertTrue(create.waitForExistence(timeout: 45), "Real coordinator pairing must succeed.")

        create.tap()
        let title = "UI verification \(UUID().uuidString)"
        let titleField = app.textFields["create.title"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.tap()
        titleField.typeText(title)
        let fieldLabel = app.textFields["create.field.label"].firstMatch
        fieldLabel.tap()
        fieldLabel.typeText("Input")
        app.buttons["create.submit"].tap()

        let workflow = app.staticTexts[title].firstMatch
        XCTAssertTrue(workflow.waitForExistence(timeout: 30), "The coordinator-created workflow must appear in the real list.")
        workflow.tap()
        let input = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workflow.field.")).firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        let draft = "Local draft retained \(UUID().uuidString)"
        input.typeText(draft)
        app.buttons["workflow.refresh"].tap()
        XCTAssertTrue(app.buttons["workflow.save"].waitForExistence(timeout: 10))
        XCTAssertEqual(input.value as? String, draft, "Refreshing a real server snapshot must not replace unsaved input.")

        app.terminate()
        app.launch()
        let restoredWorkflow = app.staticTexts[title].firstMatch
        XCTAssertTrue(restoredWorkflow.waitForExistence(timeout: 15))
        restoredWorkflow.tap()
        let restoredInput = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workflow.field.")).firstMatch
        XCTAssertTrue(restoredInput.waitForExistence(timeout: 10))
        XCTAssertEqual(restoredInput.value as? String, draft, "The protected draft must survive app termination.")
        app.buttons["workflow.save"].tap()
        let save = app.buttons["workflow.save"]
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: save)
        XCTAssertEqual(XCTWaiter.wait(for: [saved], timeout: 30), .completed, "A real revision-safe mutation must finish before asserting server persistence.")
        app.buttons["workflow.refresh"].tap()
        XCTAssertEqual(restoredInput.value as? String, draft)
    }
}
