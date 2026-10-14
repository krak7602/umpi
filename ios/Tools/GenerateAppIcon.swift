import AppKit
import CoreText
import ImageIO
import UniformTypeIdentifiers

// Run from the repository root:
// swift ios/Tools/GenerateAppIcon.swift ios/Umpi/Assets.xcassets/AppIcon.appiconset
// Keep the artwork opaque and square; iOS supplies the icon mask.
let output = CommandLine.arguments.dropFirst().first.map { URL(fileURLWithPath: $0, isDirectory: true) }
guard let output else {
    fatalError("Pass the AppIcon.appiconset directory as the only argument.")
}
let size = 1024
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let appearances: [(String, [CGFloat], [CGFloat])] = [
    ("AppIcon.png", [0.835, 0.765, 0.98, 1], [0.145, 0.094, 0.224, 1]),
    ("AppIcon-dark.png", [0.145, 0.094, 0.224, 1], [0.835, 0.765, 0.98, 1]),
    ("AppIcon-tinted.png", [0, 0, 0, 1], [1, 1, 1, 1])
]
for (filename, background, foreground) in appearances {
    let context = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    )!
    context.setFillColor(CGColor(colorSpace: colorSpace, components: background)!)
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))

    let font = NSFont.systemFont(ofSize: 280, weight: .medium)
    let wordmark = NSAttributedString(string: "Umpi", attributes: [
        .font: font,
        .foregroundColor: NSColor(cgColor: CGColor(colorSpace: colorSpace, components: foreground)!)!,
        .kern: -9
    ])
    let line = CTLineCreateWithAttributedString(wordmark)
    let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
    let horizontalInset: CGFloat = 108
    let scale = (CGFloat(size) - 2 * horizontalInset) / bounds.width
    context.translateBy(x: CGFloat(size) / 2, y: CGFloat(size) / 2)
    context.scaleBy(x: scale, y: scale)
    context.textPosition = CGPoint(x: -bounds.midX, y: -bounds.midY)
    CTLineDraw(line, context)

    let image = context.makeImage()!
    let destination = CGImageDestinationCreateWithURL(
        output.appendingPathComponent(filename) as CFURL,
        UTType.png.identifier as CFString, 1, nil
    )!
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Could not write the app icon.") }
}
print("Generated opaque 1024×1024 default, dark, and tinted Umpi wordmarks.")
