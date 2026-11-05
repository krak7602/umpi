import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// The few places where the phone and the Mac need different system types. Each helper does on iOS exactly what the
// code did before it was shared with the Mac app.

#if canImport(UIKit)
typealias PlatformImage = UIImage
#else
typealias PlatformImage = NSImage
#endif

extension PlatformImage {
    /// The image drawn at `size` points, one pixel per point.
    func resized(to size: CGSize) -> PlatformImage {
        #if canImport(UIKit)
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in draw(in: CGRect(origin: .zero, size: size)) }
        #else
        let width = max(1, Int(size.width)), height = max(1, Int(size.height))
        guard let source = cgImage(forProposedRect: nil, context: nil, hints: nil),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return self }
        context.interpolationQuality = .high
        context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else { return self }
        return NSImage(cgImage: scaled, size: NSSize(width: width, height: height))
        #endif
    }

    #if !canImport(UIKit)
    convenience init(cgImage: CGImage) { self.init(cgImage: cgImage, size: .zero) }

    /// JPEG data, as UIImage gives it.
    func jpegData(compressionQuality: CGFloat) -> Data? {
        guard let source = cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        return NSBitmapImageRep(cgImage: source).representation(using: .jpeg, properties: [.compressionFactor: compressionQuality])
    }
    #endif
}

extension Image {
    init(platformImage: PlatformImage) {
        #if canImport(UIKit)
        self.init(uiImage: platformImage)
        #else
        self.init(nsImage: platformImage)
        #endif
    }
}

/// The general pasteboard.
@MainActor enum Clipboard {
    static var string: String? {
        #if canImport(UIKit)
        UIPasteboard.general.string
        #else
        NSPasteboard.general.string(forType: .string)
        #endif
    }

    static func copy(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

/// Opens a link outside the app, in the default browser.
@MainActor func openOutside(_ url: URL) async {
    #if canImport(UIKit)
    await UIApplication.shared.open(url)
    #else
    NSWorkspace.shared.open(url)
    #endif
}

/// What the app calls the device it runs on, in text the owner reads.
enum ThisDevice {
    #if os(macOS)
    static let noun = "Mac"
    #else
    static let noun = "phone"
    #endif
}

extension View {
    /// Mac buttons are bordered push buttons unless told otherwise; a button drawn as its own shape uses none there.
    /// On the phone this changes nothing.
    @ViewBuilder func shapedButton() -> some View {
        #if os(macOS)
        self.buttonStyle(.plain)
        #else
        self
        #endif
    }
}

extension View {
    /// A Mac button drawn as a symbol or a quiet link, without the push-button bezel. On the phone this changes
    /// nothing.
    @ViewBuilder func borderlessOnMac() -> some View {
        #if os(macOS)
        self.buttonStyle(.borderless)
        #else
        self
        #endif
    }

    /// In a wide Mac window, a list, form, or scroll view keeps its rows at a readable width, centred, with the scroll
    /// bar still at the window's edge. On the phone this changes nothing.
    @ViewBuilder func readableWidth(_ width: CGFloat = 720) -> some View {
        #if os(macOS)
        self.modifier(ReadableWidth(width: width))
        #else
        self
        #endif
    }
}

#if os(macOS)
private struct ReadableWidth: ViewModifier {
    let width: CGFloat
    @State private var available: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .contentMargins(.horizontal, max(0, ((available - width) / 2).rounded(.down)), for: .scrollContent)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { available = $0 }
    }
}
#endif

/// Sections of rows: the phone's list, and on the Mac a grouped form, as Mac settings and inspectors show them.
struct PlatformList<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        #if os(macOS)
        Form { content() }.formStyle(.grouped)
        #else
        List { content() }
        #endif
    }
}
