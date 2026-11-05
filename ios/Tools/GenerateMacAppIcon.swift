import AppKit
import SwiftUI

// Run from the repository root, after GenerateAppIcon.swift:
// swift ios/Tools/GenerateMacAppIcon.swift ios/Umpi/Assets.xcassets/AppIcon.appiconset/AppIcon.png ios/UmpiMac/Assets.xcassets/AppIcon.appiconset
// macOS does not mask app icons: the artwork is placed in Apple's macOS icon grid, an 824-point continuous rounded
// square (corner radius 185.4) centred on the 1024-point canvas, over a soft shadow, and written at every Mac size.
let arguments = CommandLine.arguments.dropFirst()
guard arguments.count == 2, let artworkPath = arguments.first, let outputPath = arguments.last,
      let artwork = NSImage(contentsOfFile: artworkPath)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fatalError("Pass the square artwork PNG and the Mac AppIcon.appiconset directory.")
}
let output = URL(fileURLWithPath: outputPath, isDirectory: true)
let canvas: CGFloat = 1024
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = RoundedRectangle(cornerRadius: 185.4, style: .continuous).path(in: tile).cgPath
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

for pixels in [16, 32, 64, 128, 256, 512, 1024] {
    let context = CGContext(
        data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
        space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.interpolationQuality = .high
    let scale = CGFloat(pixels) / canvas
    context.scaleBy(x: scale, y: scale)
    // The shadow falls below the tile (CoreGraphics' y axis points up); shadows are in device pixels, so they scale.
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -10 * scale), blur: 24 * scale, color: CGColor(gray: 0, alpha: 0.32))
    context.addPath(shape)
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fillPath()
    context.restoreGState()
    // The artwork, clipped to the tile, with a hairline edge that keeps a light tile defined on a light background.
    context.addPath(shape)
    context.clip()
    context.draw(artwork, in: tile)
    context.addPath(shape)
    context.setStrokeColor(CGColor(gray: 0, alpha: 0.10))
    context.setLineWidth(2)
    context.strokePath()
    let png = NSBitmapImageRep(cgImage: context.makeImage()!).representation(using: .png, properties: [:])!
    try png.write(to: output.appendingPathComponent("icon_\(pixels).png"))
}
