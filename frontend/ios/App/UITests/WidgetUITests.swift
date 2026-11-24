import XCTest

/// Posted by the debug build each time the app writes the widgets' snapshot (WidgetsPlugin.swift).
private let snapshotWritten = "io.github.bschrift.multiscale.widget-snapshot"
/// Posted by the debug build, with the KPI's name after it, when the page measures one, such as nav.today once drawn.
private let measured = "io.github.bschrift.multiscale.measured."

/// The iPhone widgets as far as XCUITest can reach them. It can't add a widget to the Home Screen or tap one there: the
/// Simulator's Home Screen editing isn't scriptable, and WidgetKit draws widgets in SpringBoard, outside any app's tree.
/// So these drive everything either side of the widget: the snapshot the app writes for it, the links it opens, and the
/// queue its buttons add to, through the same code a button's App Intent runs (WidgetTap, from the test page). How each
/// widget draws is the render tests' (frontend/ios/App/MultiscaleWidgets), and the timeline's the Swift package's.
final class WidgetUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    /// The test page, on the same clock as a seeded app, which runs from 10am: it reads the App Group and taps as a widget.
    private func checksPage(shifted: Bool = true) -> XCUIApplication {
        let checks = XCUIApplication()
        checks.launchEnvironment = ["MULTISCALE_START_PAGE": "native-checks/index.html"]
        if shifted { checks.launchEnvironment["MULTISCALE_CLOCK_SHIFT_MS"] = String(Int(morningShift(now: Date()) * 1000)) }
        checks.launchLoaded()
        exists(checks.webText("ready"), timeout: launchPatience)
        return checks
    }

    /// Taps a button on the test page and returns the line it logs that starts with `prefix`. A tap the page didn't hear,
    /// as CI's Simulator now and then loses one, is tapped again; one it heard never is, since a widget tap changes the
    /// queue.
    @discardableResult
    private func run(_ button: String, on checks: XCUIApplication, expect prefix: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        let results = checks.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix))
        let heard = checks.page.staticTexts.matching(identifier: "tapped:\(button)")
        let (resultsBefore, heardBefore) = (results.count, heard.count)
        checks.webButton(button).tap()
        if !heard.element(boundBy: heardBefore).waitForExistence(timeout: 5) { checks.webButton(button).tap() }
        let result = results.element(boundBy: resultsBefore)
        exists(result, in: checks, file: file, line: line)
        return result.label
    }

    private func waitFor(_ notification: String, file: StaticString = #filePath, line: UInt = #line) -> () -> Void {
        let expectation = XCTDarwinNotificationExpectation(notificationName: notification)
        return {
            XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: patience), .completed, "\(notification) never came", file: file, line: line)
        }
    }

    /// Without the extensions there's no App Group, so no widgets and nothing written for them: a free personal team's
    /// build. With them, the app writes the snapshot as it opens and again after a change, here an item captured.
    func testTheAppWritesTheWidgetSnapshotAfterAPlanChange() {
        guard extensionsEnabled else {
            let checks = checksPage(shifted: false)
            XCTAssertEqual(run("Widgets", on: checks, expect: "widgets:"), "widgets:off")
            return
        }
        let opened = waitFor(snapshotWritten)
        let app = launchApp(seed: "Seed later")
        opened()
        let changed = waitFor(snapshotWritten)
        let field = app.page.textFields["Capture to Inbox"]
        app.tapWeb("Capture a task", until: field)
        app.type("Buy a proofing basket\n", into: field)
        XCTAssertTrue(field.waitForNonExistence(timeout: patience), "Capture is still open")
        changed()
        app.terminate()
        let checks = checksPage()
        XCTAssertEqual(run("Widgets", on: checks, expect: "widgets:"), "widgets:on")
        XCTAssertEqual(run("Widget snapshot", on: checks, expect: "snapshot:"), "snapshot:blocks=1 started= inbox=1")
    }

    /// Each link a widget opens shows its screen, opened from outside the app as a widget's tap opens it. The debug build
    /// says which screen the app shows each time it changes (BridgeViewController.swift); a tab's drawn KPI won't do,
    /// since it starts only from a tap on the tab.
    func testEachWidgetLinkOpensItsScreen() {
        let app = launchApp(seed: "Seed plan")
        for (link, screen) in [("week", "week"), ("inbox", "inbox"), ("today", "today"), ("plan", "planning"), ("capture", "capture")] {
            let name = measured + "screen." + screen
            Heard.listen(name)
            let before = Heard.count(name)
            openLink("multiscale://\(link)") { Heard.count(name) > before }
            XCTAssertGreaterThan(Heard.count(name), before, "multiscale://\(link) never showed \(screen). On screen:\n\(app.debugDescription)")
        }
        // Capture's link, the one the Capture widget and the control share, opens Capture ready to type.
        exists(app.page.textFields["Capture to Inbox"])
    }

    /// A widget's Start early, queued while the app was closed, applies when it opens, timed at the tap, with a toast
    /// that stays until read and whose Undo takes it back. The widget's own Undo goes through the queue the same way.
    func testQueuedWidgetActionsApplyOnOpeningWithAnUndoToast() {
        guard extensionsEnabled else {
            // No App Group, so nothing for a widget to queue into.
            let checks = checksPage(shifted: false)
            XCTAssertEqual(run("Widget tap", on: checks, expect: "Widget tap failed"), "Widget tap failed: Error: No App Group")
            return
        }
        // A block at 10:30, with nothing before it: the medium widget offers Start early.
        let opened = waitFor(snapshotWritten)
        let app = launchApp(seed: "Seed later")
        opened()
        app.terminate()

        var checks = checksPage()
        XCTAssertEqual(run("Widget tap", on: checks, expect: "widget-tap:"), "widget-tap:Start early:free")
        checks.terminate()

        app.launchLoaded()
        let toast = app.webText("Started Shape the loaf early, at 10am, from the widget.")
        exists(toast)
        let written = waitFor(snapshotWritten)
        app.tapWeb("Undo")
        XCTAssertTrue(toast.waitForNonExistence(timeout: patience), "the toast stayed after Undo")
        written()
        app.terminate()

        checks = checksPage()
        XCTAssertEqual(run("Widget snapshot", on: checks, expect: "snapshot:"), "snapshot:blocks=1 started= inbox=0")
        // Start early again, then the widget's own Undo, before the app opens: the start comes off the queue unapplied.
        XCTAssertEqual(run("Widget tap", on: checks, expect: "widget-tap:"), "widget-tap:Start early:free")
        XCTAssertEqual(run("Widget tap", on: checks, expect: "widget-tap:"), "widget-tap:Undo:now")
        XCTAssertEqual(run("Widget tap", on: checks, expect: "widget-tap:"), "widget-tap:Start early:free")
    }

    /// iOS's background refresh reaches the page, which syncs and writes, and iOS hears when it's done.
    func testABackgroundRefreshReachesThePageAndFinishes() {
        let checks = checksPage(shifted: false)
        guard extensionsEnabled else {
            XCTAssertEqual(run("Widgets", on: checks, expect: "widgets:"), "widgets:off")
            return
        }
        XCTAssertEqual(run("Widget refresh", on: checks, expect: "refresh:completed"), "refresh:completed:true")
        exists(checks.webText("refresh:heard"))
    }
}

/// Darwin notifications heard so far, by name, for a wait that needs to ask "has it come yet?" rather than block on it.
private enum Heard {
    private static var counts: [String: Int] = [:]
    private static var listening = Set<String>()

    static func listen(_ name: String) {
        guard listening.insert(name).inserted else { return }
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, name, _, _ in
            guard let name = name?.rawValue as String? else { return }
            Heard.counts[name, default: 0] += 1
        }, name as CFString, nil, .deliverImmediately)
    }

    static func count(_ name: String) -> Int { counts[name] ?? 0 }
}
