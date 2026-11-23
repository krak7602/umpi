import SwiftUI
import XCTest
@testable import Umpi

/// UI blocks are drawn from the coordinator's checked JSON. Every title and number here is invented.
final class UIBlockTests: XCTestCase {
    private func value(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    func testReadsAComponentTreeFromJSON() throws {
        let block = try value("""
        {"type":"card","title":"Trains to the coast","tone":"accent","children":[
          {"type":"table","columns":[{"title":"Leaves"},{"title":"Fare","align":"end"}],"rows":[["07:10","420"],["09:40","380"]]},
          {"type":"progress","value":0.4,"label":"Seats sold"},
          {"type":"list","style":"checklist","items":[{"title":"Water the ferns","checked":true},{"title":"Pack a coat"}]},
          {"type":"chart","kind":"line","series":[{"name":"Fare","points":[{"x":"Mon","y":420},{"x":"Tue","y":380.5}]}]}
        ]}
        """)
        let card = try XCTUnwrap(UIProps(block))
        XCTAssertEqual(card.type, "card")
        XCTAssertEqual(card.text("title"), "Trains to the coast")
        XCTAssertNotNil(card.tone)
        XCTAssertEqual(card.children.map(\.type), ["table", "progress", "list", "chart"])

        let table = card.children[0]
        XCTAssertEqual(table.list("columns").map { $0.text("title") }, ["Leaves", "Fare"])
        XCTAssertEqual(table.list("columns")[1].text("align"), "end")
        XCTAssertEqual(table.rows("rows"), [["07:10", "420"], ["09:40", "380"]])

        XCTAssertEqual(card.children[1].number("value"), 0.4)
        let items = card.children[2].list("items")
        XCTAssertEqual(items.map { $0.flag("checked") }, [true, false])
        XCTAssertNil(items[0].type, "a list entry is not a component")

        let points = card.children[3].list("series")[0].list("points")
        XCTAssertEqual(points.map { $0.text("x") }, ["Mon", "Tue"])
        XCTAssertEqual(points.map { $0.number("y") }, [420, 380.5])
    }

    func testWhatThisBuildDoesNotKnowIsLeftOutNotAnError() throws {
        // A newer coordinator may send a component, a property, or a tone this build has never seen.
        let block = try value("""
        {"type":"stack","glow":true,"children":[{"type":"hologram","depth":3},{"type":"badge","label":"Open","tone":"ultraviolet"},"stray text",{"label":"no type"}]}
        """)
        let stack = try XCTUnwrap(UIProps(block))
        XCTAssertEqual(stack.children.map(\.type), ["hologram", "badge", nil], "a child that is not an object is dropped")
        XCTAssertNil(stack.children[1].tone, "an unknown tone keeps the default colour")
        XCTAssertNil(UITone.color("ultraviolet"))
        XCTAssertNotNil(UITone.color("critical"))
        XCTAssertNil(UIProps(try value("\"just text\"")), "a block that is not an object draws nothing")
        XCTAssertNil(stack.text("missing"))
        XCTAssertEqual(stack.rows("missing"), [])
        XCTAssertNil(try XCTUnwrap(UIProps(try value("{\"type\":\"text\",\"text\":\"\"}"))).text("text"), "empty text counts as none")
    }

    func testNumbersReadAsTextTheWayTheOwnerReadsThem() throws {
        let stat = try XCTUnwrap(UIProps(try value("{\"type\":\"stat\",\"label\":\"Fare\",\"value\":420,\"detail\":3.25}")))
        XCTAssertEqual(stat.text("value"), "420")
        XCTAssertEqual(stat.text("detail"), "3.25")
    }

    func testABlockSurvivesEncodingForTheSavedChat() throws {
        let block = try value("{\"type\":\"keyvalue\",\"rows\":[{\"label\":\"Platform\",\"value\":\"3\"}],\"open\":false,\"note\":null}")
        let again = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(block))
        XCTAssertEqual(again, block)
    }
}
