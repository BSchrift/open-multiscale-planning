import XCTest

/// Settings and away periods, through the real app.
final class SettingsUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testEachSectionOfSettingsIsEditedInPlaceAndKeptAfterARelaunchWhileAppearanceFollowsTheSystemUntilChosen() throws {
        // The Simulator's own light or dark, which this test changes, left light for the tests after it.
        XCUIDevice.shared.appearance = .light
        addTeardownBlock { XCUIDevice.shared.appearance = .light }
        let app = launchApp(seed: "Seed plan")

        // More's row reads the hours as they stand: a new install's 10pm to 7am every day leaves 105h, and no aim.
        app.open("More")
        exists(app.labeled(containing: "105h a week for projects, no One offs aim"))
        app.tapWeb(startingWith: "Settings")

        // Available hours: unavailable time added, then made weekdays only and open to one offs, each summed at once. Add
        // is tapped once, with no retry, since a second tap for a row that came slowly would add another.
        exists(app.labeled("105h a week for projects and 105h for one offs."))
        app.tapLabeled("Add unavailable time")
        let lunch = app.labeled("Unavailable, 12pm to 1pm")
        exists(lunch)
        exists(app.labeled("98h a week for projects and 98h for one offs."))
        // Each unavailable row has its own Days and One offs, so these are the new row's.
        select("Weekdays", in: app.labeled("Days", in: lunch), of: app)
        exists(app.labeled("100h a week for projects and 100h for one offs."))
        app.tap(app.labeled("One offs", in: lunch))
        exists(app.labeled("100h a week for projects and 105h for one offs."))

        // XCUITest can't set a web slider's value, so the aim's thumb is dragged off No aim, to wherever it lands.
        let aim = app.page.sliders["Weekly one offs aim"]
        scrollTo(aim, in: app)
        aim.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.5)).press(forDuration: 0.2, thenDragTo: aim.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)))
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", "No aim"), object: aim)
        XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: patience), .completed, "the aim still reads No aim")
        let aimed = try XCTUnwrap(aim.value as? String)

        // The cadence changes on the Plan page, and back returns here.
        exists(app.labeled("Calendar quarters"))
        app.tapWeb("Change planning cadence", until: app.webButton("Back to Settings"))
        app.tapWeb("Back to Settings", until: app.labeled("Calendar quarters"))

        // Connecting Google Calendar needs Google, so only that it isn't connected.
        exists(app.labeled("Not connected."))

        // Reminders: without the check-in, its delay and the note about pauses go with it.
        let delay = app.page.sliders["After"]
        let pauses = app.labeled("A paused block also gets one reminder after 30 minutes.")
        exists(delay)
        exists(pauses)
        toggle("Ask if I've started, unless I already tapped Start", in: app)
        gone(delay)
        gone(pauses)

        // Keyboard shortcuts are the desktop's: the phone has none to set.
        XCTAssertFalse(app.labeled("Single-key shortcuts in Process").exists, "the phone offers Process's keyboard shortcuts")

        // Appearance follows the Simulator's live while it's System, and a choice holds against it.
        looks(dark: false)
        XCUIDevice.shared.appearance = .dark
        looks(dark: true)
        app.tapLabeled("Light")
        looks(dark: false)

        // Data retention only informs, in this build's periods, which a local build takes from prod.
        app.tapWeb("Data retention", until: app.labeled("2 years after they end"))
        for line in ["5 years after they're closed", "30 days after you delete them", "Kept until you delete it"] { exists(app.labeled(line)) }
        app.tapWeb("Back to Settings", until: app.labeled("Calendar quarters"))

        // All of it is kept: a new process reads it back, and is light from the start though the Simulator is dark.
        app.terminate()
        app.launchLoaded()
        exists(app.webButton("More"), timeout: launchPatience)
        looks(dark: false)
        app.open("More")
        exists(app.labeled(containing: "100h a week for projects, \(aimed) One offs aim"))
        app.tapWeb(startingWith: "Settings")
        exists(app.labeled("100h a week for projects and 105h for one offs."))
        reads(app.labeled("Days", in: lunch), "Weekdays")
        reads(aim, aimed)
        // Once Reminders has drawn, the delay is still gone.
        exists(app.labeled("Notify at block start"))
        XCTAssertFalse(delay.exists, "the check-in's delay is back")

        // System again follows the Simulator, dark and then light.
        app.tapLabeled("System")
        looks(dark: true)
        XCUIDevice.shared.appearance = .light
        looks(dark: false)

        // The unavailable time removed, its hours are back.
        app.tapLabeled("Remove 12pm to 1pm")
        gone(lunch)
        exists(app.labeled("105h a week for projects and 105h for one offs."))
    }

    func testAwayDatesForTodayHoldBackItsMissedBlockUntilRemovedWithUndoThenForGood() {
        // The app's day: its clock runs from the next 10am (launchApp), which can be tomorrow on the Simulator's.
        let day = Date().addingTimeInterval(morningShift(now: Date()))
        let app = launchApp(seed: "Seed settings missed")

        // The block that ended half an hour ago asks at once. Put off, it keeps a row on Today.
        exists(app.labeled("Feed the starter"))
        app.tapWeb("Answer later")
        let missed = app.labeled(startingWith: "Check in on 1 missed block")
        onToday(missed, in: app)

        // Nothing is added without both dates.
        app.open("Settings")
        app.tapLabeled("Add")
        exists(app.labeled("Choose a start and an end date"))
        // Today alone: from today to today.
        pick(day, in: dateField("From", in: app), of: app)
        pick(day, in: dateField("To", in: app), of: app)
        app.tapLabeled("Add")
        let dates = "\(shortDate(day)) to \(shortDate(day))"
        let remove = app.labeled("Remove \(dates)")
        exists(remove)

        // Away today, its missed block isn't asked about.
        app.open("Today")
        goneFromToday(missed, in: app)

        // Removed, then put back by Undo. More still holds Settings, so its tab goes straight there.
        app.tapWeb("More")
        app.tap(remove)
        gone(remove)
        exists(app.labeled("Removed away dates \(dates)."))
        app.tapLabeled("Undo", until: remove)

        // Removed for good, and the missed block asks again.
        app.tap(remove)
        gone(remove)
        app.open("Today")
        onToday(missed, in: app)
    }

    // MARK: - Helpers

    /// Waits for the whole screen to look dark or light, from its average brightness in a screenshot.
    private func looks(dark: Bool, file: StaticString = #filePath, line: UInt = #line) {
        let shown = NSPredicate { _, _ in (self.brightness() < 0.5) == dark }
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: shown, object: nil)], timeout: patience)
        XCTAssertEqual(result, .completed, "the screen isn't \(dark ? "dark" : "light"): its brightness is \(brightness())", file: file, line: line)
    }

    /// The screen's average brightness, from 0 for black to 1 for white, read from a screenshot drawn into 16 by 16 pixels.
    private func brightness() -> CGFloat {
        guard let image = XCUIScreen.main.screenshot().image.cgImage else { return 0.5 }
        let side = 16
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        let drawn = pixels.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        guard drawn else { return 0.5 }
        var sum = 0
        for pixel in stride(from: 0, to: pixels.count, by: 4) { sum += Int(pixels[pixel]) + Int(pixels[pixel + 1]) + Int(pixels[pixel + 2]) }
        return CGFloat(sum) / CGFloat(side * side * 3 * 255)
    }

    /// As XCUIApplication.choose, for a select found in a scope, such as one row's of several with the same label.
    private func select(_ option: String, in select: XCUIElement, of app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        exists(select, file: file, line: line)
        select.tap()
        let types = [XCUIElement.ElementType.button, .menuItem, .cell].map(\.rawValue)
        let item = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType IN %@", option, types)).firstMatch
        exists(item, file: file, line: line)
        item.tap()
        // The select shows what's saved, so it reads the old value until the save lands.
        reads(select, option, file: file, line: line)
    }

    /**
     * Ticks or unticks a checkbox and waits for it to read the other way, as WebKit gives it 1 or 0 once the save lands.
     * The control, not the text beside it, though a tap on either would do. Tapped once only: a second, for a save that
     * came slowly, would put it back.
     */
    private func toggle(_ label: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let text = NSNumber(value: XCUIElement.ElementType.staticText.rawValue)
        let box = app.page.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType != %@", label, text)).firstMatch
        exists(box, file: file, line: line)
        let before = box.value as? String ?? ""
        box.tap()
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", before), object: box)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: patience), .completed, "\(label) still reads \(before)", file: file, line: line)
    }

    /// A date field of Away dates, by its label: the hours sliders of Available hours are named From and To too.
    private func dateField(_ label: String, in app: XCUIApplication) -> XCUIElement {
        let others = [XCUIElement.ElementType.slider, .staticText].map(\.rawValue)
        return app.page.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND NOT (elementType IN %@)", label, others)).firstMatch
    }

    /**
     * Picks a day in a date field with the picker iOS opens over it: a calendar of the month the Simulator's clock is in,
     * which the app's day can be the month after. A day reads as "Friday, November 13" in the US, and day first elsewhere.
     */
    private func pick(_ day: Date, in field: XCUIElement, of app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        app.tap(field, file: file, line: line)
        let picker = app.datePickers.firstMatch
        exists(picker, file: file, line: line)
        if !Calendar.current.isDate(day, equalTo: Date(), toGranularity: .month) { app.tap(picker.buttons["Next Month"], file: file, line: line) }
        let month = DateFormatter()
        month.dateFormat = "MMMM"
        let name = month.string(from: day)
        let number = Calendar.current.component(.day, from: day)
        let cell = picker.descendants(matching: .any).matching(NSPredicate(format: "label MATCHES %@", ".*\\b(\(name) \(number)|\(number) \(name))\\b.*")).firstMatch
        app.tap(cell, file: file, line: line)
        // WebKit's picker closes with its Done. Should this iOS show none, a tap above it closes it, as a tap away does.
        let done = app.buttons["Done"]
        if done.waitForExistence(timeout: 5) { done.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap() }
        gone(picker, file: file, line: line)
    }

    /// A date as the app writes it, "Nov 13", in English whatever the Simulator's language.
    private func shortDate(_ day: Date) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "MMM d"
        return format.string(from: day)
    }

    /**
     * Scrolls the page up until the element can be touched, for a drag by coordinates, which doesn't scroll by itself as a
     * tap does. Each drag is shorter than the screen and held still at its end, so the page doesn't coast on and nothing is
     * scrolled past, and it runs up the side gutter, where no control can catch it.
     */
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        exists(element, file: file, line: line)
        for _ in 0..<8 where !element.isHittable {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.7)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.35)),
                                                                                   withVelocity: .slow, thenHoldForDuration: 0.3)
        }
        XCTAssertTrue(element.isHittable, "\(element) never came on screen. On screen:\n\(app.debugDescription)", file: file, line: line)
    }

    /// Waits for something to leave Today. As onToday explains, the tree can hold Today as it was until Today is hidden
    /// and shown again.
    private func goneFromToday(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        if element.waitForNonExistence(timeout: 10) { return }
        app.tapWeb("Week", until: app.webButton("Previous week"), file: file, line: line)
        app.tapWeb("Today", file: file, line: line)
        gone(element, file: file, line: line)
    }
}
