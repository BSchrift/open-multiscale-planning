import CryptoKit
import XCTest

/// CI's Simulator now and then holds every process it starts for up to 40 s: its logs show each one waiting between
/// xpcproxy_sim and exec, then all starting together. Anything that needs a process started meanwhile, such as the
/// keychain or a web view's network process, waits that out, so a wait allows longer than the longest hold seen.
private let patience: TimeInterval = 60
/// For the first page after a launch, when the web view starts WebKit's processes, which that hold can delay on top of
/// the page's own second or two.
private let launchPatience: TimeInterval = 60

/// Set by scripts/test-ios.sh for its second run, which builds with the extensions on.
private let extensionsEnabled = ProcessInfo.processInfo.environment["MULTISCALE_EXTENSIONS"] == "YES"
private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

private extension XCUIApplication {
    var page: XCUIElement { webViews.firstMatch }
    func webButton(_ label: String) -> XCUIElement { page.buttons[label] }
    func webText(_ text: String) -> XCUIElement { page.staticTexts[text] }
    /// Any kind of element, for controls whose type differs between iOS versions, such as a checkbox or a select.
    func webElement(_ label: String) -> XCUIElement { page.descendants(matching: .any)[label] }
    /// For labels that go on with a count or a time.
    func webButton(startingWith prefix: String) -> XCUIElement {
        page.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }
    func tapWeb(_ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let button = webButton(label)
        MultiscaleUITests.exists(button, file: file, line: line)
        button.tap()
    }
    func tapWeb(startingWith prefix: String, file: StaticString = #filePath, line: UInt = #line) {
        let button = webButton(startingWith: prefix)
        MultiscaleUITests.exists(button, file: file, line: line)
        button.tap()
    }
    /// Any kind of element by the start of its label, for one WebKit doesn't call a button: a row of a list, or a button
    /// that opens a dialog, such as Process's Add to.
    func tapWeb(anyStartingWith prefix: String, file: StaticString = #filePath, line: UInt = #line) {
        let row = page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
        MultiscaleUITests.exists(row, file: file, line: line)
        row.tap()
    }
    /// Taps, then waits for what the tap brings. On CI's iOS 26 Simulator a tap on the page is now and then lost, most
    /// often the first after a launch, so a button still there a few seconds on is tapped again, as a person would.
    func tapWeb(_ label: String, until effect: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        tapWeb(label, file: file, line: line)
        let button = webButton(label)
        if !effect.waitForExistence(timeout: 5), button.exists, button.isHittable { button.tap() }
        MultiscaleUITests.exists(effect, file: file, line: line)
    }
}

private func exists(_ element: XCUIElement, timeout: TimeInterval = patience, in owner: XCUIApplication = XCUIApplication(), file: StaticString = #filePath, line: UInt = #line) {
    if element.waitForExistence(timeout: timeout) { return }
    // The tree shows what was on screen instead, since labels change between iOS versions.
    XCTFail("\(element) did not appear. On screen:\n\(owner.debugDescription)", file: file, line: line)
}

/// The app with its data as a new install has it, then seeded from the test page when a seed is given. `reach` is how
/// far back the seed's earliest block starts, as capacitor-checks.ts times it.
private func launchApp(seed: String? = nil, reach: TimeInterval = 0) -> XCUIApplication {
    let checks = XCUIApplication()
    checks.launchEnvironment["MULTISCALE_START_PAGE"] = "native-checks/index.html"
    checks.launch()
    exists(checks.webText("ready"), timeout: launchPatience)
    checks.tapWeb("Erase", until: checks.webText("erased"))
    if let seed {
        let at = seedTime(now: Date(), reach: reach)
        if at > Date() {
            print("Waiting until \(at) so \(seed) fits in one day")
            Thread.sleep(until: at)
        }
        checks.tapWeb(seed)
        exists(checks.webText("seeded"))
    }
    checks.terminate()
    let app = XCUIApplication()
    app.launch()
    return app
}

/// When a seed can run. The Simulator's clock can't be moved, and Today shows and says "today" only for blocks that
/// start today, so a seed whose blocks start `reach` back waits until they fit after midnight, and keeps the last ten
/// minutes of the day clear for the test that follows it.
func seedTime(now: Date, reach: TimeInterval, calendar: Calendar = .current) -> Date {
    let midnight = calendar.startOfDay(for: now)
    let next = calendar.date(byAdding: .day, value: 1, to: midnight)!
    if now.addingTimeInterval(10 * 60) > next { return next.addingTimeInterval(reach + 60) }
    return max(now, midnight.addingTimeInterval(reach + 60))
}

final class SeedTimeTests: XCTestCase {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()
    private func at(_ time: String) -> Date { ISO8601DateFormatter().date(from: time + ":00Z")! }

    func testASeedWaitsUntilItsBlocksStartTodayAndTheTestEndsBeforeMidnight() {
        XCTAssertEqual(seedTime(now: at("2026-11-02T12:00"), reach: 90 * 60, calendar: calendar), at("2026-11-02T12:00"))
        XCTAssertEqual(seedTime(now: at("2026-11-02T01:00"), reach: 20 * 60, calendar: calendar), at("2026-11-02T01:00"))
        XCTAssertEqual(seedTime(now: at("2026-11-02T00:10"), reach: 90 * 60, calendar: calendar), at("2026-11-02T01:31"))
        XCTAssertEqual(seedTime(now: at("2026-11-02T23:55"), reach: 20 * 60, calendar: calendar), at("2026-11-03T00:21"))
        XCTAssertEqual(seedTime(now: at("2026-11-02T23:55"), reach: 0, calendar: calendar), at("2026-11-03T00:01"))
    }
}

/**
 * Waits for something on Today. On iOS 26.2, under Xcode 16.4 and 26.3 alike, when XCUITest first reads Today before
 * its content has arrived, the tree keeps that part of Today as it was, while the screen shows the rest: CI's screen
 * recordings show Today drawn, its countdown ticking, as the tree reports Today's region empty for a minute. Waiting
 * longer, tapping, swiping, rotating, backgrounding the app and the app posting layout or screen changes didn't bring
 * the content in reliably. Hiding Today and showing it again did, every time: so the test goes to Week and back.
 */
private func onToday(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    if element.waitForExistence(timeout: 10) { return }
    app.tapWeb("Week", until: app.webButton("Previous week"), file: file, line: line)
    app.tapWeb("Today", file: file, line: line)
    exists(element, file: file, line: line)
}

/// The app asks once there's a block to remind about. Whichever test gets there first answers.
private func allowNotificationsIfAsked() {
    let allow = springboard.alerts.buttons["Allow"]
    if allow.waitForExistence(timeout: 5) { allow.tap() }
}

/// iOS asks before another app's link opens this one.
private func openLinkPrompt() {
    let open = springboard.alerts.buttons["Open"]
    if open.waitForExistence(timeout: 5) { open.tap() }
}

/// The real app, through its web view.
final class ShellUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testFirstRunSetupThenItRemembersAfterARestart() {
        let app = launchApp()
        exists(app.webText("Welcome"))
        app.tapWeb("Skip", until: app.webText("Unavailable hours"))
        app.tapWeb("Next")
        let first = app.page.textFields["A goal or a thought"]
        exists(first)
        first.tap()
        first.typeText("Learn to bake bread")
        app.tapWeb("Add goal")
        for tab in ["Today", "Week", "Goals", "More"] { exists(app.webButton(tab)) }
        exists(app.webButton("Capture a task"))

        // Setup finished in the plugin's database, so a new process goes straight to the shell, goal and all.
        app.terminate()
        app.launch()
        exists(app.webButton("Goals"), timeout: launchPatience)
        XCTAssertFalse(app.webText("Welcome").exists)
        app.tapWeb("Goals")
        exists(app.webButton(startingWith: "Learn to bake bread"))
    }

    func testCaptureFromThePlusButtonThenProcessToAProjectAndAOneOff() {
        let app = launchApp(seed: "Seed plan")
        for title in ["Buy a proofing basket", "Return the library books"] {
            let field = app.page.textFields["Capture to Inbox"]
            app.tapWeb("Capture a task", until: field)
            field.tap()
            field.typeText(title + "\n")
            XCTAssertTrue(field.waitForNonExistence(timeout: patience), "Capture is still open")
        }

        app.tapWeb(startingWith: "Inbox")
        app.tapWeb("Process 2 items")
        exists(app.webText("Buy a proofing basket"))
        // Add to opens a sheet of places, ready to search; a tap on one adds the item there.
        app.tapWeb(anyStartingWith: "Add to a project or One offs")
        app.tapWeb(anyStartingWith: "Bake a sourdough loaf")
        exists(app.webText("Added Buy a proofing basket to Bake a sourdough loaf."))

        exists(app.webText("Return the library books"))
        app.tapWeb(anyStartingWith: "Add to a project or One offs")
        app.tapWeb(anyStartingWith: "One offs")
        // Process closes itself on the last item; its check fades, then the last item's toast shows.
        exists(app.webText("Added Return the library books to One offs."))

        // Each landed where it was sent: the project's task under its Done, which opens folded behind its milestone.
        app.tapWeb("Goals")
        app.tapWeb(startingWith: "Learn to bake bread")
        app.tapWeb(startingWith: "Bake a sourdough loaf")
        app.tapWeb(anyStartingWith: "Done tasks")
        exists(app.webButton(startingWith: "Edit task Buy a proofing basket"))
        app.tapWeb("More")
        app.tapWeb(startingWith: "One offs")
        exists(app.webElement("Return the library books done"))
    }

    func testATaskOpensWithTheKeyboardDownThenItsDescriptionTakesBoldFromTheBarWithTheKeyboardUp() {
        let app = launchApp(seed: "Seed to schedule")
        app.tapWeb("Goals", until: app.webButton(startingWith: "Learn to bake bread"))
        app.tapWeb(startingWith: "Learn to bake bread")
        app.tapWeb(startingWith: "Bake a sourdough loaf")
        app.tapWeb(startingWith: "Edit task Mix the dough")
        // The popup opens on the task's name, read as its heading, so the keyboard stays down until a field is tapped.
        exists(app.webButton("Rename Mix the dough"))
        let keyboard = app.keyboards.element
        XCTAssertFalse(keyboard.waitForExistence(timeout: 2), "the keyboard came up as the popup opened")
        let field = app.page.textViews["Description"]
        exists(field)
        field.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: patience), "no software keyboard came up. On screen:\n\(app.debugDescription)")
        field.typeText("Use ")
        // The bar's buttons leave the field focused, so the keyboard stays up and typing goes on between the marks.
        app.tapWeb("Bold")
        XCTAssertTrue(keyboard.exists, "Bold put the keyboard away")
        field.typeText("rye")
        XCTAssertEqual(field.value as? String, "Use **rye**")
        app.tapWeb("Save")
        XCTAssertTrue(field.waitForNonExistence(timeout: patience), "the editor is still open")

        app.tapWeb(startingWith: "Edit task Mix the dough")
        exists(app.webButton("Edit description"))
        exists(app.webText("rye"))
        XCTAssertFalse(app.page.textViews["Description"].exists)
    }

    func testCaptureSitsAboveTheKeyboardOpenedByItsLinkWithTheAppClosedAndFromThePlusButton() {
        let app = launchApp(seed: "Seed plan")
        exists(app.webButton("Capture a task"))
        // The link the Control Center button opens, so a cold launch from either goes the same way.
        app.terminate()
        XCUIDevice.shared.system.open(URL(string: "multiscale://capture")!)
        openLinkPrompt()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: patience))
        exists(app.page.textFields["Capture to Inbox"], timeout: launchPatience)
        captureAboveTheKeyboard(app, saving: "Buy rye flour")

        app.tapWeb("Capture a task")
        captureAboveTheKeyboard(app, saving: "Clean the banneton")
    }

    /// Capture's field and Save stay on screen above the software keyboard, which covers the page rather than shrinking
    /// it, and Save then saves.
    private func captureAboveTheKeyboard(_ app: XCUIApplication, saving title: String, file: StaticString = #filePath, line: UInt = #line) {
        let field = app.page.textFields["Capture to Inbox"]
        exists(field, file: file, line: line)
        let keyboard = app.keyboards.element
        // The field asks for focus as it opens, which brings the keyboard up only where iOS allows it.
        if !keyboard.waitForExistence(timeout: 5) { field.tap() }
        XCTAssertTrue(keyboard.waitForExistence(timeout: patience), "no software keyboard came up, as when the Mac's keyboard is connected. On screen:\n\(app.debugDescription)", file: file, line: line)
        let save = app.webButton("Save")
        // shortcut: the Simulator (iOS 18.6 and 26.2) pans the page up to the focused field, so the field clears the
        // keyboard there even with the sheet left at the bottom, and this passes with the sheet fix taken out; it fails
        // as a phone did only once the suite runs on a device.
        let above = NSPredicate { _, _ in
            field.isHittable && save.isHittable && max(field.frame.maxY, save.frame.maxY) <= keyboard.frame.minY
        }
        let risen = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: above, object: nil)], timeout: patience) == .completed
        XCTAssertTrue(risen, "Capture's field at \(field.frame) and Save at \(save.frame) are not both clear above the keyboard at \(keyboard.frame)", file: file, line: line)
        field.typeText(title)
        save.tap()
        XCTAssertTrue(field.waitForNonExistence(timeout: patience), "Capture is still open", file: file, line: line)
    }

    func testAToScheduleCardHeldThenDraggedOntoTheDayIsPlacedOnToday() throws {
        // shortcut: work dropped on today lands no earlier than now and ends by 11pm, so after 10:15pm there's no room
        // for the half hour and the test skips; run it at any hour once a test can set the Simulator's clock.
        let late = Calendar.current.date(bySettingHour: 22, minute: 15, second: 0, of: Date())!
        try XCTSkipIf(Date() > late, "after 10:15pm today has no room left for the half hour")
        let app = launchApp(seed: "Seed to schedule")
        // Its own label, since the block it becomes is a button too once it's under way.
        let card = app.page.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Mix the dough, ' AND label ENDSWITH ', to schedule'")).firstMatch
        onToday(card, in: app)
        let day = app.page.otherElements.matching(NSPredicate(format: "label BEGINSWITH %@", "Today's timeline")).firstMatch
        exists(day)

        // Held past the lift, and let go once the drag has caught up. Wherever it's let go, it lands no earlier than now.
        let from = card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let to = day.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0)).withOffset(CGVector(dx: 0, dy: 140))
        from.press(forDuration: 0.8, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.5)
        // Any kind of element: a block is a slider until it's under way, which one placed at now soon is.
        exists(day.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Mix the dough, '")).firstMatch)
        XCTAssertTrue(card.waitForNonExistence(timeout: patience), "Mix the dough is still waiting in To schedule")
        allowNotificationsIfAsked()
    }

    func testTodayAsksHowAFinishedBlockWentThenWhetherTheCurrentOneHasStarted() throws {
        let app = launchApp(seed: "Seed today", reach: 90 * 60)
        allowNotificationsIfAsked()

        // The block that ended half an hour ago asks first. Partly opens the slider at the time left.
        exists(app.webText("Feed the starter"))
        let left = app.page.sliders["Time left"]
        app.tapWeb("Partly", until: left)
        XCTAssertEqual(left.value as? String, "1h")
        // XCUITest can't set a web slider's value, so the thumb is dragged: 1h is step 4 of 19, toward step 3.
        let thumb = left.coordinate(withNormalizedOffset: CGVector(dx: 4.0 / 19, dy: 0.5))
        thumb.press(forDuration: 0.2, thenDragTo: left.coordinate(withNormalizedOffset: CGVector(dx: 3.0 / 19, dy: 0.5)))
        let set = try XCTUnwrap(left.value as? String)
        XCTAssertTrue(["15m", "30m", "45m"].contains(set), "the slider reads \(set)")
        app.tapWeb("Save")

        // Then the one that began six minutes ago without a Start. Its sheet hides the toast from the tree.
        exists(app.webText("Have you started Shape the dough?"))
        app.tapWeb("Yes, started")
        exists(app.webText("In progress, time left"))

        app.tapWeb(startingWith: "1 task needs a new time")
        exists(app.webText("Partly done today, \(set) left"))
    }

    func testABlocksNotificationActionAnswersItInToday() {
        let app = launchApp(seed: "Seed soon", reach: 20 * 60)
        allowNotificationsIfAsked()
        onToday(app.webText("In progress, time left"), in: app)

        XCUIDevice.shared.press(.home)
        let banner = springboard.descendants(matching: .any)["NotificationShortLookView"]
        // The block ends two minutes after it was seeded.
        exists(banner, timeout: 180)
        banner.press(forDuration: 1.5)
        let notDone = springboard.buttons["Not done"]
        exists(notDone)
        XCTAssertTrue(springboard.buttons["Still going"].exists)
        XCTAssertTrue(springboard.buttons["Partly"].exists)
        // A task is never finished from a notification.
        XCTAssertFalse(springboard.buttons["Done"].exists)
        notDone.tap()

        app.activate()
        let answered = app.page.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Proof the loaf, ' AND label ENDSWITH '. Not done.'")).firstMatch
        onToday(answered, in: app)
    }

    /// A select opens as a menu of the app's own options, whatever element type this iOS gives its items.
    private func choose(_ option: String, in label: String, app: XCUIApplication) {
        let select = app.webElement(label)
        exists(select)
        select.tap()
        let types = [XCUIElement.ElementType.button, .menuItem, .cell].map(\.rawValue)
        let item = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType IN %@", option, types)).firstMatch
        exists(item)
        item.tap()
        // The select shows what's saved, so it goes back to the old value until the save lands, which on CI's Simulator
        // can take longer than the tap does.
        let chosen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", option), object: select)
        XCTAssertEqual(XCTWaiter.wait(for: [chosen], timeout: patience), .completed, "\(label) shows \(select.value ?? "nothing"), not \(option)")
    }
}

/// The adapter and plugins against real iOS, on a test page the script adds to this build only.
final class NativeUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["MULTISCALE_START_PAGE"] = "native-checks/index.html"
        app.launch()
        exists(app.webText("ready"), timeout: launchPatience)
    }

    /// How many lines on the page read `text`, and the one after that many.
    private func count(_ text: String) -> Int { app.webText(text).exists ? app.page.staticTexts.matching(identifier: text).count : 0 }
    private func logged(_ text: String, after count: Int) -> XCUIElement { app.page.staticTexts.matching(identifier: text).element(boundBy: count) }

    /// The page notes each tap it hears. CI's iOS 26 Simulator now and then loses a tap, most often the first after a
    /// launch, so one the page didn't hear is tapped again, while one it did is never repeated.
    private func tap(_ button: String) {
        let heard = count("tapped:\(button)")
        app.webButton(button).tap()
        if !logged("tapped:\(button)", after: heard).waitForExistence(timeout: 5) { app.webButton(button).tap() }
    }

    private func run(_ button: String, expect result: String, timeout: TimeInterval = patience, file: StaticString = #filePath, line: UInt = #line) {
        let before = count(result)
        tap(button)
        let arrived = logged(result, after: before).waitForExistence(timeout: timeout)
        let page = app.page.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: "\n")
        XCTAssertTrue(arrived, "\(result) did not appear. The page says:\n\(page)", file: file, line: line)
    }

    func testDiagnosticsMeasureMemoryAndReportARunThatWasKilled() {
        run("Diagnostics", expect: "diagnostics:ok")
        // Killed while open, as iOS does at a memory limit: the next run reports it once.
        app.terminate()
        app.launch()
        exists(app.webText("ready"), timeout: launchPatience)
        run("Diagnostics", expect: "previous:active")
    }

    func testNotificationPermissionThenCancelThenActionReachesTheApp() {
        // The script gives each run a new Simulator, and only this test asks, so the dialog shows, unless this is a retry
        // of a first attempt that already allowed it. Tapped once only: a second tap could land with the dialog up.
        app.webButton("Ask").tap()
        let allow = springboard.alerts.buttons["Allow"]
        let granted = app.webText("permission:true")
        let answered = NSPredicate { _, _ in allow.exists || granted.exists }
        _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: answered, object: nil)], timeout: patience)
        if allow.exists { allow.tap() }
        exists(granted)

        run("Remind", expect: "pending:check-block:end")
        run("Cancel", expect: "pending:0")

        run("Remind", expect: "pending:check-block:end")
        XCUIDevice.shared.press(.home)
        let banner = springboard.descendants(matching: .any)["NotificationShortLookView"]
        exists(banner)
        banner.press(forDuration: 1.5)
        let done = springboard.buttons["Done"]
        exists(done)
        XCTAssertTrue(springboard.buttons["Partly"].exists)
        done.tap()

        app.activate()
        exists(app.webText("response:check-block:end:done"))
    }

    func testTokensRoundTripThroughTheKeychain() {
        run("Keychain", expect: "keychain:ok")
    }

    func testDatabaseThroughThePlugin() {
        run("Database", expect: "database:ok")
    }

    func testQueryPlansOnThePluginsSQLite() {
        run("Plans", expect: "queryplans:ok", timeout: 300)
        let version = app.page.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'sqlite:'")).firstMatch
        print("Plugin SQLite version: \(version.label)")
        add(XCTAttachment(string: version.label))
    }

    func testSignInLinkReturnsThroughTheURLSchemeAndClosesTheBrowser() {
        let browser = app.webButton("Browser")
        // Tapped once only: the sheet hides the page from the tree, so tap(_:) couldn't see that it heard.
        browser.tap()
        // Told by our own page being covered and uncovered, since the sheet's buttons are named differently across
        // iOS versions (Done, then Close).
        XCTAssertTrue(wait(for: browser, hittable: false), "the browser sheet never came up. On screen:\n\(app.debugDescription)")
        XCUIDevice.shared.system.open(URL(string: "multiscale://auth/callback?code=abc&state=def")!)
        openLinkPrompt()
        exists(app.webText("link:multiscale://auth/callback?code=abc&state=def"))
        XCTAssertTrue(wait(for: browser, hittable: true), "the browser sheet is still in front. On screen:\n\(app.debugDescription)")
    }

    private func wait(for element: XCUIElement, hittable: Bool) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == %@", NSNumber(value: hittable)), object: element)
        return XCTWaiter.wait(for: [expectation], timeout: patience) == .completed
    }

    func testCaptureLinkIsNotTreatedAsSignIn() {
        XCUIDevice.shared.system.open(URL(string: "multiscale://capture")!)
        openLinkPrompt()
        exists(app.webText("capture"))
    }

    func testBackgroundThenForegroundIsReported() {
        XCUIDevice.shared.press(.home)
        app.activate()
        exists(app.webText("foreground"))
    }

    func testShareImportIsOffWithoutTheExtensions() throws {
        try XCTSkipIf(extensionsEnabled)
        run("Shared", expect: "shared:off")
    }

    func testShareExtensionQueuesForTheApp() throws {
        try XCTSkipUnless(extensionsEnabled, "extensions are off")
        // shortcut: iOS 26 Safari keeps Share behind its More button, which ignores XCUITest taps (plain or by
        // coordinate) on CI's iOS 26.2 Simulator, so sharing is proven on iOS 18 only; retry when Xcode's UI testing
        // can open that menu.
        if #available(iOS 26, *) { throw XCTSkip("Safari's More menu can't be opened by XCUITest on iOS 26") }
        let url = try XCTUnwrap(ProcessInfo.processInfo.environment["MULTISCALE_SHARE_URL"])
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")

        XCUIDevice.shared.system.open(URL(string: url)!)
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: patience))
        // First launch shows a welcome page.
        for label in ["Continue", "Not Now"] where safari.buttons[label].waitForExistence(timeout: 3) { safari.buttons[label].tap() }
        exists(safari.staticTexts["Share me"], in: safari)
        let share = safari.buttons["ShareButton"]
        exists(share, in: safari)
        share.tap()

        let target = safari.collectionViews.cells["Multiscale"]
        exists(target, in: safari)
        target.tap()
        // The extension saves and closes with no screen of its own.
        XCTAssertTrue(target.waitForNonExistence(timeout: patience))

        app.activate()
        exists(app.webButton("Shared"))
        run("Shared", expect: "shared:\(url)")
        run("Shared", expect: "shared:")
    }

    func testControlCenterWidgetOpensCapture() throws {
        try XCTSkipUnless(extensionsEnabled, "extensions are off")
        XCUIDevice.shared.press(.home)
        openControlCenter()
        let capture = springboard.buttons["Capture"].firstMatch
        // A retry finds the control its first attempt added.
        if !capture.waitForExistence(timeout: 3) { addCaptureControl() }
        // Opened again, as a person would use it: tapped a moment after Control Center left editing, the control now and
        // then didn't open the app.
        XCUIDevice.shared.press(.home)
        openControlCenter()
        exists(capture, in: springboard)
        // iOS gives the control's extension 15 s to start, and a control whose extension missed that does nothing when
        // tapped until iOS has started it. CI's Simulator now and then holds every process it starts for up to 40 s, so
        // there the first taps can do nothing: the logs say "begin request watchdogged after 15.000000s", and the
        // extension starts after the tap. So it's tapped until the app comes up, as a person would.
        var taps = 0
        repeat {
            capture.tap()
            taps += 1
        } while !app.wait(for: .runningForeground, timeout: 15) && taps < 4 && capture.exists && capture.isHittable
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: patience), "the control didn't open the app. On screen:\n\(springboard.debugDescription)")
        exists(app.webText("capture"))
    }

    private func openControlCenter() {
        let window = springboard.windows.firstMatch
        let from = window.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.0))
        from.press(forDuration: 0.1, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
    }

    private func addCaptureControl() {
        let window = springboard.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)).press(forDuration: 1.5)
        let add = springboard.buttons["Add a Control"]
        exists(add)
        add.tap()
        let search = springboard.searchFields.firstMatch
        exists(search)
        search.tap()
        search.typeText("Capture")
        let control = springboard.buttons["Capture"].firstMatch
        exists(control)
        control.tap()
        // Leave editing, and wait for it to end: a control tapped while editing doesn't run.
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
        XCTAssertTrue(add.waitForNonExistence(timeout: patience), "Control Center is still editing")
    }
}

/// What scripts/test-ios.sh signs in to: the local stack it started, or a deployment as its test user.
private struct Target: Decodable {
    struct User: Decodable { let username, password: String }
    let env: String
    let api_url: String
    let client_id: String
    let region: String?
    let test_user: User?

    /// Nil when the script started no backend. One it did start must parse, rather than skip the test.
    static func fromEnvironment() throws -> Target? {
        guard let json = ProcessInfo.processInfo.environment["MULTISCALE_TARGET"], !json.isEmpty else { return nil }
        return try JSONDecoder().decode(Target.self, from: Data(json.utf8))
    }
}

/// Another device of the same user, straight through the API, to see what reached the server.
private struct SecondDevice {
    let target: Target
    let token: String
    let start: Int

    /// Reads only what reaches the server from now on, as the Go suite does. A deployment's test user keeps what
    /// earlier runs wrote, and some of it, such as 0e999 from the number tests, is more than Foundation's JSON reads.
    init(_ target: Target) throws {
        self.target = target
        token = try target.test_user.map { try Self.passwordSignIn(target, $0) } ?? Self.localSignIn(target)
        // A cursor above the server's counter writes nothing and is answered with the counter.
        start = try Self.page(target, token, from: Int(Int64.max))["cursor"] as? Int ?? 0
    }

    /// The local sign-in lets anyone in with no page, as the same user the app signed in as.
    private static func localSignIn(_ target: Target) throws -> String {
        let verifier = UUID().uuidString + UUID().uuidString
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let redirect = "multiscale://auth/callback"
        var authorize = URLComponents(string: "\(target.api_url)/cognito/oauth2/authorize")!
        authorize.queryItems = [
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "client_id", value: target.client_id),
            URLQueryItem(name: "redirect_uri", value: redirect), URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        let (_, found) = try send(URLRequest(url: authorize.url!))
        let back = URLComponents(string: found.value(forHTTPHeaderField: "Location") ?? "")
        let code = try XCTUnwrap(back?.queryItems?.first { $0.name == "code" }?.value, "no code in \(found)")
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "grant_type", value: "authorization_code"), URLQueryItem(name: "client_id", value: target.client_id),
            URLQueryItem(name: "code", value: code), URLQueryItem(name: "code_verifier", value: verifier), URLQueryItem(name: "redirect_uri", value: redirect),
        ]
        var request = URLRequest(url: URL(string: "\(target.api_url)/cognito/oauth2/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(form.percentEncodedQuery!.utf8)
        return try XCTUnwrap(json(send(request).0)["access_token"] as? String)
    }

    /// A deployment's test client allows password sign-in, which needs no AWS credentials.
    private static func passwordSignIn(_ target: Target, _ user: Target.User) throws -> String {
        var request = URLRequest(url: URL(string: "https://cognito-idp.\(target.region ?? "us-west-2").amazonaws.com/")!)
        request.httpMethod = "POST"
        request.setValue("application/x-amz-json-1.1", forHTTPHeaderField: "Content-Type")
        request.setValue("AWSCognitoIdentityProviderService.InitiateAuth", forHTTPHeaderField: "X-Amz-Target")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "AuthFlow": "USER_PASSWORD_AUTH", "ClientId": target.client_id,
            "AuthParameters": ["USERNAME": user.username, "PASSWORD": user.password],
        ])
        let result = try json(send(request).0)["AuthenticationResult"] as? [String: Any]
        return try XCTUnwrap(result?["AccessToken"] as? String, "Cognito refused the test user")
    }

    /// Every record written since this device started, by id, with each field's latest value.
    func records() throws -> [String: [String: Any]] {
        var all: [String: [String: Any]] = [:]
        var cursor = start
        var more = true
        while more {
            let page = try Self.page(target, token, from: cursor)
            for change in page["changes"] as? [[String: Any]] ?? [] {
                guard let id = change["id"] as? String, let fields = change["fields"] as? [String: [String: Any]] else { continue }
                all[id, default: ["type": change["type"] ?? ""]].merge(fields.mapValues { $0["v"] ?? NSNull() }) { $1 }
            }
            cursor = page["cursor"] as? Int ?? cursor
            more = page["more"] as? Bool ?? false
        }
        return all
    }

    private static func page(_ target: Target, _ token: String, from cursor: Int) throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "\(target.api_url)/sync")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["cursor": cursor, "changes": []])
        let (data, response) = try send(request)
        XCTAssertEqual(response.statusCode, 200, String(decoding: data, as: UTF8.self))
        return try json(data)
    }

    /// Waits for the server to hold a record that matches.
    func eventually(_ what: String, _ matches: @escaping ([String: Any]) -> Bool) {
        let deadline = Date().addingTimeInterval(patience)
        var seen = 0
        repeat {
            if let all = try? records() {
                seen = all.count
                if all.values.contains(where: matches) { return }
            }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < deadline
        XCTFail("The server never had \(what). It has \(seen) records for this user.")
    }

    private static let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)

    private static func send(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        var result: Result<(Data, HTTPURLResponse), Error> = .failure(URLError(.unknown))
        let finished = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, response, error in
            if let response = response as? HTTPURLResponse { result = .success((data ?? Data(), response)) } else if let error { result = .failure(error) }
            finished.signal()
        }.resume()
        finished.wait()
        return try result.get()
    }

    private static func json(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], String(decoding: data, as: UTF8.self))
    }
}

/// The sign-in answers with a redirect to the app's link, which is read here rather than followed.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// The real app signed in to a backend, with a second device that reads what reached it.
final class SignedInUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testSignInFromSettingsThenWorkMadeHereReachesTheServer() throws {
        guard let target = try Target.fromEnvironment() else {
            throw XCTSkip("needs: localStack. scripts/test-ios.sh starts one where Docker runs.")
        }
        // Unique per run, since a deployment's test user keeps what earlier runs deleted.
        let title = "Pay the water bill \(UUID().uuidString.prefix(8))"
        let app = launchApp()
        // Signed in from Settings rather than setup, which a user who finished setup on another device skips.
        app.tapWeb("Skip")
        app.tapWeb("Next")
        app.tapWeb("Skip")
        app.tapWeb("More")
        app.tapWeb(startingWith: "Settings")
        app.tapWeb("Sign in")
        if let user = target.test_user { signInOnHostedPage(app, user) }
        // The browser sheet closes itself once the sign-in links back, and the first sync follows. On a deployment that
        // sync pulls every record earlier runs left on the test user, thousands of them.
        exists(app.webText("Synced"), timeout: 180)
        let other = try SecondDevice(target)

        app.tapWeb("Capture a task")
        let field = app.page.textFields["Capture to Inbox"]
        exists(field)
        field.tap()
        field.typeText(title + "\n")

        other.eventually("the capture") { $0["title"] as? String == title && !($0["deleted_at"] is String) }

        // Deleted here, deleted there, so a deployment's test user keeps nothing live.
        // Only this run's item: a deployment's Inbox can hold what other suites left.
        app.tapWeb(startingWith: "Inbox")
        // The item's › opens Process on it; its name opens its popup.
        app.tapWeb("Process \(title)")
        app.tapWeb("Delete/done")
        app.tapWeb("Yes, delete")
        // Process goes on to whatever else is in the Inbox, so the server is what shows it worked.
        other.eventually("the capture deleted") { $0["title"] as? String == title && $0["deleted_at"] is String }
    }

    /// A deployment's hosted sign-in page, in the browser sheet over the app. The local stack's signs in with no page.
    private func signInOnHostedPage(_ app: XCUIApplication, _ user: Target.User) {
        fillHostedSignIn(app, user)
        app.typeText("\n")
        dismissSavePassword(app, within: 10)
    }
}

/**
 * Safari's sheet that offers to keep the password, on a domain it hasn't saved one for, answered Not Now. It can also
 * show just as the sign-in returns to the app, and close a moment later with the browser it's in, and a tap on a sheet
 * that has gone fails. So that moment passes first, and only a sheet still there, waiting for an answer, gets the tap.
 */
private func dismissSavePassword(_ app: XCUIApplication, within timeout: TimeInterval) {
    let notNow = app.buttons["Not Now"]
    guard notNow.waitForExistence(timeout: timeout), !notNow.waitForNonExistence(timeout: 2) else { return }
    if notNow.exists && notNow.isHittable { notNow.tap() }
}

/// Types the test user into a deployment's hosted sign-in page, in the browser sheet over the app, and leaves it to be sent.
private func fillHostedSignIn(_ app: XCUIApplication, _ user: Target.User) {
    let password = app.secureTextFields.firstMatch
    exists(password, timeout: 60)
    let name = app.webViews.containing(.secureTextField, identifier: nil).textFields.firstMatch
    // Cognito's page holds a hidden copy of each field at the same spot, so a tap can focus the other copy: type
    // into whatever has focus.
    name.tap()
    app.typeText(user.username)
    // With the software keyboard up, a tap on the password field can leave focus on the email field, so the
    // keyboard's own Next moves it. A connected Mac keyboard shows no toolbar, and there the tap works.
    let next = app.toolbars.buttons["Next"]
    if next.exists && next.isEnabled { next.tap() } else { password.tap() }
    app.typeText(user.password)
}

/// The history-scale test's iPhone part, which scripts/test-history.sh runs once it has seeded the five-year account: a
/// new install signs in to it, its first sync to a usable app is timed, then Today and Week on the check page. Its
/// numbers go out on one line starting HISTORY iphone, for the script to read.
final class HistoryUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testFirstSyncOfTheFiveYearHistoryThenTodayAndWeek() throws {
        let inbox = ProcessInfo.processInfo.environment["MULTISCALE_HISTORY_INBOX"] ?? ""
        guard let target = try Target.fromEnvironment(), !inbox.isEmpty else {
            throw XCTSkip("needs: the seeded history. scripts/test-history.sh seeds it and runs this.")
        }
        let app = launchApp()
        let signIn = app.webButton("Sign in")
        exists(signIn)
        // From the sign-in being sent: the local stack's sign-in has no page, so that's the tap.
        var started = Date()
        signIn.tap()
        if let user = target.test_user {
            fillHostedSignIn(app, user)
            started = Date()
            app.typeText("\n")
        }
        // Usable once Today is up with the history's Inbox count in the tab bar, which arrives with its latest records.
        let usable = app.webButton("Inbox, \(inbox) to sort")
        let refused = app.staticTexts["Incorrect username or password."]
        var tries = 1
        let deadline = started.addingTimeInterval(25 * 60)
        while !usable.exists {
            dismissSavePassword(app, within: 0)
            // The browser and the Mac app sign in with the same password, so a refusal here is the typing into the page,
            // which gets one more go. A second fails now, rather than after the 25 minutes a first sync is allowed.
            if let user = target.test_user, refused.exists {
                guard tries < 2 else { return XCTFail("The sign-in page refused the history user twice. On screen:\n\(app.debugDescription)") }
                tries += 1
                fillHostedSignIn(app, user)
                started = Date()
                app.typeText("\n")
            }
            guard Date() < deadline else { return XCTFail("The app wasn't usable 25 minutes after signing in. On screen:\n\(app.debugDescription)") }
            Thread.sleep(forTimeInterval: 0.2)
        }
        let firstSync = Int(Date().timeIntervalSince(started) * 1000)
        XCTAssertTrue(app.webButton("Today").exists)

        // Today and Week once the first sync has finished, on the check page, which opens the database the app does.
        app.tapWeb("More")
        app.tapWeb(startingWith: "Settings")
        exists(app.webText("Synced"), timeout: 25 * 60)
        app.terminate()
        let checks = XCUIApplication()
        checks.launchEnvironment["MULTISCALE_START_PAGE"] = "native-checks/index.html"
        checks.launch()
        exists(checks.webText("ready"), timeout: launchPatience)
        checks.tapWeb("History")
        let line = checks.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'history:'")).firstMatch
        exists(line, timeout: 300)
        var numbers = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.label.dropFirst("history:".count).utf8)) as? [String: Any])
        numbers["first_sync_ms"] = firstSync
        let json = try JSONSerialization.data(withJSONObject: numbers, options: [.sortedKeys])
        print("HISTORY iphone \(String(decoding: json, as: UTF8.self))")
    }
}
