// swift-tools-version:5.9
// The iPhone widgets' code that runs outside Xcode's targets, so `swift test` checks it on a Mac with no Simulator:
//   WidgetCore         the snapshot the app writes, what a widget shows at any moment, the timeline, the action queue
//                      and the overlay of queued taps. Foundation only, so the app target links it too.
//   WidgetTestSupport  the contract fixtures the app's tests write (frontend/src/core/widgetFixtures.test.ts), and
//                      helpers to read them. Only the tests link it.
import PackageDescription

let package = Package(
    name: "MultiscaleWidgets",
    platforms: [.iOS(.v15), .macOS(.v14)],
    products: [
        .library(name: "WidgetCore", targets: ["WidgetCore"]),
    ],
    targets: [
        .target(name: "WidgetCore"),
        .target(name: "WidgetTestSupport", dependencies: ["WidgetCore"], resources: [.copy("Fixtures")]),
        .testTarget(name: "WidgetCoreTests", dependencies: ["WidgetCore", "WidgetTestSupport"]),
    ]
)
