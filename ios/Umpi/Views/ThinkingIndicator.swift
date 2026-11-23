import SwiftUI

/// What the chat shows while Umpi works on a reply: a single thread tied in a trefoil knot, echoing the menu bar mark,
/// that drifts and turns in 3D. No text: the knot says it, and VoiceOver reads "Umpi is thinking". With Reduce Motion on,
/// it stays still. It is drawn 30 times a second, and not at all while it is scrolled out of view, on a hidden tab, or
/// (on the phone) while the app is not in front.
struct ThinkingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(iOS)
    @Environment(\.scenePhase) private var scenePhase
    #endif
    @State private var since = Date()
    /// In the visible part of the chat's scroll view.
    @State private var inView = true
    /// On screen: false on a tab that is not shown.
    @State private var appeared = true
    @State private var thread = TrefoilThread.Frame()
    /// Smaller on the Mac, where the chat's text is smaller too.
    #if os(macOS)
    static let side: CGFloat = 20
    #else
    static let side: CGFloat = 30
    #endif

    private var paused: Bool {
        #if os(iOS)
        reduceMotion || !inView || !appeared || scenePhase == .background
        #else
        reduceMotion || !inView || !appeared
        #endif
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: paused)) { timeline in
            ThreadKnot(time: (reduceMotion ? 0 : max(0, timeline.date.timeIntervalSince(since))) + 5, thread: thread)
        }
        .frame(width: Self.side, height: Self.side)
        .onVisibilityInScrollView { visible in if visible != inView { inView = visible } }
        .onAppear { appeared = true }
        .onDisappear { appeared = false }
        .accessibilityElement()
        .accessibilityLabel("Umpi is thinking")
    }
}

/// The knot, drawn back to front so its crossings show which strand is on top.
struct ThreadKnot: View {
    let time: TimeInterval
    /// The thread's points, kept between frames so a frame allocates nothing for them.
    var thread = TrefoilThread.Frame()

    var body: some View {
        let thread = thread
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
            thread.move(to: time)
            let count = thread.count, step = thread.step
            func place(_ index: Int) -> CGPoint {
                let i = (index + count) % count
                return CGPoint(x: center.x + thread.x[i] * scale, y: center.y + thread.y[i] * scale)
            }
            context.drawLayer { layer in
                for piece in thread.order {
                    let start = piece * step
                    // The stroke runs a point further each way than the piece, so it covers the ends of the cut below
                    // and pieces meet without a seam.
                    var path = Path()
                    path.move(to: place(start - 1))
                    for offset in 0...(step + 1) { path.addLine(to: place(start + offset)) }
                    let near = max(0, min(1, 0.5 + thread.depth[piece] * 0.8)), width = base * (0.7 + 0.55 * near)
                    // Where a piece passes over another part of the thread, a gap is cut under it so it reads as on top.
                    // Only there: cutting everywhere left a fine speckle along the thread.
                    if thread.crossesOver[piece] {
                        var cut = Path()
                        cut.move(to: place(start))
                        for offset in 1...step { cut.addLine(to: place(start + offset)) }
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
    /// The thread at one moment: its points, and its pieces from the farthest to the nearest. One frame is used for
    /// every drawing, so its arrays are made once.
    final class Frame {
        let count: Int
        /// A piece is `step` points long.
        let step: Int
        private(set) var x: [Double], y: [Double], z: [Double]
        /// Each piece's mean depth; nearer is larger.
        private(set) var depth: [Double]
        /// The piece lies over another, deeper part of the thread (not its own neighbours) on screen.
        private(set) var crossesOver: [Bool]
        /// The pieces from the farthest to the nearest. Piece `p` starts at point `p * step`.
        private(set) var order: [Int]
        private var time: TimeInterval?

        init(count: Int = 240, step: Int = 3) {
            self.count = count
            self.step = step
            x = Array(repeating: 0, count: count); y = x; z = x
            let pieces = (count + step - 1) / step
            depth = Array(repeating: 0, count: pieces)
            crossesOver = Array(repeating: false, count: pieces)
            order = Array(0..<pieces)
        }

        /// Works the thread out for time `t`, unless it is there already.
        func move(to t: TimeInterval) {
            guard t != time else { return }
            time = t
            let slow = t * 0.3, flow = t * 0.5
            let ax = 0.25 + 0.4 * Noise.at(slow * 0.7, 80, 0.5), ay = 0.4 * Noise.at(90, slow * 0.7, 0.9)
            let az = t * 0.16 + 1.2 * Noise.at(0, 100, slow * 0.3)
            let (sx, cx, sy, cy, sz, cz) = (sin(ax), cos(ax), sin(ay), cos(ay), sin(az), cos(az))
            for j in 0..<count {
                let phi = Double(j) / Double(count) * 2 * .pi, c = cos(phi), s = sin(phi)
                // Noise sampled round a circle, so the loop closes smoothly.
                let tube = 0.3 * (1 + 0.38 * Noise.at(c * 1.1, s * 1.1, slow))
                let ring = 0.58 * (1 + 0.1 * Noise.at(c * 0.9 + 30, s * 0.9, slow * 0.8))
                let theta = 3 * phi + flow * 1.5, alpha = 2 * phi + flow
                var px = (ring + tube * cos(theta)) * cos(alpha), py = (ring + tube * cos(theta)) * sin(alpha), pz = tube * sin(theta) * 1.2
                (px, py) = (px * cz - py * sz, px * sz + py * cz)
                (py, pz) = (py * cx - pz * sx, py * sx + pz * cx)
                (px, pz) = (px * cy + pz * sy, -px * sy + pz * cy)
                let perspective = 3.5 / (3.5 - pz)
                x[j] = px * perspective; y[j] = py * perspective; z[j] = pz
            }
            for piece in depth.indices {
                let start = piece * step
                var sum = 0.0
                for offset in 0...step { sum += z[(start + offset) % count] }
                depth[piece] = sum / Double(step + 1)
                crossesOver[piece] = isOver(start)
                order[piece] = piece
            }
            order.sort { depth[$0] < depth[$1] }
        }

        /// Whether a stretch lies over another, deeper part of the thread (not its own neighbours) on screen.
        private func isOver(_ start: Int) -> Bool {
            for offset in 0...step {
                let i = (start + offset) % count, px = x[i], py = y[i], pz = z[i]
                for j in stride(from: 0, to: count, by: 2) {
                    let apart = abs(i - j), along = min(apart, count - apart)
                    guard along > count / 12, z[j] < pz else { continue }
                    let dx = x[j] - px, dy = y[j] - py
                    if dx * dx + dy * dy < 0.09 { return true }
                }
            }
            return false
        }
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
        // The four corners in turn, added in the same order as a loop over them would, without an array for each call.
        var n = corner(x0, y0, z0, i, j, k)
        n += corner(x0 - Double(i1) + g3, y0 - Double(j1) + g3, z0 - Double(k1) + g3, i + i1, j + j1, k + k1)
        n += corner(x0 - Double(i2) + 2 * g3, y0 - Double(j2) + 2 * g3, z0 - Double(k2) + 2 * g3, i + i2, j + j2, k + k2)
        n += corner(x0 - 1 + 3 * g3, y0 - 1 + 3 * g3, z0 - 1 + 3 * g3, i + 1, j + 1, k + 1)
        return 32 * n
    }

    /// One corner's part of the noise at a point `(a, b, d)` away from it.
    private static func corner(_ a: Double, _ b: Double, _ d: Double, _ i: Int, _ j: Int, _ k: Int) -> Double {
        var weight = 0.6 - a * a - b * b - d * d
        guard weight > 0 else { return 0 }
        let g = gradients[permutation[(i & 255) + permutation[(j & 255) + permutation[k & 255]]] % 12]
        weight *= weight
        return weight * weight * (g.0 * a + g.1 * b + g.2 * d)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 24) {
        ThreadKnot(time: 5).frame(width: 120, height: 120)
        ThinkingIndicator()
    }
    .padding()
}
