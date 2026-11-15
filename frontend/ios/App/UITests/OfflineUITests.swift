import XCTest

/// Set on a launch so the debug build's web view refuses every http and https load, as a phone with no network does,
/// while the app's own pages still load (BridgeViewController.swift). A launch without it is the network back.
let offlineFlag = "MULTISCALE_OFFLINE"

extension XCUIApplication {
    /// Ends this run of the app and starts another with the network off, or back on: the debug build reads the flag only
    /// as it starts.
    func relaunch(offline: Bool) {
        terminate()
        launchEnvironment[offlineFlag] = offline ? "YES" : nil
        launchLoaded()
    }

    /// tapWeb(_:until:) for a label that goes on with a count, such as the Inbox tab's.
    func tapWeb(startingWith prefix: String, until effect: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        tapWeb(startingWith: prefix, file: file, line: line)
        let button = webButton(startingWith: prefix)
        if !effect.waitForExistence(timeout: 5), button.exists, button.isHittable { button.tap() }
        MultiscaleUITests.exists(effect, file: file, line: line)
    }

    /// Captures to the Inbox from the + button. Capture closes once the item is saved.
    func capture(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
        let field = page.textFields["Capture to Inbox"]
        tapWeb("Capture a task", until: field, file: file, line: line)
        self.type(title + "\n", into: field, file: file, line: line)
        XCTAssertTrue(field.waitForNonExistence(timeout: patience), "Capture is still open", file: file, line: line)
    }
}

/// Unique to each run, since a deployment's test user keeps what earlier runs made, deleted or not.
private func titled(_ title: String) -> String { "\(title) \(UUID().uuidString.prefix(8))" }

/**
 * The app with no network, on CI's Simulator, which has no backend. Nothing the app needs may come over the network: its
 * screens, Capture, Process and Today work, and what's made survives the app being killed. Each runs with the extensions
 * off only, since they change nothing the page loads.
 */
final class OfflineUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipIf(extensionsEnabled, "the offline tests run once, with the extensions off")
    }

    /// The hook the other offline tests rely on: the test page reaches the address scripts/test-ios.sh serves on the Mac,
    /// then, launched offline, can't, while its own page still loads from inside the app.
    func testAnOfflineLaunchLetsNoRequestOutOfTheWebView() throws {
        let address = try XCTUnwrap(ProcessInfo.processInfo.environment["MULTISCALE_SHARE_URL"])
        let checks = XCUIApplication()
        checks.launchEnvironment["MULTISCALE_START_PAGE"] = "native-checks/index.html"
        for (offline, result) in [(false, "fetch:reached"), (true, "fetch:blocked")] {
            checks.launchEnvironment[offlineFlag] = offline ? "YES" : nil
            checks.launchLoaded()
            exists(checks.webText("ready"), timeout: launchPatience)
            // The first tap after a launch can be lost, so a field the keyboard didn't come up for is tapped again.
            let field = checks.page.textFields["Address"]
            exists(field)
            field.tap()
            if !checks.keyboards.element.waitForExistence(timeout: 5) { field.tap() }
            checks.type(address, into: field)
            checks.tapWeb("Fetch", until: checks.webText(result))
            XCTAssertFalse(checks.webText(offline ? "fetch:reached" : "fetch:blocked").exists)
            checks.terminate()
        }
    }

    func testOfflineCaptureThenProcessToAProjectAndAOneOffAndBothOutliveARestart() {
        let app = launchApp(seed: "Seed plan", offline: true)
        let toProject = titled("Buy a proofing basket")
        let toOneOffs = titled("Return the library books")
        for title in [toProject, toOneOffs] { app.capture(title) }

        app.tapWeb(startingWith: "Inbox")
        app.tapWeb("Process 2 items")
        exists(app.webButton(toProject))
        app.tapWeb(anyStartingWith: "Add to a project or One offs")
        app.tapWeb(anyStartingWith: "Bake a sourdough loaf")
        exists(app.webText("Added \(toProject) to Bake a sourdough loaf."))
        exists(app.webButton(toOneOffs))
        app.tapWeb(anyStartingWith: "Add to a project or One offs")
        app.tapWeb(anyStartingWith: "One offs")
        exists(app.webText("Added \(toOneOffs) to One offs."))
        landed(toProject, toOneOffs, in: app)

        // Killed and started again, still offline: both are where they were sent, and the Inbox stays empty.
        app.terminate()
        app.launchLoaded()
        landed(toProject, toOneOffs, in: app)
        app.tapWeb("Inbox")
        exists(app.webText("Inbox is empty. Anything you capture lands here."))
    }

    /// Each where Process sent it: the project's task under its Done, which opens folded, and the one off on its screen.
    private func landed(_ toProject: String, _ toOneOffs: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        app.tapWeb("Goals", until: app.webButton(startingWith: "Learn to bake bread"), file: file, line: line)
        app.tapWeb(startingWith: "Learn to bake bread", file: file, line: line)
        app.tapWeb(startingWith: "Bake a sourdough loaf", file: file, line: line)
        app.tapWeb(anyStartingWith: "Done tasks", file: file, line: line)
        exists(app.webButton(startingWith: "Edit task \(toProject)"), file: file, line: line)
        app.tapWeb("More", file: file, line: line)
        app.tapWeb(startingWith: "One offs", file: file, line: line)
        exists(app.webElement("\(toOneOffs) done"), file: file, line: line)
    }

    func testOfflineTodayAsksAboutItsBlocksAndTheAnswersOutliveARestart() {
        let app = launchApp(seed: "Seed today", offline: true)
        allowNotificationsIfAsked()
        // The block that ended half an hour ago asks first, then the one that began six minutes ago without a Start.
        exists(app.webText("Feed the starter"))
        app.tapWeb("Not done", until: app.webText("Have you started Shape the dough?"))
        app.tapWeb("Yes, started", until: app.webText("In progress, time left"))

        app.terminate()
        app.launchLoaded()
        onToday(app.webText("In progress, time left"), in: app)
        // A block gone by says how it went, so the answer was kept. Any kind of element, as iOS types a block by whether
        // it opens a popup.
        let answered = app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Feed the starter, ' AND label ENDSWITH '. Not done.'")).firstMatch
        onToday(answered, in: app)
    }

    func testEveryMainScreenOpensOffline() {
        let app = launchApp(seed: "Seed plan", offline: true)
        onToday(app.webText("Today"), in: app)
        app.tapWeb("Week", until: app.webButton("Previous week"))
        app.tapWeb("Inbox", until: app.webText("Inbox is empty. Anything you capture lands here."))
        app.tapWeb("Goals", until: app.webButton(startingWith: "Learn to bake bread"))
        app.tapWeb("More", until: app.webText("More"))
        // More's rows, each with something only it shows, and the way back.
        let rows = [
            ("Plan", app.webText("Plan")), ("One offs", app.webText("One offs")), ("Analytics", app.webText("Analytics")),
            ("Done", app.webButton("Previous day")), ("Settings", app.webText("Settings")),
        ]
        for (row, shown) in rows {
            app.tapWeb(startingWith: row)
            exists(app.webButton("Back to More"))
            exists(shown)
            app.tapWeb("Back to More", until: app.webText("More"))
        }
    }
}

/**
 * The network going and coming back under a signed-in app: work made offline, a sync cut off by the app leaving the
 * screen, and one cut off by the app being killed. Each reaches the server once the app can, and only once. In
 * SignedInUITests, which runs where there's a backend: locally with Docker, and on a deployment. Each runs with the
 * extensions off only, since they change nothing a sync does.
 */
extension SignedInUITests {
    func testWorkMadeOfflineReachesTheServerOnceWhenTheNetworkIsBack() throws {
        let (app, other) = try signedIn()
        let kept = titled("Renew the passport")
        let oneOff = titled("Book the dentist")

        // Offline: captured, and one sent to One offs. Sync now can't reach the server, and says so.
        app.relaunch(offline: true)
        for title in [kept, oneOff] { app.capture(title) }
        app.tapWeb(startingWith: "Inbox")
        app.tapWeb("Process \(oneOff)")
        app.tapWeb(anyStartingWith: "Add to a project or One offs")
        app.tapWeb(anyStartingWith: "One offs")
        exists(app.webText("Added \(oneOff) to One offs."))
        // Process goes on to the next item, which a deployment's Inbox may hold besides this run's.
        app.tapWeb("Exit")
        app.tapWeb("More")
        app.tapWeb(startingWith: "Settings")
        app.tapWeb("Sync now")
        exists(app.webText("Offline"))
        exists(app.webText("Your changes are kept and sync when you're back online."))
        let early = try other.records().values.compactMap { $0["title"] as? String }.filter { [kept, oneOff].contains($0) }
        XCTAssertEqual(early, [], "the server has work made offline")

        // Back online, the launch's sync sends what waited: each record once, as it was left.
        app.relaunch(offline: false)
        let records = try once([kept, oneOff], on: other)
        XCTAssertEqual(records[kept]?["kind"] as? String, "inbox")
        XCTAssertEqual(records[oneOff]?["kind"] as? String, "one_off")

        // Deleted here, deleted there, so a deployment's test user keeps nothing live.
        app.tapWeb("More", until: app.webButton(startingWith: "One offs"))
        app.tapWeb(startingWith: "One offs")
        delete(oneOff, in: app, from: other)
        app.tapWeb(startingWith: "Inbox")
        delete(kept, in: app, from: other)
    }

    func testASyncCutOffByLeavingTheAppFinishesOnReturn() throws {
        let (app, other) = try signedIn()
        let title = titled("Water the plants")
        // To the Home Screen within about the two seconds an edit's sync waits, so as the app leaves the screen its sync
        // is due, under way, or only just done. Whichever it was, the item reaches the server once the app is back.
        app.capture(title)
        XCUIDevice.shared.press(.home)
        let left = NSPredicate { _, _ in app.state != .runningForeground }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: left, object: nil)], timeout: patience), .completed, "the app never left the screen")
        app.activate()
        _ = try once([title], on: other)
        app.tapWeb(startingWith: "Inbox", until: app.webButton(title))
        delete(title, in: app, from: other)
    }

    func testASyncCutOffByTheAppBeingKilledFinishesOnTheNextLaunch() throws {
        let (app, other) = try signedIn()
        let title = titled("Fix the gate")
        // Killed within about the two seconds an edit's sync waits, so its sync hadn't run, was cut off, or had only just
        // finished. Whichever it was, the item is kept and reaches the server once.
        app.capture(title)
        app.terminate()
        app.launchLoaded()
        // Still here, once, and the launch's sync sends it.
        app.tapWeb(startingWith: "Inbox", until: app.webButton("Process \(title)"))
        XCTAssertEqual(app.page.buttons.matching(NSPredicate(format: "label == %@", "Process \(title)")).count, 1)
        _ = try once([title], on: other)
        delete(title, in: app, from: other)
    }

    /// A new install signed in from Settings, as testSignInFromSettingsThenWorkMadeHereReachesTheServer signs in, once its
    /// first sync has landed, and a second device that reads what reaches the server from then on.
    private func signedIn() throws -> (XCUIApplication, SecondDevice) {
        guard let target = try Target.fromEnvironment() else {
            throw XCTSkip("needs: localStack. scripts/test-ios.sh starts one where Docker runs.")
        }
        try XCTSkipIf(extensionsEnabled, "the network tests run once, with the extensions off")
        let app = launchApp()
        app.tapWeb("Skip", until: app.webText("Unavailable hours"))
        app.tapWeb("Next")
        app.tapWeb("Skip")
        app.tapWeb("More")
        app.tapWeb(startingWith: "Settings")
        app.tapWeb("Sign in")
        if let user = target.test_user { signInOnHostedPage(app, user) }
        exists(app.webText("Synced"), timeout: 180)
        return (app, try SecondDevice(target))
    }

    /// Waits for the server to hold each title, live, then checks it holds each once only: a send repeated after a cut-off
    /// sync must merge into the same record, never make another. Returns each record by title.
    private func once(_ titles: [String], on other: SecondDevice, file: StaticString = #filePath, line: UInt = #line) throws -> [String: [String: Any]] {
        for title in titles {
            other.eventually(title) { $0["title"] as? String == title && !($0["deleted_at"] is String) }
        }
        let records = try other.records().values
        var found: [String: [String: Any]] = [:]
        for title in titles {
            let copies = records.filter { $0["title"] as? String == title }
            XCTAssertEqual(copies.count, 1, "the server holds \(title) \(copies.count) times", file: file, line: line)
            found[title] = copies.first
        }
        return found
    }

    /// Deletes this run's item from its popup, opened by its name on the screen showing, and waits for the server to
    /// have it deleted, so a deployment's test user keeps nothing live.
    private func delete(_ title: String, in app: XCUIApplication, from other: SecondDevice, file: StaticString = #filePath, line: UInt = #line) {
        app.tapWeb(title, file: file, line: line)
        app.tapWeb("Delete task", until: app.webText("Deleted \(title)."), file: file, line: line)
        other.eventually("\(title) deleted") { $0["title"] as? String == title && $0["deleted_at"] is String }
    }
}
