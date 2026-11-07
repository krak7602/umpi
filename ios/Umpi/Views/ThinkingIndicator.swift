import SwiftUI

/// What the chat shows while Umpi works on a reply: a single thread tied in a trefoil knot, echoing the menu bar mark,
/// that drifts and turns in 3D. No text: the knot says it, and VoiceOver reads "Umpi is thinking". With Reduce Motion on,
/// it stays still.
struct ThinkingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var since = Date()
    /// Smaller on the Mac, where the chat's text is smaller too.
    #if os(macOS)
    static let side: CGFloat = 20
    #else
    static let side: CGFloat = 30
    #endif

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: reduceMotion)) { timeline in
            ThreadKnot(time: (reduceMotion ? 0 : max(0, timeline.date.timeIntervalSince(since))) + 5)
        }
        .frame(width: Self.side, height: Self.side)
        .accessibilityElement()
        .accessibilityLabel("Umpi is thinking")
    }
}

/// The knot, drawn back to front so its crossings show which strand is on top.
struct ThreadKnot: View {
    let time: TimeInterval

    var body: some View {
        Canvas { context, size in
            let side = min(size.width, size.height), scale = side * 0.45
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let base = side < 40 ? side * 0.08 : side * 0.046
            #if os(macOS)
            let background = Color(nsColor: .windowBackgroundColor)
            #else
            let background = Color(.systemBackground)
            #endif
            // Blended by hand from the two resolved colours: `Color.mix` gave neighbouring pieces visibly different
            // shades, which banded the thread.
            let ink = Color.primary.resolve(in: context.environment), paper = background.resolve(in: context.environment)
            func shade(_ amount: Double) -> Color {
                let a = Float(amount)
                return Color(Color.Resolved(colorSpace: .sRGB, red: ink.red + (paper.red - ink.red) * a,
                                            green: ink.green + (paper.green - ink.green) * a,
                                            blue: ink.blue + (paper.blue - ink.blue) * a, opacity: 1))
            }
            context.drawLayer { layer in
                for piece in TrefoilThread.pieces(at: time) {
                    let place = { (p: CGPoint) in CGPoint(x: center.x + p.x * scale, y: center.y + p.y * scale) }
                    var path = Path(), cut = Path()
                    path.addLines(piece.points.map(place))
                    cut.addLines(piece.gap.map(place))
                    let near = max(0, min(1, 0.5 + piece.depth * 0.8)), width = base * (0.7 + 0.55 * near)
                    // Where a piece passes over another part of the thread, a gap is cut under it so it reads as on top.
                    // Only there: cutting everywhere left a fine speckle along the thread.
                    if piece.crossesOver {
                        var gap = layer
                        gap.blendMode = .destinationOut
                        gap.stroke(cut, with: .color(.black), style: StrokeStyle(lineWidth: width + max(1.2, width * 0.8), lineCap: .butt, lineJoin: .round))
                    }
                    // Nearer is brighter and thicker. Opaque colours and flat, overlapping ends, so pieces join without
                    // beads or seams.
                    layer.stroke(path, with: .color(shade(0.62 * (1 - near) + 0.08)),
                                 style: StrokeStyle(lineWidth: width, lineCap: .butt, lineJoin: .round))
                }
            }
        }
    }
}

/// A (2, 3) curve on a torus: one closed thread tied in a trefoil knot. Points that share a place round the ring sit
/// on opposite sides of the tube, and the tube stays thinner than the ring, so however its radii swell and it slides
/// along itself, the thread never passes through itself and every crossing keeps its order. The drift comes from
/// smooth noise, so it never repeats.
enum TrefoilThread {
    /// `gap` is the stretch a nearer piece cuts out under itself; `points` runs a point further each way, so the
    /// stroke covers the cut's ends and pieces meet without a seam.
    struct Piece { var points: [CGPoint]; var gap: [CGPoint]; var depth: Double; var crossesOver: Bool }

    static func pieces(at t: TimeInterval, count: Int = 240, step: Int = 3) -> [Piece] {
        let slow = t * 0.3, flow = t * 0.5
        let ax = 0.25 + 0.4 * Noise.at(slow * 0.7, 80, 0.5), ay = 0.4 * Noise.at(90, slow * 0.7, 0.9)
        let az = t * 0.16 + 1.2 * Noise.at(0, 100, slow * 0.3)
        let (sx, cx, sy, cy, sz, cz) = (sin(ax), cos(ax), sin(ay), cos(ay), sin(az), cos(az))
        var points: [(x: Double, y: Double, z: Double)] = []
        points.reserveCapacity(count)
        for j in 0..<count {
            let phi = Double(j) / Double(count) * 2 * .pi, c = cos(phi), s = sin(phi)
            // Noise sampled round a circle, so the loop closes smoothly.
            let tube = 0.3 * (1 + 0.38 * Noise.at(c * 1.1, s * 1.1, slow))
            let ring = 0.58 * (1 + 0.1 * Noise.at(c * 0.9 + 30, s * 0.9, slow * 0.8))
            let theta = 3 * phi + flow * 1.5, alpha = 2 * phi + flow
            var x = (ring + tube * cos(theta)) * cos(alpha), y = (ring + tube * cos(theta)) * sin(alpha), z = tube * sin(theta) * 1.2
            (x, y) = (x * cz - y * sz, x * sz + y * cz)
            (y, z) = (y * cx - z * sx, y * sx + z * cx)
            (x, z) = (x * cy + z * sy, -x * sy + z * cy)
            let perspective = 3.5 / (3.5 - z)
            points.append((x * perspective, y * perspective, z))
        }
        // Whether a stretch lies over another, deeper part of the thread (not its own neighbours) on screen.
        func crossesOver(_ start: Int) -> Bool {
            for offset in 0...step {
                let i = (start + offset) % count, p = points[i]
                for j in stride(from: 0, to: count, by: 2) {
                    let apart = abs(i - j), along = min(apart, count - apart)
                    guard along > count / 12, points[j].z < p.z else { continue }
                    let dx = points[j].x - p.x, dy = points[j].y - p.y
                    if dx * dx + dy * dy < 0.09 { return true }
                }
            }
            return false
        }
        var pieces: [Piece] = []
        for start in stride(from: 0, to: count, by: step) {
            let core = (0...step).map { points[(start + $0) % count] }
            let run = (-1...(step + 1)).map { points[(start + $0 + count) % count] }
            pieces.append(Piece(points: run.map { CGPoint(x: $0.x, y: $0.y) }, gap: core.map { CGPoint(x: $0.x, y: $0.y) },
                                depth: core.reduce(0) { $0 + $1.z } / Double(core.count), crossesOver: crossesOver(start)))
        }
        return pieces.sorted { $0.depth < $1.depth }
    }
}

/// 3D simplex noise (after Stefan Gustavson's public-domain reference), in about -1...1.
enum Noise {
    private static let gradients: [(Double, Double, Double)] = [(1,1,0),(-1,1,0),(1,-1,0),(-1,-1,0),(1,0,1),(-1,0,1),(1,0,-1),(-1,0,-1),(0,1,1),(0,-1,1),(0,1,-1),(0,-1,-1)]
    private static let permutation: [Int] = {
        var p = Array(0..<256), seed = 11
        for i in stride(from: 255, to: 0, by: -1) {
            seed = (seed * 16807) % 2147483647
            p.swapAt(i, seed % (i + 1))
        }
        return p + p
    }()

    static func at(_ x: Double, _ y: Double, _ z: Double) -> Double {
        let f3 = 1.0 / 3, g3 = 1.0 / 6
        let s = (x + y + z) * f3
        let i = Int(floor(x + s)), j = Int(floor(y + s)), k = Int(floor(z + s))
        let t = Double(i + j + k) * g3
        let x0 = x - (Double(i) - t), y0 = y - (Double(j) - t), z0 = z - (Double(k) - t)
        let (i1, j1, k1, i2, j2, k2): (Int, Int, Int, Int, Int, Int)
        if x0 >= y0 {
            if y0 >= z0 { (i1, j1, k1, i2, j2, k2) = (1, 0, 0, 1, 1, 0) }
            else if x0 >= z0 { (i1, j1, k1, i2, j2, k2) = (1, 0, 0, 1, 0, 1) }
            else { (i1, j1, k1, i2, j2, k2) = (0, 0, 1, 1, 0, 1) }
        } else {
            if y0 < z0 { (i1, j1, k1, i2, j2, k2) = (0, 0, 1, 0, 1, 1) }
            else if x0 < z0 { (i1, j1, k1, i2, j2, k2) = (0, 1, 0, 0, 1, 1) }
            else { (i1, j1, k1, i2, j2, k2) = (0, 1, 0, 1, 1, 0) }
        }
        let corners: [(Double, Double, Double, Int, Int, Int)] = [
            (x0, y0, z0, 0, 0, 0),
            (x0 - Double(i1) + g3, y0 - Double(j1) + g3, z0 - Double(k1) + g3, i1, j1, k1),
            (x0 - Double(i2) + 2 * g3, y0 - Double(j2) + 2 * g3, z0 - Double(k2) + 2 * g3, i2, j2, k2),
            (x0 - 1 + 3 * g3, y0 - 1 + 3 * g3, z0 - 1 + 3 * g3, 1, 1, 1),
        ]
        var n = 0.0
        for (a, b, d, di, dj, dk) in corners {
            var weight = 0.6 - a * a - b * b - d * d
            guard weight > 0 else { continue }
            let index = permutation[((i + di) & 255) + permutation[((j + dj) & 255) + permutation[(k + dk) & 255]]] % 12
            let g = gradients[index]
            weight *= weight
            n += weight * weight * (g.0 * a + g.1 * b + g.2 * d)
        }
        return 32 * n
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 24) {
        ThreadKnot(time: 5).frame(width: 120, height: 120)
        ThinkingIndicator()
    }
    .padding()
}
