import Foundation

// Run from the repository root:
// swift ios/Tools/GenerateMenuBarIcon.swift ios/UmpiMac/Assets.xcassets/MenuBarIcon.imageset/MenuBarIcon.svg
//
// The Mac menu bar icon, "slim swirl": three slim loops taken from the voice orb's flowing layers, each slightly off
// centre, at uneven angles, and bent so they turn around the middle. Every number that shapes it is below, so running
// this again writes the same file byte for byte; change a number here, never the SVG by hand.
// The SVG is a template image: macOS draws it black or white to suit the menu bar.

/// One loop: an ellipse with half-length `length` and half-width `width`, centred at (x, y) in the 24-point grid,
/// turned by `angle` degrees and bent by `bend` (0 is a plain ellipse).
struct Loop { let x, y, length, width, angle, bend: Double }

let loops = [
    Loop(x: 12.4, y: 11.0, length: 9.0, width: 2.6, angle: -20, bend: 0.55),
    Loop(x: 11.0, y: 12.4, length: 8.6, width: 2.5, angle: 48, bend: 0.55),
    Loop(x: 12.6, y: 13.2, length: 8.8, width: 2.6, angle: 112, bend: 0.55),
]
let strokeWidth = 1.5
let samples = 28  // points around each loop before smoothing

/// Points around one loop.
func points(_ loop: Loop) -> [(Double, Double)] {
    let radians = loop.angle * .pi / 180
    return (0..<samples).map { index in
        let t = Double(index) / Double(samples) * 2 * .pi
        let x = loop.length * cos(t)
        // The bend lifts the loop's ends, so it curves instead of lying straight.
        let y = loop.width * sin(t) + loop.bend * (x * x) / (loop.length * loop.length) * loop.length * 0.35
        return (loop.x + x * cos(radians) - y * sin(radians), loop.y + x * sin(radians) + y * cos(radians))
    }
}

/// A closed Catmull-Rom spline through the points, as cubic Béziers: one smooth line with no corners.
func smoothPath(_ p: [(Double, Double)]) -> String {
    func f(_ value: Double) -> String { String(format: "%.2f", value) }
    let n = p.count
    var d = "M\(f(p[0].0)) \(f(p[0].1))"
    for i in 0..<n {
        let p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n]
        let c1 = (p1.0 + (p2.0 - p0.0) / 6, p1.1 + (p2.1 - p0.1) / 6)
        let c2 = (p2.0 - (p3.0 - p1.0) / 6, p2.1 - (p3.1 - p1.1) / 6)
        d += "C\(f(c1.0)) \(f(c1.1)) \(f(c2.0)) \(f(c2.1)) \(f(p2.0)) \(f(p2.1))"
    }
    return d + "Z"
}

guard CommandLine.arguments.count == 2 else { fatalError("Pass the output SVG path.") }
let paths = loops.map { "<path d=\"\(smoothPath(points($0)))\" fill=\"none\" stroke=\"#000000\" stroke-width=\"\(strokeWidth)\" stroke-linejoin=\"round\"/>" }
let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\">\(paths.joined())</svg>\n"
try svg.write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8)
print("Wrote \(CommandLine.arguments[1])")
