import SwiftUI

/// Voice mode: a hands-free spoken conversation with Umpi. The orb shows whose turn it is; captions show the owner's
/// words as they are heard and Umpi's sentence as it is spoken.
struct VoiceModeView: View {
    @Environment(CompanionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var conversation = VoiceConversation()
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button { showSettings = true } label: { Image(systemName: "slider.horizontal.3").font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44) }
                    .accessibilityLabel("Voice settings")
            }
            .tint(.primary)
            .padding(.horizontal, 8)

            Spacer(minLength: 12)
            VoiceOrb(phase: conversation.phase, level: conversation.level)
                .frame(width: 340, height: 340)
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
                .padding(.top, 4)
            Text(conversation.caption)
                .font(.title3)
                .multilineTextAlignment(.center)
                .foregroundStyle(conversation.captionIsOwner ? .secondary : .primary)
                .lineLimit(5)
                .frame(maxWidth: .infinity, minHeight: 130, alignment: .top)
                .padding(.horizontal, 28)
                .padding(.top, 14)
                .animation(.easeOut(duration: 0.2), value: conversation.caption)
            Spacer(minLength: 12)

            HStack(spacing: 28) {
                control(conversation.muted ? "mic.slash.fill" : "mic.fill", label: conversation.muted ? "Unmute" : "Mute", active: conversation.muted) { conversation.muted.toggle() }
                control(conversation.phase == .paused ? "play.fill" : "pause.fill", label: conversation.phase == .paused ? "Resume" : "Pause", active: conversation.phase == .paused) { conversation.togglePause() }
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 22, weight: .semibold)).foregroundStyle(.white)
                        .frame(width: 64, height: 64).background(Circle().fill(Color.red))
                }
                .accessibilityLabel("End")
            }
            .padding(.bottom, 24)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .task { await conversation.start(store) }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { conversation.stop(); UIApplication.shared.isIdleTimerDisabled = false }
        // Voice mode only listens while it is on screen.
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { conversation.stop() }
            else if phase == .active { conversation.returnedToApp(); Task { await conversation.start(store) } }
        }
        .sheet(isPresented: $showSettings, onDismiss: { conversation.applySettings() }) {
            NavigationStack { VoiceSettingsView() }
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
        .accessibilityLabel(label)
    }
}

/// The orb: breathes while listening, follows the owner's voice while they talk, turns slowly while Umpi thinks,
/// circles while a tool runs, and moves with Umpi's voice while it speaks. Colour only marks the state.
struct VoiceOrb: View {
    var phase: VoiceConversation.Phase
    var level: Float

    private struct Look { var color: Color; var wobble: Double; var speed: Double; var reactive: Double }
    private var look: Look {
        switch phase {
        case .starting, .paused: return Look(color: .gray, wobble: 0.02, speed: 0.3, reactive: 0)
        case .listening: return Look(color: .accentColor, wobble: 0.035, speed: 0.6, reactive: 0.6)
        case .hearing: return Look(color: .accentColor, wobble: 0.05, speed: 1.1, reactive: 1.2)
        case .thinking: return Look(color: Color(white: 0.6), wobble: 0.05, speed: 1.6, reactive: 0)
        case .working: return Look(color: .orange, wobble: 0.05, speed: 1.4, reactive: 0)
        case .speaking: return Look(color: .accentColor, wobble: 0.06, speed: 1.3, reactive: 1.0)
        case .failed: return Look(color: .red, wobble: 0.02, speed: 0.3, reactive: 0)
        }
    }

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let look = self.look
            let energy = min(1, Double(level) * look.reactive)
            Canvas { canvas, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                // Room for the glow inside the canvas, so its blur is not cut off square.
                let base = min(size.width, size.height) * 0.25
                let breathing = 0.025 * sin(t * 1.4)
                // A soft glow that grows with the voice.
                canvas.drawLayer { layer in
                    layer.addFilter(.blur(radius: base * 0.4))
                    let r = base * (1.0 + energy * 0.35 + breathing)
                    layer.fill(Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)), with: .color(look.color.opacity(0.28 + energy * 0.3)))
                }
                for k in 0..<3 {
                    let radius = base * (1 - Double(k) * 0.1) * (1 + energy * 0.2 + breathing)
                    let path = Self.blob(center: center, radius: radius, time: t * look.speed + Double(k) * 1.9, wobble: look.wobble + energy * 0.09, lobes: 3 + k)
                    canvas.fill(path, with: .radialGradient(Gradient(colors: [look.color.opacity(0.95 - Double(k) * 0.22), look.color.opacity(0.35)]),
                                                           center: CGPoint(x: center.x - radius * 0.25, y: center.y - radius * 0.3), startRadius: 0, endRadius: radius * 1.3))
                }
                switch phase {
                case .thinking:
                    // A light that sweeps around: the wait reads as work.
                    let angle = Angle(radians: t * 2.2)
                    var arc = Path()
                    arc.addArc(center: center, radius: base * 1.12, startAngle: angle, endAngle: angle + .degrees(110), clockwise: false)
                    canvas.stroke(arc, with: .color(.primary.opacity(0.35)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                case .working:
                    for i in 0..<3 {
                        let a = t * 1.8 + Double(i) * 2 * .pi / 3
                        let p = CGPoint(x: center.x + cos(a) * base * 1.2, y: center.y + sin(a) * base * 1.2)
                        canvas.fill(Path(ellipseIn: CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8)), with: .color(look.color.opacity(0.9)))
                    }
                default: break
                }
            }
        }
        .animation(.easeInOut(duration: 0.4), value: phase)
    }

    /// A closed, softly wobbling shape around `center`.
    static func blob(center: CGPoint, radius: Double, time: Double, wobble: Double, lobes: Int) -> Path {
        var path = Path()
        let steps = 96
        for i in 0...steps {
            let theta = Double(i) / Double(steps) * 2 * .pi
            let r = radius * (1 + wobble * (0.6 * sin(Double(lobes) * theta + time) + 0.4 * sin(Double(lobes + 2) * theta - time * 1.3)))
            let point = CGPoint(x: center.x + cos(theta) * r, y: center.y + sin(theta) * r)
            if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        path.closeSubpath()
        return path
    }
}
