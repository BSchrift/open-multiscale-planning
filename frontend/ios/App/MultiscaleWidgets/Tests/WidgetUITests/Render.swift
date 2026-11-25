import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import WidgetCore
import WidgetKit
import WidgetTestSupport
@testable import WidgetUI
import XCTest

@available(iOS 17.0, macOS 14.0, *)
/// Draws widgets as iOS would, outside WidgetKit, and checks each one: it fits its size, so nothing is pushed out of
/// the frame, and it isn't empty. With WIDGET_RENDERS_DIR set (CI's widgets job sets it), each is saved there as a PNG
/// for review. Run on the iPhone Simulator for real text sizes; on a Mac, custom fonts don't grow with Dynamic Type, so
/// the largest-size checks there say less.
@MainActor
enum Render {
    struct Result {
        let image: CGImage
        /// What the content asked for, inside the widget's margins.
        let needed: CGSize
        let room: CGSize
    }

    /// The text sizes widgets get: the default, and the largest.
    static let textSizes: [(name: String, size: DynamicTypeSize)] = [("default", .large), ("largest", .accessibility5)]

    static func draw<V: View>(_ view: V, size: CGSize, look: WidgetLook, text: DynamicTypeSize, redacted: Bool = false) -> Result {
        let box = Measured()
        let room = CGSize(width: size.width - 32, height: size.height - 32)
        let framed = WidgetFrame(look: look, size: size) {
            Probe(box: box) { view }.redacted(reason: redacted ? .privacy : [])
        }
        .drawnStill()
        .environment(\.dynamicTypeSize, text)
        .environment(\.colorScheme, look == .light ? .light : .dark)
        .environment(\.widgetRenderingMode, look == .tinted ? .accented : .fullColor)
        let renderer = ImageRenderer(content: framed)
        renderer.scale = 3
        guard let image = renderer.cgImage else { fatalError("Nothing rendered") }
        return Result(image: image, needed: box.size, room: room)
    }

    /// Fits with half a point to spare for rounding.
    static func fits(_ r: Result) -> Bool { r.needed.width <= r.room.width + 0.5 && r.needed.height <= r.room.height + 0.5 }

    /// The share of pixels that differ from the card: anything drawn at all.
    static func inked(_ image: CGImage, look: WidgetLook) -> Double {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        // The centre pixel of the top-left margin is the card.
        let at = (16 * 3 / 2) * width * 4 + (40 * 3) * 4
        let card = (Int(pixels[at]), Int(pixels[at + 1]), Int(pixels[at + 2]))
        var differ = 0, total = 0
        for i in stride(from: 0, to: pixels.count, by: 4 * 3) where pixels[i + 3] > 200 {
            total += 1
            if abs(Int(pixels[i]) - card.0) + abs(Int(pixels[i + 1]) - card.1) + abs(Int(pixels[i + 2]) - card.2) > 60 { differ += 1 }
        }
        return total > 0 ? Double(differ) / Double(total) : 0
    }

    /// Saves a PNG for review, named widget-<parts>.png, when WIDGET_RENDERS_DIR says where.
    static func save(_ image: CGImage, _ parts: [String]) {
        guard let dir = ProcessInfo.processInfo.environment["WIDGET_RENDERS_DIR"], !dir.isEmpty else { return }
        let folder = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent((["widget"] + parts).joined(separator: "-") + ".png")
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(destination, image, nil)
        CGImageDestinationFinalize(destination)
    }

    /// Draws, checks and saves one widget, failing the test with where it went wrong.
    static func check<V: View>(_ view: V, size: CGSize, look: WidgetLook, text: (name: String, size: DynamicTypeSize), name: [String],
                               redacted: Bool = false, file: StaticString = #filePath, line: UInt = #line) {
        let result = draw(view, size: size, look: look, text: text.size, redacted: redacted)
        let label = (name + [look.rawValue, text.name]).joined(separator: " ")
        XCTAssertTrue(fits(result), "\(label) needs \(result.needed) in \(result.room)", file: file, line: line)
        XCTAssertGreaterThan(inked(result.image, look: look), 0.01, "\(label) is empty", file: file, line: line)
        save(result.image, name + [look.rawValue, text.name])
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// Where the probe writes what its content asked for.
final class Measured {
    var size: CGSize = .zero
}

@available(iOS 17.0, macOS 14.0, *)
/// Proposes its room to the content, as WidgetKit does, and notes what the content took. A layout that runs out of room
/// takes more than it was offered, pushing past the widget's margins, which is what a fit test is for.
struct Probe: Layout {
    let box: Measured

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        box.size = subviews.first?.sizeThatFits(proposal) ?? .zero
        return proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: proposal)
    }
}
