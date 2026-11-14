import XCTest

/// A task's popup, through the real app.
final class TaskUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testATasksPopupFromItsProjectShowsItsDescriptionFormattedUndoesANewNameAndEstimateAndKeepsItsLinks() throws {
        let app = launchApp(seed: "Seed to schedule")
        app.tapWeb("Goals")
        onTab("Goals", app.webButton(startingWith: "Learn to bake bread"), in: app)
        app.tapWeb(startingWith: "Learn to bake bread")
        app.tapWeb(startingWith: "Bake a sourdough loaf")
        let rename = app.webButton("Rename Mix the dough")
        app.tapLabeled("Edit task Mix the dough, 30m", until: rename)

        // A list and italic from the bar, typing on between the marks with the keyboard up.
        let description = app.page.textViews["Description"]
        app.type("Weigh the flour ", into: description)
        app.tapWeb("Bulleted list")
        app.tapWeb("Italic")
        app.typeText("slowly")
        reads(description, "- Weigh the flour *slowly*")
        // The keyboard covers the foot of the popup on the Simulator, so it goes before Save.
        app.hideKeyboard()
        app.tapWeb("Save")
        gone(description)

        // Saved, the row carries the mark for details, and the description shows formatted, its marks gone.
        let row = app.labeled("Edit task Mix the dough, 30m, has details")
        app.tap(row, until: app.webButton("Edit description"))
        exists(app.webText("slowly"))
        exists(app.labeled(startingWith: "Weigh the flour"))
        XCTAssertFalse(app.labeled(containing: "*").exists, "a mark still shows")

        // A longer estimate and a new name save together, and Undo puts both back. XCUITest can't set a web slider's
        // value, so the thumb is dragged: 30m is step 2 of 19, toward step 6.
        let estimate = app.page.sliders["Time estimate"]
        reads(estimate, "30m")
        estimate.coordinate(withNormalizedOffset: CGVector(dx: 2.0 / 19, dy: 0.5))
            .press(forDuration: 0.2, thenDragTo: estimate.coordinate(withNormalizedOffset: CGVector(dx: 6.0 / 19, dy: 0.5)))
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != '30m'"), object: estimate)
        XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: patience), .completed, "the estimate still reads 30m")
        let set = try XCTUnwrap(estimate.value as? String)
        XCTAssertTrue(["1h 15m", "1h 30m", "1h 45m"].contains(set), "the estimate reads \(set)")
        // Return in the name saves, as Save does. The renamed row is the one check before the toast's Undo, which goes
        // after 5 s.
        app.tapWeb("Rename Mix the dough")
        app.replaceText(in: app.page.textFields["Name"], with: "Mix the rye dough\n")
        let renamed = app.labeled("Edit task Mix the rye dough, \(set), has details")
        exists(renamed)
        app.tapWeb("Undo")
        exists(row)
        gone(renamed)

        // A link goes in as it's added, apart from Save, and Return in its fields adds it rather than saving the task.
        // The bar above the keyboard moves on to the name, which the keyboard can cover.
        let address = app.page.textFields["Address"]
        let link = app.page.links["Recipe"]
        app.tap(row, until: rename)
        app.tapWeb("Add link", until: address)
        app.type("https://example.com/recipe", into: address)
        app.tap(app.toolbars.buttons["Next"])
        app.typeText("Recipe\n")
        exists(link)
        exists(app.webText("Link · example.com"))
        // A device that has never signed in has nowhere to keep a photo, so it isn't offered.
        XCTAssertFalse(app.labeled("Add photo").exists, "Add photo is offered with nowhere to keep the photo")
        app.hideKeyboard()
        app.tapWeb("Cancel")
        gone(rename)
        app.tap(row, until: link)

        // Removed, it goes at once, and Undo is in the toast, which has to be reachable while the popup, a modal, stays
        // open: VoiceOver, like XCUITest, reads only what a modal lets it. The toast is read, then Undo tapped at once,
        // before the toast times out.
        app.tapWeb("Remove Recipe")
        exists(app.webText("Removed Recipe."))
        app.tapWeb("Undo")
        exists(link)
        gone(app.webText("Removed Recipe."))
    }
}

private extension XCUIApplication {
    /**
     * Replaces a field's text from the keyboard: a tap at the field's right end puts the caret after its text, and that
     * many deletes clear it. The keyboard types into the field the tap focused, as type(_:into:) does.
     */
    func replaceText(in field: XCUIElement, with text: String, file: StaticString = #filePath, line: UInt = #line) {
        MultiscaleUITests.exists(field, file: file, line: line)
        let old = field.value as? String ?? ""
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        XCTAssertTrue(keyboards.element.waitForExistence(timeout: patience), "no software keyboard came up. On screen:\n\(debugDescription)", file: file, line: line)
        typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count) + text)
    }

    /// Puts the keyboard away by the Done in the bar above it, so a tap on a button it covered doesn't land on a key.
    func hideKeyboard(file: StaticString = #filePath, line: UInt = #line) {
        let keyboard = keyboards.element
        guard keyboard.exists else { return }
        tap(toolbars.buttons["Done"], file: file, line: line)
        gone(keyboard, file: file, line: line)
    }
}
