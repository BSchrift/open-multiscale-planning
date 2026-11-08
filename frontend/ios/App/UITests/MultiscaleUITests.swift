import CryptoKit
import XCTest

private let patience: TimeInterval = 30

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
    exists(checks.webText("ready"))
    checks.tapWeb("Erase")
    exists(checks.webText("erased"))
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
        app.tapWeb("Skip")
        exists(app.webText("Unavailable hours"))
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
        exists(app.webButton("Goals"))
        XCTAssertFalse(app.webText("Welcome").exists)
        app.tapWeb("Goals")
        exists(app.webButton(startingWith: "Learn to bake bread"))
    }

    func testCaptureFromThePlusButtonThenProcessToAMilestoneAndAOneOff() {
        let app = launchApp(seed: "Seed plan")
        for title in ["Buy a proofing basket", "Return the library books"] {
            app.tapWeb("Capture a task")
            let field = app.page.textFields["Capture to Inbox"]
            // On CI's iOS 26 Simulator the first tap after launch is sometimes lost; a person would tap again.
            if !field.waitForExistence(timeout: 5) { app.tapWeb("Capture a task") }
            exists(field)
            field.tap()
            field.typeText(title + "\n")
            XCTAssertTrue(field.waitForNonExistence(timeout: patience), "Capture is still open")
        }

        app.tapWeb(startingWith: "Inbox")
        app.tapWeb("Process 2 items")
        exists(app.webText("Buy a proofing basket"))
        app.tapWeb("Bake a sourdough loaf")
        exists(app.webText("Sent to Bake a sourdough loaf."))
        choose("A starter that rises", in: "Milestone for Buy a proofing basket", app: app)

        exists(app.webText("Return the library books"))
        app.tapWeb("One offs")
        exists(app.webText("Inbox clear"))
        app.tapWeb("Done")

        // Each landed where it was sent.
        app.tapWeb("Goals")
        app.tapWeb(startingWith: "Learn to bake bread")
        app.tapWeb(startingWith: "Bake a sourdough loaf")
        let milestone = app.webElement("Milestone: A starter that rises")
        exists(milestone)
        exists(milestone.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Edit task Buy a proofing basket'")).firstMatch)
        app.tapWeb("More")
        app.tapWeb(startingWith: "One offs")
        exists(app.webElement("Return the library books done"))
    }

    func testCaptureSitsAboveTheKeyboardOpenedByItsLinkWithTheAppClosedAndFromThePlusButton() {
        let app = launchApp(seed: "Seed plan")
        exists(app.webButton("Capture a task"))
        // The link the Control Center button opens, so a cold launch from either goes the same way.
        app.terminate()
        XCUIDevice.shared.system.open(URL(string: "multiscale://capture")!)
        openLinkPrompt()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: patience))
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
        // shortcut: on CI's iOS 26.2 Simulator Today's content often reaches the screen but not the accessibility tree,
        // which shows Today empty until the page changes, so the test goes to Week and back; drop the detour once
        // WebKit's tree keeps up on its own there.
        if !card.waitForExistence(timeout: 10) {
            app.tapWeb("Week")
            exists(app.page.otherElements["Week"])
            app.tapWeb("Today")
        }
        exists(card)
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
        app.tapWeb("Partly")
        let left = app.page.sliders["Time left"]
        exists(left)
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
        exists(app.webText("In progress, time left"))

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
        exists(answered)
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
        XCTAssertEqual(select.value as? String, option)
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
        exists(app.webText("ready"))
    }

    private func run(_ button: String, expect result: String, timeout: TimeInterval = patience, file: StaticString = #filePath, line: UInt = #line) {
        let before = app.webText(result).exists ? app.page.staticTexts.matching(identifier: result).count : 0
        app.webButton(button).tap()
        let arrived = app.page.staticTexts.matching(identifier: result).element(boundBy: before).waitForExistence(timeout: timeout)
        let page = app.page.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: "\n")
        XCTAssertTrue(arrived, "\(result) did not appear. The page says:\n\(page)", file: file, line: line)
    }

    func testDiagnosticsMeasureMemoryAndReportARunThatWasKilled() {
        run("Diagnostics", expect: "diagnostics:ok")
        // Killed while open, as iOS does at a memory limit: the next run reports it once.
        app.terminate()
        app.launch()
        exists(app.webText("ready"))
        run("Diagnostics", expect: "previous:active")
    }

    func testNotificationPermissionThenCancelThenActionReachesTheApp() {
        // The script gives each run a new Simulator, and only this test asks, so the dialog must show.
        app.webButton("Ask").tap()
        let allow = springboard.alerts.buttons["Allow"]
        exists(allow)
        allow.tap()
        exists(app.webText("permission:true"))

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
        addCaptureControl()
        springboard.buttons["Capture"].firstMatch.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: patience))
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
        app.tapWeb(title)
        app.tapWeb("Delete/done")
        app.tapWeb("Yes, delete")
        // Process goes on to whatever else is in the Inbox, so the server is what shows it worked.
        other.eventually("the capture deleted") { $0["title"] as? String == title && $0["deleted_at"] is String }
    }

    /// A deployment's hosted sign-in page, in the browser sheet over the app. The local stack's signs in with no page.
    private func signInOnHostedPage(_ app: XCUIApplication, _ user: Target.User) {
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
        app.typeText(user.password + "\n")
        // Safari's sheet offers to keep the password on a domain it hasn't saved one for.
        let notNow = app.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 10) { notNow.tap() }
    }
}
