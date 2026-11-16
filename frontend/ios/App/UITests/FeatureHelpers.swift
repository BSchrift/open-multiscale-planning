import XCTest

/**
 * What the feature tests share. They find elements by their accessible label, whatever type WebKit gives them: iOS
 * reports some buttons as pop-up buttons or as Other, and a checkbox, a select or a row of a list differently across
 * versions. Each waits on what the app shows, never for a fixed time.
 */
extension XCUIApplication {
    /// Any element whose label is exactly `label`.
    func labeled(_ label: String) -> XCUIElement {
        page.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }
    func labeled(startingWith prefix: String) -> XCUIElement {
        page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }
    func labeled(containing text: String) -> XCUIElement {
        page.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }
    /// The element WebKit gives a role: a dialog, a region or a list's row, matched by its whole label.
    func labeled(_ label: String, in scope: XCUIElement) -> XCUIElement {
        scope.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }
    func labeled(startingWith prefix: String, in scope: XCUIElement) -> XCUIElement {
        scope.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    /**
     * Taps an element once it's there. With `until`, it waits for what the tap brings: CI's Simulator now and then loses
     * a tap, so one whose control is still there and hittable a few seconds on is tapped again, as a person would.
     */
    func tap(_ element: XCUIElement, until effect: XCUIElement? = nil, file: StaticString = #filePath, line: UInt = #line) {
        MultiscaleUITests.exists(element, file: file, line: line)
        element.tap()
        guard let effect else { return }
        if !effect.waitForExistence(timeout: 5), element.exists, element.isHittable { element.tap() }
        MultiscaleUITests.exists(effect, file: file, line: line)
    }
    func tapLabeled(_ label: String, until effect: XCUIElement? = nil, file: StaticString = #filePath, line: UInt = #line) {
        tap(labeled(label), until: effect, file: file, line: line)
    }
    func tapLabeled(startingWith prefix: String, until effect: XCUIElement? = nil, file: StaticString = #filePath, line: UInt = #line) {
        tap(labeled(startingWith: prefix), until: effect, file: file, line: line)
    }

    /// Opens a tab of the phone's bar (Today, Week, Inbox, Goals, More), or a row under More (Plan, One offs, Analytics,
    /// Done, Settings).
    /// Buttons by type here, as the tests before these found them on every iOS they ran on: a page can hold text with a
    /// tab's name, such as Today's heading. Each waits for the page it opens, its region named for the area, since the
    /// first tap after a launch is now and then lost on CI's Simulator and a lost one is tapped again.
    func open(_ area: String, file: StaticString = #filePath, line: UInt = #line) {
        switch area {
        case "Today", "Week", "Goals", "More": tapWeb(area, until: labeled("\(area), region"), file: file, line: line)
        // The tab carries its count: "Inbox, 3 to sort".
        case "Inbox": tap(webButton(startingWith: "Inbox"), until: labeled("Inbox, region"), file: file, line: line)
        default:
            // A row reads its name, then a line of what's there. More can still show a page of its own from before, so the
            // wait is for the row, which a second tap on More, back to its top, brings.
            tapWeb("More", until: webButton(startingWith: area), file: file, line: line)
            tapWeb(startingWith: area, file: file, line: line)
        }
    }

    /// A select opens as a menu of the app's own options, whatever element type this iOS gives its items.
    func choose(_ option: String, in label: String, file: StaticString = #filePath, line: UInt = #line) {
        // Not the text of the select's own label, which WebKit gives the same name, nor a label wrapped around the select,
        // which comes before it as an Other of that name: the last of them is the select.
        let notText = NSPredicate(format: "label == %@ AND elementType != %d", label, XCUIElement.ElementType.staticText.rawValue)
        let named = page.descendants(matching: .any).matching(notText)
        MultiscaleUITests.exists(named.firstMatch, file: file, line: line)
        guard let select = named.allElementsBoundByIndex.last else { return }
        select.tap()
        let types = [XCUIElement.ElementType.button, .menuItem, .cell].map(\.rawValue)
        let item = descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType IN %@", option, types)).firstMatch
        MultiscaleUITests.exists(item, file: file, line: line)
        item.tap()
        // The select shows what's saved, so it goes back to the old value until the save lands, which on CI's Simulator
        // can take longer than the tap does.
        let chosen = page.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND value == %@", label, option)).firstMatch
        if chosen.waitForExistence(timeout: patience) { return }
        XCTFail("\(label) shows \(select.value ?? "nothing"), not \(option). On screen:\n\(debugDescription)", file: file, line: line)
    }
}

/// Waits for an element to go, such as a sheet that closes or a row that moves elsewhere.
func gone(_ element: XCUIElement, timeout: TimeInterval = patience, file: StaticString = #filePath, line: UInt = #line) {
    if element.waitForNonExistence(timeout: timeout) { return }
    XCTFail("\(element) is still there. On screen:\n\(XCUIApplication().debugDescription)", file: file, line: line)
}

/// Waits for an element's value, such as a slider's or a field's, to read `value`.
func reads(_ element: XCUIElement, _ value: String, file: StaticString = #filePath, line: UInt = #line) {
    let read = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
    if XCTWaiter.wait(for: [read], timeout: patience) == .completed { return }
    XCTFail("\(element) reads \(element.value ?? "nothing"), not \(value)", file: file, line: line)
}
