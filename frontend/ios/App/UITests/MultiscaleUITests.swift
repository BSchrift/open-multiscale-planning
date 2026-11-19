import CryptoKit
import XCTest

/// CI's Simulator now and then holds every process it starts for up to 40 s: its logs show each one waiting between
/// xpcproxy_sim and exec, then all starting together. Anything that needs a process started meanwhile, such as the
/// keychain or a web view's network process, waits that out, so a wait allows longer than the longest hold seen.
let patience: TimeInterval = 60
/// For the first page after a launch, when the web view starts WebKit's processes, which that hold can delay on top of
/// the page's own second or two.
let launchPatience: TimeInterval = 120
/// Posted by the debug build each time its web view finishes loading a page (BridgeViewController.swift).
private let pageLoaded = "io.github.bschrift.multiscale.page-loaded"
/// Posted by the debug build, with the KPI's name after it, each time the page measures one (src/core/perf.ts), such as
/// nav.week once Week is drawn with its data.
private let measured = "io.github.bschrift.multiscale.measured."

/// Set by scripts/test-ios.sh for its second run, which builds with the extensions on.
let extensionsEnabled = ProcessInfo.processInfo.environment["MULTISCALE_EXTENSIONS"] == "YES"
private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

extension XCUIApplication {
    var page: XCUIElement { webViews.firstMatch }
    func webButton(_ label: String) -> XCUIElement { page.buttons[label] }
    func webText(_ text: String) -> XCUIElement { page.staticTexts[text] }
    /// Any kind of element, for controls whose type differs between iOS versions, such as a checkbox or a select.
    func webElement(_ label: String) -> XCUIElement { page.descendants(matching: .any)[label] }
    /// Capture's field on a calendar's draft, where it's also a search of your tasks: a combobox, which WebKit may give
    /// iOS as a text field, a combo box or a search field. Never the label above it, which is static text.
    var draftCaptureField: XCUIElement {
        let types = [XCUIElement.ElementType.textField, .comboBox, .searchField].map(\.rawValue)
        return page.descendants(matching: .any).matching(NSPredicate(format: "label == 'Capture to Inbox' AND elementType IN %@", types)).firstMatch
    }
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

    /// Taps Week's tab, then waits for the app's word that Week is drawn with its data before anything reads the page. On
    /// iOS 26.2 a page read before its content arrives stays empty in the tree while the screen shows it drawn (see
    /// onTab), and on CI's Simulator Week has taken 9 s to draw after the tap. A tap that drew nothing in all the time a
    /// draw can take was lost, as the first after a launch now and then is, so it's tapped again.
    func openWeek(file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<2 {
            let drawn = XCTDarwinNotificationExpectation(notificationName: measured + "nav.week")
            tapWeb("Week", file: file, line: line)
            if XCTWaiter.wait(for: [drawn], timeout: patience) == .completed { return }
        }
        XCTFail("Week never said it was drawn. On screen:\n\(debugDescription)", file: file, line: line)
    }

    /// Taps a field, then types with the keyboard. WebKit now and then drops the page from the tree for a moment as the
    /// keyboard comes up, and typing into the field by name fails at once when the field can't be found then. The
    /// keyboard types into whatever has focus, which the tap gave the field.
    func type(_ text: String, into field: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        MultiscaleUITests.exists(field, file: file, line: line)
        field.tap()
        XCTAssertTrue(keyboards.element.waitForExistence(timeout: patience), "no software keyboard came up. On screen:\n\(debugDescription)", file: file, line: line)
        typeText(text)
    }

    /// Launches, then waits for the web view to load its page before anything reads the page. Reading a web view whose
    /// WebKit processes the Simulator is still holding fails the test at once ("Timed out while evaluating UI query"),
    /// however long the wait around it allows, so the wait is for the app's own word instead.
    func launchLoaded(file: StaticString = #filePath, line: UInt = #line) {
        let loaded = XCTDarwinNotificationExpectation(notificationName: pageLoaded)
        launch()
        waitForPage(loaded, file: file, line: line)
    }
}

/// Waits for an expectation made, before whatever opens the page, from the debug build's page-loaded notification.
private func waitForPage(_ loaded: XCTestExpectation, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: launchPatience), .completed, "the web view never loaded its page", file: file, line: line)
}

func exists(_ element: XCUIElement, timeout: TimeInterval = patience, in owner: XCUIApplication = XCUIApplication(), file: StaticString = #filePath, line: UInt = #line) {
    if element.waitForExistence(timeout: timeout) { return }
    // The tree shows what was on screen instead, since labels change between iOS versions.
    XCTFail("\(element) did not appear. On screen:\n\(owner.debugDescription)", file: file, line: line)
}

/**
 * The app with its data as a new install has it, then seeded from the test page when a seed is given. The Simulator's
 * clock can't be set, and Today shows and says "today" only for blocks that start today, so a seeded app's web view
 * runs its clock from the next 10am (BridgeViewController.swift), where the seed's blocks and the test fit in the day
 * at any hour. A test that needs the `realClock` has it, and waits out the last minutes of a day instead. An `offline`
 * app starts with no network (`offlineFlag`).
 */
func launchApp(seed: String? = nil, realClock: Bool = false, remindingOnLeave: Bool = false, offline: Bool = false, arguments: [String] = []) -> XCUIApplication {
    let checks = XCUIApplication()
    let app = XCUIApplication()
    app.launchArguments = arguments
    if seed != nil, !realClock {
        let shift = String(Int(morningShift(now: Date()) * 1000))
        for launched in [checks, app] { launched.launchEnvironment["MULTISCALE_CLOCK_SHIFT_MS"] = shift }
    }
    if remindingOnLeave { app.launchEnvironment[remindersOnLeave] = "YES" }
    if offline { app.launchEnvironment[offlineFlag] = "YES" }
    checks.launchEnvironment["MULTISCALE_START_PAGE"] = "native-checks/index.html"
    checks.launchLoaded()
    exists(checks.webText("ready"), timeout: launchPatience)
    checks.tapWeb("Erase", until: checks.webText("erased"))
    if let seed {
        let at = realClock ? seedTime(now: Date()) : Date()
        if at > Date() {
            print("Waiting until \(at) so the test after \(seed) ends on the day it starts")
            Thread.sleep(until: at)
        }
        // A tap after that wait, like the first after a launch, can be lost.
        checks.tapWeb(seed, until: checks.webText("seeded"))
    }
    checks.terminate()
    app.launchLoaded()
    return app
}

/// How far ahead of the real clock a seeded app's runs: to the next 10am, never back, since a reminder the app sets for
/// a time already past on the real clock makes iOS refuse the whole batch.
func morningShift(now: Date, calendar: Calendar = .current) -> TimeInterval {
    let ten = calendar.date(bySettingHour: 10, minute: 0, second: 0, of: now)!
    return (ten >= now ? ten : calendar.date(byAdding: .day, value: 1, to: ten)!).timeIntervalSince(now)
}

/// When a seed on the real clock can run: at once, except in the last ten minutes of a day, which it waits out so the
/// test that follows ends on the day it started. Only a seed that places no blocks runs on the real clock.
func seedTime(now: Date, calendar: Calendar = .current) -> Date {
    let next = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))!
    return now.addingTimeInterval(10 * 60) > next ? next.addingTimeInterval(60) : now
}

final class SeedTimeTests: XCTestCase {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()
    private func at(_ time: String) -> Date { ISO8601DateFormatter().date(from: time + ":00Z")! }

    func testASeededAppsClockRunsFromTheNextTenAM() {
        XCTAssertEqual(morningShift(now: at("2026-11-02T09:00"), calendar: calendar), 60 * 60)
        XCTAssertEqual(morningShift(now: at("2026-11-02T10:00"), calendar: calendar), 0)
        XCTAssertEqual(morningShift(now: at("2026-11-02T00:10"), calendar: calendar), (9 * 60 + 50) * 60)
        XCTAssertEqual(morningShift(now: at("2026-11-02T23:30"), calendar: calendar), 10.5 * 60 * 60)
    }

    func testASeedOnTheRealClockWaitsOutTheLastTenMinutesOfTheDay() {
        XCTAssertEqual(seedTime(now: at("2026-11-02T00:05"), calendar: calendar), at("2026-11-02T00:05"))
        XCTAssertEqual(seedTime(now: at("2026-11-02T12:00"), calendar: calendar), at("2026-11-02T12:00"))
        XCTAssertEqual(seedTime(now: at("2026-11-02T23:49"), calendar: calendar), at("2026-11-02T23:49"))
        XCTAssertEqual(seedTime(now: at("2026-11-02T23:55"), calendar: calendar), at("2026-11-03T00:01"))
    }
}

/**
 * Waits for something on a tab's page. On iOS 26.2, under Xcode 16.4 and 26.3 alike, when XCUITest first reads a page
 * before its content has arrived, the tree keeps that part of the page as it was, while the screen shows the rest: CI's
 * screen recordings show Today drawn, its countdown ticking, as the tree reports Today's region empty for a minute, and
 * Goals did the same. Waiting longer, tapping, swiping, rotating, backgrounding the app and the app posting layout or
 * screen changes didn't bring the content in reliably. Hiding the page and showing it again did, every time: so the
 * test goes to Week and back. A page first read only once the app says it's drawn never stayed empty, which is how
 * openWeek opens Week, so this is for the other tabs.
 */
private func onTab(_ tab: String, _ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    if element.waitForExistence(timeout: 10) { return }
    app.openWeek(file: file, line: line)
    app.tapWeb(tab, file: file, line: line)
    exists(element, file: file, line: line)
}

func onToday(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    onTab("Today", element, in: app, file: file, line: line)
}

/// Set on a launch so the debug build brings the app's soonest reminder forward to two seconds after the app leaves the
/// screen (BridgeViewController.swift).
private let remindersOnLeave = "MULTISCALE_REMINDERS_ON_LEAVE"

/**
 * Goes to the Home Screen and answers the app's notification from its banner. The app was launched with
 * `remindersOnLeave`, so the notification comes only once the app has left the screen, and its banner shows on the
 * Home Screen. One due at a set time could come while the test was still in the app, and its banner went with the app.
 * Notification Center keeps a notification for longer, but XCUITest can't see the actions a long press there brings up.
 */
private func answerNotification(with action: String, alsoOffering others: [String], notOffering absent: [String] = [],
                                file: StaticString = #filePath, line: UInt = #line) {
    XCUIDevice.shared.press(.home)
    let banner = springboard.descendants(matching: .any)["NotificationShortLookView"]
    exists(banner, in: springboard, file: file, line: line)
    banner.press(forDuration: 1.5)
    let button = springboard.buttons[action]
    exists(button, in: springboard, file: file, line: line)
    for other in others { XCTAssertTrue(springboard.buttons[other].exists, "\(other) isn't offered", file: file, line: line) }
    for other in absent { XCTAssertFalse(springboard.buttons[other].exists, "\(other) is offered", file: file, line: line) }
    button.tap()
}

/// The app asks once there's a block to remind about. Whichever test gets there first answers.
func allowNotificationsIfAsked() {
    let allow = springboard.alerts.buttons["Allow"]
    if allow.waitForExistence(timeout: 5) { allow.tap() }
}

/// Opens one of the app's links, as another app would. iOS asks first, though not every time, and on CI's Simulator the
/// question can take longer than any fixed wait. So this waits for whichever comes first, the question or `opened`, and
/// answers the question when that's the one.
private func openLink(_ link: String, until opened: @escaping () -> Bool) {
    XCUIDevice.shared.system.open(URL(string: link)!)
    let open = springboard.alerts.buttons["Open"]
    let either = NSPredicate { _, _ in open.exists || opened() }
    _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: either, object: nil)], timeout: patience)
    if open.exists { open.tap() }
}

/// The real app, through its web view.
final class ShellUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testFirstRunSetupThenItRemembersAfterARestart() {
        let app = launchApp()
        exists(app.webText("Welcome"))
        app.tapWeb("Skip", until: app.webText("Unavailable hours"))
        app.tapWeb("Next")
        app.type("Learn to bake bread", into: app.page.textFields["A goal or a thought"])
        app.tapWeb("Add goal")
        for tab in ["Today", "Week", "Goals", "More"] { exists(app.webButton(tab)) }
        exists(app.webButton("Capture a task"))

        // Setup finished in the plugin's database, so a new process goes straight to the shell, goal and all.
        app.terminate()
        app.launchLoaded()
        exists(app.webButton("Goals"), timeout: launchPatience)
        XCTAssertFalse(app.webText("Welcome").exists)
        app.tapWeb("Goals")
        onTab("Goals", app.webButton(startingWith: "Learn to bake bread"), in: app)
    }

    /// Text follows the phone's text-size setting, as Apple's text styles do: the tab bar's labels, and so its buttons,
    /// are taller at the largest accessibility size than at the default.
    ///
    /// It reads the tab bar rather than Today's title. Today's screen arrives a moment after the shell, behind its lazily
    /// loaded code, and when the test's first look at the page lands in that moment, WebKit exposes the Today region
    /// but never its contents for the rest of that launch, though they're drawn. The tab bar is drawn with the shell, so
    /// it's in the tree from the first look.
    func testTextFollowsThePhonesTextSize() {
        var heights: [CGFloat] = []
        for size in ["UICTContentSizeCategoryL", "UICTContentSizeCategoryAccessibilityXL"] {
            let app = launchApp(seed: "Seed plan", arguments: ["-UIPreferredContentSizeCategoryName", size])
            let tab = app.page.otherElements["Main, navigation"].buttons["Today"]
            exists(tab, timeout: launchPatience)
            heights.append(tab.frame.height)
            app.terminate()
        }
        XCTAssertGreaterThan(heights[1], heights[0] * 1.2, "The Today tab is \(heights[0])pt high at the default size and \(heights[1])pt at the largest")
    }

    func testCaptureFromThePlusButtonThenProcessToAProjectAndAOneOff() {
        let app = launchApp(seed: "Seed plan")
        for title in ["Buy a proofing basket", "Return the library books"] {
            let field = app.page.textFields["Capture to Inbox"]
            app.tapWeb("Capture a task", until: field)
            app.type(title + "\n", into: field)
            XCTAssertTrue(field.waitForNonExistence(timeout: patience), "Capture is still open")
        }

        app.tapWeb(startingWith: "Inbox")
        app.tapWeb("Process 2 items")
        // The card's title is a button, which edits it.
        exists(app.webButton("Buy a proofing basket"))
        // Add to opens a sheet of places, ready to search; a tap on one picks it, and Add to adds the item there.
        app.tapWeb(anyStartingWith: "Add to a project or One offs")
        app.tapWeb(anyStartingWith: "Bake a sourdough loaf")
        app.tapWeb("Add to Bake a sourdough loaf")
        exists(app.webText("Added Buy a proofing basket to Bake a sourdough loaf."))

        exists(app.webButton("Return the library books"))
        app.tapWeb(anyStartingWith: "Add to a project or One offs")
        app.tapWeb(anyStartingWith: "One offs")
        app.tapWeb("Add to One offs")
        // Process closes itself on the last item; its check fades, then the last item's toast shows.
        exists(app.webText("Added Return the library books to One offs."))

        // Each landed where it was sent: the project's task under its Done, which opens folded behind its milestone.
        app.tapWeb("Goals")
        onTab("Goals", app.webButton(startingWith: "Learn to bake bread"), in: app)
        app.tapWeb(startingWith: "Learn to bake bread")
        app.tapWeb(startingWith: "Bake a sourdough loaf")
        app.tapWeb(anyStartingWith: "Done tasks")
        exists(app.webButton(startingWith: "Edit task Buy a proofing basket"))
        app.tapWeb("More")
        app.tapWeb(startingWith: "One offs")
        exists(app.webElement("Return the library books done"))
    }

    func testSaveAsNoteFromProcessThenFindItInNotesUnderMore() {
        let app = launchApp(seed: "Seed plan")
        let field = app.page.textFields["Capture to Inbox"]
        app.tapWeb("Capture a task", until: field)
        app.type("Gate code at the allotment\n", into: field)
        XCTAssertTrue(field.waitForNonExistence(timeout: patience), "Capture is still open")

        // One tap beside Goal backlog; Process closes itself on the last item, and its toast shows.
        app.tapWeb(startingWith: "Inbox")
        app.tapWeb("Process 1 item")
        exists(app.webButton("Gate code at the allotment"))
        app.tapWeb("Save as note")
        exists(app.webText("Saved Gate code at the allotment in Notes."))

        // Notes is a row under More, and the note opens in its popup.
        app.tapWeb("More")
        app.tapWeb(startingWith: "Notes")
        app.tapWeb(startingWith: "Gate code at the allotment")
        exists(app.webButton("Delete note"))
        app.tapWeb("Cancel")
    }

    func testAPracticeOnMondayTuesdayAndFridaySavesWithUndo() {
        let app = launchApp(seed: "Seed plan")
        app.tapWeb("Goals")
        onTab("Goals", app.webButton(startingWith: "Learn to bake bread"), in: app)
        app.tapWeb(startingWith: "Learn to bake bread")
        // The goal's own, which comes before the one for practices with no goal.
        let add = app.page.buttons.matching(NSPredicate(format: "label == '+ Practice'")).firstMatch
        exists(add)
        add.tap()
        app.type("Morning run", into: app.page.textFields["Name"])
        app.tapWeb("Add practice", until: app.webButton(startingWith: "Morning run"))

        // Weekdays, then untick Wednesday and Thursday: the chips are checkboxes named in full.
        app.tapWeb(startingWith: "Morning run")
        app.tapWeb("Weekdays")
        for day in ["Wednesday", "Thursday"] {
            let chip = app.page.descendants(matching: .any).matching(NSPredicate(format: "label == %@", day)).firstMatch
            exists(chip)
            chip.tap()
        }
        // The summary as VoiceOver reads it.
        exists(app.webText("Summary: 30 minutes on Monday, Tuesday and Friday, around 7 AM"))
        app.tapWeb("Save")
        exists(app.webText("Saved Morning run: 30m on Mon, Tue and Fri, around 7am."))
        // Undo puts back every day.
        app.tapWeb("Undo")
        app.tapWeb(startingWith: "Morning run")
        exists(app.webText("Summary: 30 minutes every day, around 7 AM"))
        app.tapWeb("Cancel")
    }

    func testATaskOpensWithTheKeyboardDownThenItsDescriptionTakesBoldFromTheBarWithTheKeyboardUp() {
        let app = launchApp(seed: "Seed to schedule")
        app.tapWeb("Goals")
        onTab("Goals", app.webButton(startingWith: "Learn to bake bread"), in: app)
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
        // With the keyboard, as type(_:into:) does, since the field can drop from the tree as the keyboard comes up.
        app.typeText("Use ")
        // The bar's buttons leave the field focused, so the keyboard stays up and typing goes on between the marks.
        app.tapWeb("Bold")
        XCTAssertTrue(keyboard.exists, "Bold put the keyboard away")
        app.typeText("rye")
        XCTAssertEqual(field.value as? String, "Use **rye**")
        app.tapWeb("Save")
        XCTAssertTrue(field.waitForNonExistence(timeout: patience), "the editor is still open")

        app.tapWeb(startingWith: "Edit task Mix the dough")
        exists(app.webButton("Edit description"))
        exists(app.webText("rye"))
        XCTAssertFalse(app.page.textViews["Description"].exists)
    }

    func testCaptureSitsAboveTheKeyboardOpenedByItsLinkWithTheAppClosedAndFromThePlusButton() {
        // On the real clock, since the link launches the app with none of the test's settings, its clock included.
        let app = launchApp(seed: "Seed plan", realClock: true)
        exists(app.webButton("Capture a task"))
        // The link the Control Center button opens, so a cold launch from either goes the same way.
        app.terminate()
        let loaded = XCTDarwinNotificationExpectation(notificationName: pageLoaded)
        openLink("multiscale://capture") { app.state == .runningForeground }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: patience))
        waitForPage(loaded)
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
        app.typeText(title)
        save.tap()
        XCTAssertTrue(field.waitForNonExistence(timeout: patience), "Capture is still open", file: file, line: line)
    }

    func testAToScheduleCardHeldThenDraggedOntoTheDayIsPlacedOnToday() throws {
        // Work dropped on today lands no earlier than now and ends by 11pm, which the seeded app's morning clock leaves
        // room for at any hour.
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

    func testAHoldOnEmptyTimeOnTodayDraftsAnHourAndCaptureSavesItThereAsAnInboxItem() throws {
        // The seeded app's clock reads 10am, so the afternoon and evening are still to come.
        let app = launchApp(seed: "Seed plan")
        let day = app.page.otherElements.matching(NSPredicate(format: "label BEGINSWITH %@", "Today's timeline")).firstMatch
        onToday(day, in: app)
        // The day runs from 7am to 10pm down the card. Brought up the screen, then held low on it, in the afternoon or
        // evening, above the tab bar, and let go after the hold.
        app.swipeUp()
        let screen = app.windows.firstMatch.frame
        let y = min(day.frame.maxY - 40, screen.maxY - 160)
        XCTAssertGreaterThan(y, day.frame.midY, "the lower half of the day isn't on screen. On screen:\n\(app.debugDescription)")
        let at = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: day.frame.midX, dy: y))
        at.press(forDuration: 0.8)

        // Capture opens on the draft, saying its day and time.
        let when = app.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Today, '")).firstMatch
        exists(when)
        app.type("Book the dentist", into: app.draftCaptureField)
        app.tapWeb("Save")
        // Saved there as an Inbox item, its block drawn as one: a slider, since it's still to come.
        exists(day.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Book the dentist, ' AND label CONTAINS ', Inbox.'")).firstMatch)
    }

    func testABlockHeldOnWeeksDayThenDraggedDownMovesLater() throws {
        let app = launchApp(seed: "Seed later")
        // Asked before the drag, so the question can't land in the middle of it.
        allowNotificationsIfAsked()
        app.openWeek()
        // Any kind of element: a task's block opens its popup, so iOS gives it the pop-up button type.
        let block = app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Shape the loaf, '")).firstMatch
        exists(block)
        let before = block.label

        // The day runs on below the screen's bottom, under the Capture button and the tab bar, so the page scrolls up
        // first. The week's top, down to its day strip, stays over the day as it scrolls, and the tree still places a
        // block that's gone under it, so a press on the block there lands on the strip instead. A fixed flick scrolled
        // as far as iOS flung it, which on CI was sometimes that far. So the block is scrolled to where its middle,
        // which is pressed, and the time `drop` below it, where it's let go, are both clear of the strip and the
        // Capture button.
        let drop: CGFloat = 120
        let strip = app.webElement("Choose a day")
        let capture = app.webButton("Capture a task")
        exists(strip)
        exists(capture)
        let top = strip.frame.maxY + 44
        let bottom = capture.frame.minY - 22
        let clear = { block.frame.midY >= top && block.frame.midY + drop <= bottom }
        // By the margin left of the day, where nothing is held, and stopped before letting go, so the page doesn't fly
        // on. The distance is measured from where the block is each time, so a scroll that a busy Simulator flung anyway
        // is brought back by the next.
        let margin = app.page.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.7))
        for _ in 0..<3 where !clear() {
            let by = (top + bottom - drop) / 2 - block.frame.midY
            margin.press(forDuration: 0.05, thenDragTo: margin.withOffset(CGVector(dx: 0, dy: by)), withVelocity: .slow, thenHoldForDuration: 0.3)
        }
        XCTAssertTrue(clear(), "Shape the loaf at \(block.frame) didn't scroll clear of the day strip at \(strip.frame) and the Capture button at \(capture.frame)")
        // Held past the lift, then let go two rows down, over the free time after it.
        let from = block.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        from.press(forDuration: 0.8, thenDragTo: from.withOffset(CGVector(dx: 0, dy: drop)), withVelocity: .slow, thenHoldForDuration: 0.5)
        // The toast first, since it goes after five seconds and the block moves for good. The toast comes as the move is
        // saved, and the block is drawn at its new time once Week has read it back, which on CI's Simulator has taken
        // longer than the toast stays: there the toast was gone by the time the block had moved.
        exists(app.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Moved Shape the loaf to '")).firstMatch)
        let moved = app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Shape the loaf, ' AND label != %@", before)).firstMatch
        exists(moved)
    }

    func testAHoldOnAFreeRowOfWeeksDayDraftsAnHourAndCaptureSavesItThereAsAnInboxItem() throws {
        let app = launchApp(seed: "Seed later")
        allowNotificationsIfAsked()
        app.openWeek()
        // Today's first stretch of free time still to come, a row that says so. WebKit gives each of the row's text nodes
        // its own static text, with the label trimmed, so the row reads "Free," and then its times.
        let free = app.page.staticTexts.matching(NSPredicate(format: "label == 'Free,'")).firstMatch
        exists(free)

        // As for a block held on the day: the row is scrolled to where its middle is clear of the week's top, which
        // stays over the day, and of the Capture button, by the margin left of the day, where nothing is held.
        let strip = app.webElement("Choose a day")
        let capture = app.webButton("Capture a task")
        exists(strip)
        exists(capture)
        let top = strip.frame.maxY + 44
        let bottom = capture.frame.minY - 22
        let clear = { free.frame.midY >= top && free.frame.midY <= bottom }
        let margin = app.page.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.7))
        for _ in 0..<3 where !clear() {
            margin.press(forDuration: 0.05, thenDragTo: margin.withOffset(CGVector(dx: 0, dy: (top + bottom) / 2 - free.frame.midY)), withVelocity: .slow, thenHoldForDuration: 0.3)
        }
        XCTAssertTrue(clear(), "The free row at \(free.frame) didn't scroll clear of the day strip at \(strip.frame) and the Capture button at \(capture.frame)")
        free.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.8)

        // Capture opens on the draft, saying its day and time, and Save puts it there as an Inbox item.
        exists(app.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Today, '")).firstMatch)
        app.type("Book the dentist", into: app.draftCaptureField)
        app.tapWeb("Save")
        exists(app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Book the dentist, ' AND label CONTAINS ', Inbox.'")).firstMatch)
    }

    func testPinchingWeeksDayDrawsItsHoursTallerAndANewLaunchKeepsThem() throws {
        let app = launchApp(seed: "Seed later")
        allowNotificationsIfAsked()
        app.openWeek()
        let block = app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Shape the loaf, '")).firstMatch
        exists(block)
        let before = block.frame.height
        // Two fingers on the block spread apart: a pinch, which a hold on the block gives way to.
        block.pinch(withScale: 2.5, velocity: 1)
        let taller = { (el: XCUIElement) in NSPredicate { _, _ in el.exists && el.frame.height > before * 1.8 } }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: taller(block), object: nil)], timeout: patience), .completed,
                       "Shape the loaf is \(block.frame.height)pt tall after the pinch, from \(before)pt")

        // The zoom is the phone's: the app opened again draws the day as tall.
        app.terminate()
        app.launchLoaded()
        app.openWeek()
        let again = app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Shape the loaf, '")).firstMatch
        exists(again)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: taller(again), object: nil)], timeout: patience), .completed,
                       "Shape the loaf is \(again.frame.height)pt tall after a new launch, from \(before)pt")
    }

    func testTodayAsksHowAFinishedBlockWentThenWhetherTheCurrentOneHasStarted() throws {
        let app = launchApp(seed: "Seed today")
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
        let app = launchApp(seed: "Seed soon", remindingOnLeave: true)
        allowNotificationsIfAsked()
        onToday(app.webText("In progress, time left"), in: app)

        // The block's end notification, brought forward. A task is never finished from a notification, so there's no Done.
        answerNotification(with: "Not done", alsoOffering: ["Still going", "Partly"], notOffering: ["Done"])

        app.activate()
        // A task's block opens its popup, so iOS gives it the pop-up button type rather than button: match by label alone.
        let answered = app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Proof the loaf, ' AND label ENDSWITH '. Not done.'")).firstMatch
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
        app.launchEnvironment[remindersOnLeave] = "YES"
        app.launchLoaded()
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
        if logged(result, after: before).waitForExistence(timeout: timeout) { return }
        let page = app.page.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: "\n")
        XCTFail("\(result) did not appear. The page says:\n\(page)", file: file, line: line)
    }

    func testDiagnosticsMeasureMemoryAndReportARunThatWasKilled() {
        run("Diagnostics", expect: "diagnostics:ok")
        // Killed while open, as iOS does at a memory limit: the next run reports it once.
        app.terminate()
        app.launchLoaded()
        exists(app.webText("ready"), timeout: launchPatience)
        run("Diagnostics", expect: "previous:active")
    }

    func testNotificationPermissionThenCancelThenActionReachesTheApp() {
        // The script gives each run a new Simulator, so the dialog shows, unless a test that ran first already allowed
        // it. Tapped once only: a second tap could land with the dialog up.
        app.webButton("Ask").tap()
        let allow = springboard.alerts.buttons["Allow"]
        let granted = app.webText("permission:true")
        let answered = NSPredicate { _, _ in allow.exists || granted.exists }
        _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: answered, object: nil)], timeout: patience)
        if allow.exists { allow.tap() }
        exists(granted)

        // An hour out, so it's still waiting when Cancel comes, however slow the Simulator. One due in seconds could
        // arrive first, and then Cancel took back a notification already shown.
        run("Remind", expect: "pending:check-block:end")
        run("Cancel", expect: "pending:0")

        // Brought forward once the app leaves the screen, so it comes at the Home Screen.
        run("Remind", expect: "pending:check-block:end")
        answerNotification(with: "Done", alsoOffering: ["Partly"])

        app.activate()
        exists(app.webText("response:check-block:end:done"))
    }

    func testTokensRoundTripThroughTheKeychain() {
        run("Keychain", expect: "keychain:ok")
    }

    func testDatabaseThroughThePlugin() {
        run("Database", expect: "database:ok")
    }

    /// A hold's light tap goes through the haptics plugin, since iPhones ignore the browser's vibrate.
    func testAHoldsTapReachesTheHapticsPlugin() {
        run("Haptic", expect: "haptic:ok")
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
        let linked = app.webText("link:multiscale://auth/callback?code=abc&state=def")
        openLink("multiscale://auth/callback?code=abc&state=def") { linked.exists }
        exists(linked)
        XCTAssertTrue(wait(for: browser, hittable: true), "the browser sheet is still in front. On screen:\n\(app.debugDescription)")
    }

    private func wait(for element: XCUIElement, hittable: Bool) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == %@", NSNumber(value: hittable)), object: element)
        return XCTWaiter.wait(for: [expectation], timeout: patience) == .completed
    }

    func testCaptureLinkIsNotTreatedAsSignIn() {
        let captured = app.webText("capture")
        openLink("multiscale://capture") { captured.exists }
        exists(captured)
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

    /// A 21,000-character share reaches the app whole through the extension's queue, and the app cuts its description on
    /// a word to the 20,000 characters the server takes, and says so, so the share can't stop sync.
    func testALongShareReachesTheAppWholeAndItsDescriptionIsCut() throws {
        try XCTSkipUnless(extensionsEnabled, "extensions are off")
        run("Share long", expect: "shared-long:21000:19999:cut")
    }

    /// The Control Center button's intent, run in the app's process as iOS runs it when the button is tapped, opens
    /// Capture. The script checks the button's extension is in the app.
    // shortcut: Control Center itself isn't driven. On CI's Simulator a tapped control now and then never opened the app,
    // on every try (the logs say "begin request watchdogged after 15.000000s"), so the debug build runs the intent
    // instead. Drive Control Center again once a Simulator starts a control's extension reliably.
    func testControlCenterButtonsIntentOpensCapture() throws {
        try XCTSkipUnless(extensionsEnabled, "extensions are off")
        run("Control", expect: "capture")
    }
}

/// What scripts/test-ios.sh signs in to: the local stack it started, or a deployment as its test user.
struct Target: Decodable {
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
struct SecondDevice {
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
        app.type(title + "\n", into: app.page.textFields["Capture to Inbox"])

        other.eventually("the capture") { $0["title"] as? String == title && !($0["deleted_at"] is String) }

        // Deleted here, deleted there, so a deployment's test user keeps nothing live.
        // Only this run's item: a deployment's Inbox can hold what other suites left.
        app.tapWeb(startingWith: "Inbox")
        // The item's › opens Process on it; its name opens its popup.
        app.tapWeb("Process \(title)")
        app.tapWeb("Delete")
        app.tapWeb("Yes, delete")
        // Process goes on to whatever else is in the Inbox, so the server is what shows it worked.
        other.eventually("the capture deleted") { $0["title"] as? String == title && $0["deleted_at"] is String }
    }

    /// A deployment's hosted sign-in page, in the browser sheet over the app. The local stack's signs in with no page.
    func signInOnHostedPage(_ app: XCUIApplication, _ user: Target.User) {
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
        checks.launchLoaded()
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

/**
 * The iPhone's performance KPIs (docs/performance.md), for scripts/test-perf-ios.sh only: a year of history loaded as a
 * sync would, then launches, capture, the screens and coming back to the app, timed by the app's own marks, which it
 * keeps for the test page to hand back as one line, PERF iphone {…}. Nothing here is checked against a target.
 */
final class PerfUITests: XCTestCase {
    private let environment = ProcessInfo.processInfo.environment
    override func setUp() { continueAfterFailure = false }

    func testLaunchesCaptureScreensAndResumeOnAYearOfHistory() throws {
        guard environment["MULTISCALE_PERF"] == "YES" else { throw XCTSkip("needs: scripts/test-perf-ios.sh, which reads the numbers this prints.") }
        let rounds = Int(environment["MULTISCALE_PERF_ROUNDS"] ?? "") ?? 30
        let launches = Int(environment["MULTISCALE_PERF_LAUNCHES"] ?? "") ?? 5
        let checks = XCUIApplication()
        checks.launchEnvironment["MULTISCALE_START_PAGE"] = "native-checks/index.html"
        checks.launchLoaded()
        exists(checks.webText("ready"), timeout: launchPatience)
        checks.tapWeb("Erase", until: checks.webText("erased"))
        checks.tapWeb("Seed year", until: checks.webText("seeded"))
        checks.tapWeb("Keep measures", until: checks.webText("keeping"))
        checks.terminate()

        // Each launch from the test's clock, which the page's wall clock shares, to Today interactive.
        let app = XCUIApplication()
        var launched: [Double] = []
        for _ in 0..<launches {
            launched.append(Date().timeIntervalSince1970 * 1000)
            app.launchLoaded()
            exists(app.webButton("Today"), timeout: launchPatience)
            app.terminate()
        }
        launched.append(Date().timeIntervalSince1970 * 1000)
        app.launchLoaded()
        exists(app.webButton("Today"), timeout: launchPatience)

        for _ in 0..<rounds {
            let field = app.page.textFields["Capture to Inbox"]
            app.tapWeb("Capture a task", until: field)
            app.type("Buy\n", into: field)
            XCTAssertTrue(field.waitForNonExistence(timeout: patience), "Capture is still open")
        }
        for _ in 0..<rounds {
            app.tapWeb("Week")
            app.tapWeb("Today")
            for screen in ["Done", "Analytics"] {
                app.tapWeb("More")
                let back = app.webButton("Back to More")
                if back.exists { back.tap() }
                app.tapWeb(anyStartingWith: screen)
                exists(back)
            }
            app.tapWeb("Today")
        }
        for _ in 0..<5 {
            XCUIDevice.shared.press(.home)
            app.activate()
            exists(app.webButton("Today"))
        }
        app.terminate()

        checks.launchLoaded()
        exists(checks.webText("ready"), timeout: launchPatience)
        checks.tapWeb("Measures")
        let line = checks.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'measures:'")).firstMatch
        exists(line, timeout: 120)
        var numbers = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.label.dropFirst("measures:".count).utf8)) as? [String: Any])
        numbers["launched"] = launched
        let json = try JSONSerialization.data(withJSONObject: numbers, options: [.sortedKeys])
        print("PERF iphone \(String(decoding: json, as: UTF8.self))")
    }
}
