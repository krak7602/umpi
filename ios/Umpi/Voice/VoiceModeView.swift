import SwiftUI

/// Voice mode: a hands-free spoken conversation with Umpi. The orb shows whose turn it is; captions show the owner's
/// words as they are heard and Umpi's sentence as it is spoken.
struct VoiceModeView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var conversation = VoiceConversation()
    @State private var showSettings = false
    /// Ends voice mode where it is not presented over the chat, such as in the Mac's floating panel.
    var onEnd: (() -> Void)? = nil
    /// The settings button goes in the window's toolbar, beside its title, rather than in a row of its own.
    var settingsInToolbar = false
    #if os(macOS)
    /// Keeps the display awake while voice mode shows.
    @State private var awake: NSObjectProtocol?
    static let orbSize: CGFloat = 240
    #else
    static let orbSize: CGFloat = 340
    #endif

    var body: some View {
        VStack(spacing: 0) {
            if !settingsInToolbar {
                HStack {
                    Spacer()
                    Button { showSettings = true } label: { Image(systemName: "slider.horizontal.3").font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44) }
                        .shapedButton()
                        .accessibilityLabel("Voice settings")
                }
                .tint(.primary)
                .padding(.horizontal, 8)
            }

            Spacer(minLength: 12)
            VoiceOrb(phase: conversation.phase, level: { [conversation] in conversation.level })
                // Full size where there is room; smaller in a short window, so the controls below always show.
                .frame(minWidth: 120, maxWidth: Self.orbSize, minHeight: 120, maxHeight: Self.orbSize)
                .aspectRatio(1, contentMode: .fit)
                .layoutPriority(1)
                .contentShape(Circle())
                .onTapGesture { conversation.tapped() }
                #if DEBUG
                // The simulator has no speech recognition: a long press sends a fixed question, to check the reply path.
                .onLongPressGesture { conversation.sendForTesting("What time is it? Answer in two short sentences, then add one tip for a calm evening.") }
                #endif
                .accessibilityElement()
                .accessibilityLabel(status)
                .accessibilityHint(hint)
                .accessibilityAddTraits(.isButton)

            Text(status)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .contentTransition(.opacity)
                .animation(.easeInOut(duration: 0.25), value: status)
                .padding(.top, 32)
            Text(conversation.caption)
                .font(.title3)
                .multilineTextAlignment(.center)
                .foregroundStyle(conversation.captionIsOwner ? .secondary : .primary)
                .lineLimit(5)
                .frame(maxWidth: .infinity, minHeight: 130, alignment: .top)
                .padding(.horizontal, 28)
                .padding(.top, 14)
                .animation(.easeOut(duration: 0.2), value: conversation.caption)
            if conversation.showsInChat {
                Label("Details in the chat", systemImage: "text.bubble")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }
            Spacer(minLength: 12)

            HStack(spacing: 28) {
                control(conversation.muted ? "mic.slash.fill" : "mic.fill", label: conversation.muted ? "Unmute" : "Mute", active: conversation.muted) { conversation.muted.toggle() }
                control(conversation.phase == .paused ? "play.fill" : "pause.fill", label: conversation.phase == .paused ? "Resume" : "Pause", active: conversation.phase == .paused) { conversation.togglePause() }
                Button { if let onEnd { onEnd() } else { dismiss() } } label: {
                    Image(systemName: "xmark").font(.system(size: 22, weight: .semibold)).foregroundStyle(.white)
                        .frame(width: 64, height: 64).background(Circle().fill(Color.red))
                }
                .shapedButton()
                .accessibilityLabel("End")
            }
            .padding(.bottom, 24)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .toolbar {
            if settingsInToolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showSettings = true } label: { Label("Voice settings", systemImage: "slider.horizontal.3") }
                        .help("Voice settings")
                }
            }
        }
        .task { await conversation.start(store) }
        #if os(iOS)
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { conversation.stop(); UIApplication.shared.isIdleTimerDisabled = false }
        #else
        .onAppear { awake = ProcessInfo.processInfo.beginActivity(options: [.idleDisplaySleepDisabled, .userInitiated], reason: "Voice mode is open") }
        .onDisappear {
            // Closing voice mode mid-sentence still sends what was heard, as leaving the app does on the phone.
            Task { await conversation.leaving() }
            if let awake { ProcessInfo.processInfo.endActivity(awake) }
            awake = nil
        }
        #endif
        // Voice mode only listens while it is on screen.
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                #if os(iOS)
                // Words said just before leaving are still sent; iOS gives a few seconds to do it.
                let task = UIApplication.shared.beginBackgroundTask(withName: "voice leaving")
                Task { await conversation.leaving(); UIApplication.shared.endBackgroundTask(task) }
                #else
                Task { await conversation.leaving() }
                #endif
            }
            else if phase == .active { conversation.returnedToApp(); Task { await conversation.start(store) } }
        }
        // Voice settings pause voice mode, so samples play as plain speech without the microphone or echo
        // cancellation running underneath.
        .onChange(of: showSettings) { _, open in if open { conversation.stop() } }
        .sheet(isPresented: $showSettings, onDismiss: { conversation.applySettings(); Task { await conversation.start(store) } }) {
            NavigationStack { VoiceSettingsView(inSheet: true) }
            #if os(macOS)
                .frame(minWidth: 460, minHeight: 560)
            #endif
        }
        .sensoryFeedback(.impact(weight: .light), trigger: conversation.phase == .speaking)
    }

    private var status: String {
        switch conversation.phase {
        case .starting: return "Starting…"
        case .listening: return conversation.muted ? "Muted" : "Listening"
        case .hearing: return "Listening"
        case .thinking: return "Thinking"
        case .working(let label): return label
        case .speaking: return "Umpi"
        case .paused: return "Paused"
        case .failed(let message): return message
        }
    }

    private var hint: String {
        switch conversation.phase {
        case .hearing: return "Tap to send now"
        case .speaking, .thinking, .working: return "Tap to stop Umpi"
        case .paused: return "Tap to continue"
        default: return ""
        }
    }

    private func control(_ symbol: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 20, weight: .semibold))
                .foregroundStyle(active ? Color(.systemBackground) : .primary)
                .frame(width: 56, height: 56)
                .background(Circle().fill(active ? Color.primary : Color(.secondarySystemBackground)))
        }
        .shapedButton()
        .accessibilityLabel(label)
    }
}

/// The orb: breathes while listening, follows the owner's voice while they talk, flows and morphs while Umpi thinks or
/// works, and moves with Umpi's voice while it speaks. Every change of state eases in; there is no spinner.
struct VoiceOrb: View {
    var phase: VoiceConversation.Phase
    /// Read every frame, not observed.
    var level: () -> Float
    @State private var motion = OrbMotion()

    /// What each state aims for; `OrbMotion` eases toward it frame by frame.
    private var target: OrbMotion.Values {
        switch phase {
        case .starting, .paused: return .init(wobble: 0.02, reactive: 0, flow: 0, dim: 0.35, gray: 1, red: 0)
        case .listening: return .init(wobble: 0.035, reactive: 0.6, flow: 0.15, dim: 0, gray: 0, red: 0)
        case .hearing: return .init(wobble: 0.05, reactive: 1.2, flow: 0.25, dim: 0, gray: 0, red: 0)
        case .thinking: return .init(wobble: 0.085, reactive: 0, flow: 1, dim: 0.22, gray: 0, red: 0)
        case .working: return .init(wobble: 0.1, reactive: 0, flow: 1.4, dim: 0.22, gray: 0, red: 0)
        case .speaking: return .init(wobble: 0.06, reactive: 1.0, flow: 0.35, dim: 0, gray: 0, red: 0)
        case .failed: return .init(wobble: 0.02, reactive: 0, flow: 0, dim: 0.2, gray: 0, red: 1)
        }
    }

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let v = motion.step(toward: target, at: t, level: Double(level()))
            let energy = min(1, v.level * v.reactive)
            let color = Color.accentColor.mix(with: .gray, by: v.gray * 0.85).mix(with: .red, by: v.red * 0.8)
            Canvas { canvas, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                // Room for the glow inside the canvas, so its blur is not cut off square.
                let base = min(size.width, size.height) * 0.25
                // Breathing, slower and deeper while Umpi thinks.
                let breathing = 0.025 * sin(t * 1.4) * (1 - v.flow * 0.3) + 0.03 * sin(t * 0.8) * min(1, v.flow)
                // The glow: three soft pools of light, off centre and of different sizes, drifting slowly apart and
                // back, so it is uneven like light behind moving water. Gradients only: far cheaper than a blur.
                let pools: [(dx: Double, dy: Double, size: Double, strength: Double, speed: Double)] = [
                    (0.22, -0.18, 1.35, 0.30, 0.31), (-0.26, 0.14, 1.15, 0.24, 0.23), (0.05, 0.28, 0.95, 0.20, 0.41),
                ]
                for (i, pool) in pools.enumerated() {
                    let phase = t * pool.speed + Double(i) * 2.1 + v.flowPhase * 0.4
                    let c = CGPoint(x: center.x + base * (pool.dx + 0.12 * cos(phase)), y: center.y + base * (pool.dy + 0.12 * sin(phase * 1.3)))
                    let r = base * pool.size * (1 + energy * 0.35 + breathing + 0.06 * sin(phase * 0.7))
                    canvas.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)),
                                with: .radialGradient(Gradient(colors: [color.opacity((pool.strength + energy * 0.2) * (1 - v.dim)), color.opacity(0)]),
                                                      center: c, startRadius: 0, endRadius: r))
                }
                for k in 0..<3 {
                    let radius = base * (1 - Double(k) * 0.1) * (1 + energy * 0.2 + breathing)
                    // Layers drift against each other, more while Umpi thinks, so the orb flows rather than spins.
                    let turn = (t * 0.12 + v.flowPhase * 0.5) * (k % 2 == 0 ? 1 : -1) + Double(k) * 1.9
                    let path = Self.blob(center: center, radius: radius, time: t * 0.9 + v.flowPhase + Double(k) * 1.9, wobble: v.wobble + energy * 0.09, lobes: 3 + k, turn: turn)
                    // The light inside wanders slowly while thinking.
                    let light = CGPoint(x: center.x - radius * 0.25 + cos(t * 0.7 + Double(k)) * radius * 0.3 * min(1, v.flow),
                                        y: center.y - radius * 0.3 + sin(t * 0.9 + Double(k)) * radius * 0.3 * min(1, v.flow))
                    canvas.fill(path, with: .radialGradient(Gradient(colors: [color.opacity((0.95 - Double(k) * 0.22) * (1 - v.dim)), color.opacity(0.35 * (1 - v.dim))]),
                                                           center: light, startRadius: 0, endRadius: radius * 1.3))
                }
            }
        }
        // Drawn on the GPU in one pass.
        .drawingGroup()
    }

    /// A closed, softly wobbling shape around `center`.
    static func blob(center: CGPoint, radius: Double, time: Double, wobble: Double, lobes: Int, turn: Double = 0) -> Path {
        var path = Path()
        let steps = 72
        for i in 0...steps {
            let theta = Double(i) / Double(steps) * 2 * .pi
            let r = radius * (1 + wobble * (0.6 * sin(Double(lobes) * theta + time) + 0.4 * sin(Double(lobes + 2) * theta - time * 1.3)))
            let point = CGPoint(x: center.x + cos(theta + turn) * r, y: center.y + sin(theta + turn) * r)
            if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        path.closeSubpath()
        return path
    }
}

/// The orb's look, eased toward each state's values so a change of state flows instead of jumping.
final class OrbMotion {
    struct Values { var wobble: Double; var reactive: Double; var flow: Double; var dim: Double; var gray: Double; var red: Double; var flowPhase: Double = 0; var level: Double = 0 }
    private var current = Values(wobble: 0.02, reactive: 0, flow: 0, dim: 0.35, gray: 1, red: 0)
    private var last: Double?

    func step(toward target: Values, at time: Double, level: Double = 0) -> Values {
        let dt = min(0.1, max(0, time - (last ?? time)))
        last = time
        let k = min(1, dt * 3)   // about a third of a second to settle
        func ease(_ a: Double, _ b: Double) -> Double { a + (b - a) * k }
        current.wobble = ease(current.wobble, target.wobble)
        current.reactive = ease(current.reactive, target.reactive)
        current.flow = ease(current.flow, target.flow)
        current.dim = ease(current.dim, target.dim)
        current.gray = ease(current.gray, target.gray)
        current.red = ease(current.red, target.red)
        // The voice level, smoothed per frame: quick to rise, gentler to fall, so the orb moves without jitter.
        current.level += (level - current.level) * min(1, dt * (level > current.level ? 18 : 8))
        // Phase accumulates at the current flow, so speeding up never makes the shape jump.
        current.flowPhase += dt * current.flow * 0.9
        return current
    }
}
