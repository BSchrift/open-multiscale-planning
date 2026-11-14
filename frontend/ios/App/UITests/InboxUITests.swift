import XCTest

/// Inbox, Process and Capture's details, through the real app.
final class InboxUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    /// Process's Add to opens as a button on phone, then as a sheet whose search field has the same label.
    private let addTo = "Add to a project or One offs"

    func testProcessGivesItemsANewProjectUnderANewGoalAPracticeAndAGoalThenSkipsOneAndDeletesOne() {
        // Call the bank, Fix the gate, Water the plants and Buy stamps, in that order.
        let app = launchApp(seed: "Seed inbox items")
        // The tab carries the Inbox's count.
        app.tapLabeled("Inbox, 4 to sort", until: app.labeled("Process 4 items"))
        let field = app.labeled(startingWith: addTo)
        app.tapLabeled("Process 4 items", until: field)

        // Call the bank: a project named in Add to's search, under a goal and with a milestone made with it. The item
        // waits on the card until it's added to the project, which then counts as one step with making it.
        app.tap(field, until: app.labeled("Add to"))
        app.type("Fix up the shed", into: last(addTo, in: app))
        app.tapLabeled("+ New project “Fix up the shed”")
        let name = app.page.textFields["Name"]
        reads(name, "Fix up the shed")
        app.tapLabeled("+ New goal")
        app.type("Fix up the house", into: app.page.textFields["New goal name"])
        app.type("Roof watertight", into: app.page.textFields["Milestone to put it under, if any"])
        app.tapLabeled("Add project")
        exists(app.webText("Created Fix up the shed, under Fix up the house, with the milestone Roof watertight."))
        app.tapLabeled("Add to Fix up the shed")
        exists(app.webText("Added Call the bank to Fix up the shed, under Roof watertight."))

        // Fix the gate: a practice, which the toast's Undo takes back along with the item's leaving the Inbox.
        app.tapLabeled("New practice from this item")
        reads(name, "Fix the gate")
        // A practice starts under the goal last made or picked.
        reads(last("Goal", in: app), "Fix up the house")
        app.tapLabeled("Make it a practice")
        exists(app.webText("Fix the gate is now a practice."))
        app.tapLabeled("Undo", until: app.webText("Undone: Fix the gate removed. Fix the gate is back."))

        // Then a goal of its own, kept on the card to file next, and skipped instead.
        app.tapLabeled("New goal from this item")
        reads(name, "Fix the gate")
        app.tapLabeled("Clear name")
        app.type("Keep the house", into: name)
        app.tapLabeled("Keep it on this card to file next", until: app.labeled("Add goal"))
        app.tapLabeled("Add goal")
        exists(app.webText("Created Keep the house."))
        app.tapLabeled("Skip")
        exists(app.webText("Skipped Fix the gate. It stays in your Inbox."))

        // Water the plants: a practice under the same goal.
        app.tapLabeled("New practice from this item")
        reads(name, "Water the plants")
        reads(last("Goal", in: app), "Fix up the house")
        app.tapLabeled("Make it a practice")
        exists(app.webText("Water the plants is now a practice."))

        // Buy stamps, the last: Delete/done asks first. Process closes itself after it, and the toast that waits for its
        // check still has Undo, which brings the item back.
        app.tapLabeled("Delete/done", until: app.webText("Delete this item?"))
        app.tapLabeled("Yes, delete")
        exists(app.webText("Deleted Buy stamps."))
        app.tapLabeled("Undo", until: app.labeled("Inbox, 2 to sort"))
        exists(app.labeled("Rename Buy stamps"))
        exists(app.labeled("Rename Fix the gate"))

        // Each landed where it was sent: both goals, the practice under its goal, and the item under its milestone.
        app.tapWeb("Goals", until: app.webButton(startingWith: "Keep the house"))
        app.tapWeb(startingWith: "Fix up the house")
        exists(app.webButton(startingWith: "Water the plants"))
        XCTAssertFalse(app.webButton(startingWith: "Fix the gate").exists, "the practice Undo took back is still under its goal")
        app.tapWeb(startingWith: "Fix up the shed")
        exists(app.labeled(startingWith: "Edit milestone Roof watertight"))
        exists(app.labeled(startingWith: "Edit task Call the bank"))
    }

    func testProcessEditsTheItemOnItsCardThenUndoPutsItBackAsItArrivedAndItGoesToOneOffsAndThisWeek() {
        let app = launchApp(seed: "Seed inbox items")
        app.tapLabeled("Inbox, 4 to sort", until: app.labeled("Process Fix the gate"))
        // An item's › opens Process on that item first.
        let field = app.labeled(startingWith: addTo)
        app.tapLabeled("Process Fix the gate", until: field)

        // The title, in place behind its pencil. The Inbox behind the card shows the same title, so it's the card's.
        let title = app.page.textFields["Title"]
        app.tap(last("Fix the gate", in: app), until: title)
        typeAtEnd(" latch", of: title, in: app)
        app.tapLabeled("Save")
        exists(app.labeled("Fix the gate latch"))

        // A description, bold from the bar.
        app.tapLabeled("Add description")
        let notes = app.page.textViews["Description"]
        app.type("Ask about the ", into: notes)
        app.tapLabeled("Bold")
        app.typeText("rate")
        XCTAssertEqual(notes.value as? String, "Ask about the **rate**")
        app.tapLabeled("Save")
        gone(notes)
        exists(app.webText("rate"))

        // A link, added with the keyboard's Return.
        app.tapLabeled("Add link")
        app.type("https://bank.example.com/loans\n", into: app.page.textFields["Address"])
        exists(app.labeled("bank.example.com"))

        setADate(in: app)

        // One Undo puts the item back as it arrived: its title, and no description, link or date.
        app.tapLabeled("‹ Undo", until: app.webText("Fix the gate is back as it arrived."))
        gone(app.labeled("Fix the gate latch"))
        exists(app.labeled("Add description"))
        exists(app.labeled("Add date"))
        gone(app.labeled("bank.example.com"))

        // Added to this week as well, and the toast's Undo brings the card back as it was, the week still on.
        app.tapLabeled("Add to this week", until: app.labeled("Adding to this week"))
        app.tap(field, until: app.labeled("Add to"))
        app.tapLabeled(startingWith: "Bake a sourdough loaf")
        exists(app.webText("Added Fix the gate to Bake a sourdough loaf and to this week."))
        app.tapLabeled("Undo", until: app.webText("Fix the gate is back."))
        exists(app.labeled("Adding to this week"))
        app.tap(field, until: app.labeled("Add to"))
        app.tapLabeled(startingWith: "One offs")
        exists(app.webText("Added Fix the gate to One offs and to this week."))
        app.tapLabeled("Exit")

        // It left the Inbox for One offs, and waits on Today for a time to be chosen this week.
        exists(app.labeled("Inbox, 3 to sort"))
        app.tapWeb("Today")
        let waiting = app.page.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Fix the gate, ' AND label ENDSWITH ', to schedule'")).firstMatch
        onToday(waiting, in: app)
        app.open("One offs")
        exists(app.labeled("Fix the gate done"))
    }

    func testAnInboxRowOpensItsPopupAndRenamesInPlaceThenSelectModeAddsDeletesAndMakesOneOffsOfMany() {
        let app = launchApp(seed: "Seed inbox items")
        app.tapLabeled("Inbox, 4 to sort", until: app.labeled("Fix the gate"))

        // The row's name opens the item's popup, which knows it's in the Inbox.
        app.tapLabeled("Fix the gate", until: app.labeled("Delete task"))
        reads(last("Belongs to", in: app), "Inbox")
        app.tapLabeled("Cancel")
        gone(app.labeled("Delete task"))

        // Its pencil renames it in the row, with Undo.
        let title = app.page.textFields["Title"]
        app.tapLabeled("Rename Fix the gate", until: title)
        typeAtEnd(" latch\n", of: title, in: app)
        exists(app.webText("Renamed to Fix the gate latch."))
        app.tapLabeled("Undo", until: app.labeled("Rename Fix the gate"))

        // Select mode: two items added to a project at once.
        app.tapLabeled("Select", until: app.labeled("0 selected"))
        app.tapLabeled("Call the bank", until: app.labeled("1 selected"))
        app.tapLabeled("Buy stamps", until: app.labeled("2 selected"))
        app.choose("Bake a sourdough loaf", in: "Project to add to")
        app.tapLabeled("Add")
        exists(app.webText("Added 2 items to Bake a sourdough loaf."))
        exists(app.labeled("Inbox, 2 to sort"))

        // Select all, then Delete/done asks first, and one Undo brings every item back. Undo takes focus, with nothing
        // left in the list, which holds the toast open.
        app.tapLabeled("Select", until: app.labeled("0 selected"))
        app.tapLabeled("Select all", until: app.labeled("2 selected"))
        app.tapLabeled("Delete/done", until: app.webText("Delete 2 items?"))
        app.tapLabeled("Yes, delete")
        exists(app.webText("Deleted 2 items."))
        exists(app.webText("Inbox is empty. Anything you capture lands here."))
        // With nothing to sort, the tab drops its count.
        exists(app.webButton("Inbox"))
        app.tapLabeled("Undo", until: app.labeled("Inbox, 2 to sort"))

        // And one item made a one off.
        app.tapLabeled("Select", until: app.labeled("0 selected"))
        app.tapLabeled("Fix the gate", until: app.labeled("1 selected"))
        app.tapLabeled("Make one offs")
        exists(app.webText("Made 1 one off."))
        exists(app.labeled("Inbox, 1 to sort"))

        // Each landed where it was sent: the project's tasks under its Done, which opens folded, and the one off.
        app.tapWeb("Goals", until: app.webButton(startingWith: "Learn to bake bread"))
        app.tapWeb(startingWith: "Learn to bake bread")
        app.tapWeb(startingWith: "Bake a sourdough loaf")
        app.tapWeb(anyStartingWith: "Done tasks")
        exists(app.webButton(startingWith: "Edit task Call the bank"))
        exists(app.webButton(startingWith: "Edit task Buy stamps"))
        app.open("One offs")
        exists(app.labeled("Fix the gate done"))
    }

    func testCapturesAddDetailsOpenWithTimeFirstThenSendADescribedTaskToAMilestoneWithSaveInReach() {
        let app = launchApp(seed: "Seed plan")
        let field = app.page.textFields["Capture to Inbox"]
        app.tapLabeled("Capture a task", until: field)
        app.type("Draft the summary", into: field)
        let time = app.page.sliders["Time"]
        app.tapLabeled("Add details", until: time)
        pick("Bake a sourdough loaf", in: "Send to", of: app)
        pick("A starter that rises", in: "Milestone", of: app)
        // The field's label says where it saves.
        let sending = app.page.textFields["Capture to Bake a sourdough loaf, A starter that rises"]
        exists(sending)

        // Time comes first, right under the name, then where it goes, then the description.
        let notes = app.page.textViews["Description"]
        exists(notes)
        let tops = [time, last("Send to", in: app), last("Milestone", in: app), notes].map(\.frame.minY)
        XCTAssertTrue(zip(tops, tops.dropFirst()).allSatisfy { $0 < $1 }, "Time, Send to, Milestone and Description are not in that order, at \(tops)")

        app.type("Use the ", into: notes)
        app.tapLabeled("Bold")
        app.typeText("rye")
        XCTAssertEqual(notes.value as? String, "Use the **rye**")
        // Save stays at the foot of the sheet, clear above the keyboard, with the details open.
        let save = app.webButton("Save")
        let keyboard = app.keyboards.element
        let inReach = NSPredicate { _, _ in save.isHittable && save.frame.maxY <= keyboard.frame.minY }
        let reached = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: inReach, object: nil)], timeout: patience) == .completed
        XCTAssertTrue(reached, "Save at \(save.frame) is not clear above the keyboard at \(keyboard.frame)")
        save.tap()
        exists(app.webText("Saved to Bake a sourdough loaf, A starter that rises"))
        gone(sending)

        // It's under the milestone, its description formatted.
        app.tapWeb("Goals", until: app.webButton(startingWith: "Learn to bake bread"))
        app.tapWeb(startingWith: "Learn to bake bread")
        app.tapWeb(startingWith: "Bake a sourdough loaf")
        app.tapLabeled("Edit task Draft the summary, No estimate, has details", until: app.labeled("Rename Draft the summary"))
        exists(app.webText("rye"))
    }

    /**
     * The last element in the page with a label, other than text. It finds a form control rather than its label's own
     * text, which WebKit can list under the same name, and a select after a button of its name, such as a new home's
     * Goal after the Goal it can make. It finds what a tap brought up rather than what brought it, such as Add to's
     * search field after its button, and Process's card rather than the Inbox behind it, which shows the same titles:
     * what's opened comes later in the page, whether or not iOS leaves the rest in the tree meanwhile.
     */
    private func last(_ label: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let text = [XCUIElement.ElementType.staticText.rawValue]
        let all = app.page.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND NOT (elementType IN %@)", label, text))
        exists(all.firstMatch, file: file, line: line)
        return all.element(boundBy: all.count - 1)
    }

    /// Adds to the end of a field that opens holding text, with its caret after the text. A tap, needed only where iOS
    /// didn't bring the keyboard up as the field took focus, goes where the text has ended, which keeps the caret there.
    private func typeAtEnd(_ text: String, of field: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        exists(field, file: file, line: line)
        let keyboard = app.keyboards.element
        if !keyboard.waitForExistence(timeout: 5) { field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap() }
        XCTAssertTrue(keyboard.waitForExistence(timeout: patience), "no software keyboard came up. On screen:\n\(app.debugDescription)", file: file, line: line)
        app.typeText(text)
    }

    /// Chooses in a select named by a visible label, as choose(_:in:) does in one named by its aria-label alone, since
    /// the label's own text can carry the same name.
    private func pick(_ option: String, in label: String, of app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let select = last(label, in: app, file: file, line: line)
        app.tap(select, file: file, line: line)
        let types = [XCUIElement.ElementType.button, .menuItem, .cell].map(\.rawValue)
        let item = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType IN %@", option, types)).firstMatch
        app.tap(item, file: file, line: line)
        reads(select, option, file: file, line: line)
    }

    /**
     * Sets a date on Process's card with iOS's own date picker, which a web date field opens, as a person does: a day of
     * the month it opens on, then Done or a tap outside to put it away, then Set date. The 15th, or the 16th when that's
     * today, which the picker has already picked: neither begins another day's number.
     */
    private func setADate(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let calendar = Calendar.current
        let now = Date()
        var parts = calendar.dateComponents([.year, .month], from: now)
        parts.day = calendar.component(.day, from: now) == 15 ? 16 : 15
        let day = calendar.date(from: parts)!
        let spoken = DateFormatter()
        spoken.setLocalizedDateFormatFromTemplate("MMMMd")
        let shown = DateFormatter()
        shown.locale = Locale(identifier: "en_US_POSIX")
        shown.dateFormat = "MMM d"
        // In the whole app rather than the page, since the picker is iOS's own. Its days read like "Sunday, November 15".
        let cell = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", spoken.string(from: day))).firstMatch

        app.tapLabeled("Add date", until: app.labeled("Set date"), file: file, line: line)
        // The field takes focus as the form opens, which opens the picker only where iOS allows it.
        if !cell.waitForExistence(timeout: 5) { app.tap(last("Date", in: app), file: file, line: line) }
        exists(cell, file: file, line: line)
        cell.tap()
        let done = app.buttons.matching(NSPredicate(format: "label == 'Done'")).firstMatch
        if done.exists {
            done.tap()
        } else if cell.exists {
            // Above the field, where the picker doesn't reach, and clear of the card's Exit.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.1)).tap()
        }
        gone(cell, file: file, line: line)
        app.tapLabeled("Set date", until: app.labeled("Change date, \(shown.string(from: day))"), file: file, line: line)
    }
}
