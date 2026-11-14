import XCTest

/// Goals, projects, milestones, practices and one offs, through the real app.
final class GoalsUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testANewGoalsProjectIsSetUpFinishedAfterAskingAndRestoredThenTheGoalIsRenamedAndDeletedWithUndo() {
        let app = launchApp(seed: "Seed plan")
        let newGoal = app.page.textFields["New goal"]
        app.tapWeb("Goals")
        onTab("Goals", app.webButton(startingWith: "Learn to bake bread"), in: app)
        app.tapWeb("+ New goal", until: newGoal)
        app.type("Write a book\n", into: newGoal)

        let name = app.page.textFields["Name"]
        app.tapLabeled(startingWith: "Write a book", until: app.webButton("+ Project"))
        app.tapWeb("+ Project", until: name)
        app.type("Draft chapters\n", into: name)
        // It ends where the stretch it was added in ends.
        exists(app.labeled(startingWith: "Project added, "))
        app.tapWeb(startingWith: "Draft chapters")

        // Project settings change nothing on Cancel: the goal picked here stays unsaved, as the warning before the goal
        // is deleted shows. A new name saves from the keyboard.
        app.tapLabeled("Project settings", until: name)
        app.pickOption("Learn to bake bread", in: "Goal", showing: "Write a book")
        app.tapWeb("Cancel")
        gone(name)
        app.tapLabeled("Project settings", until: name)
        app.replaceText(in: name, with: "Draft ten chapters\n")
        exists(app.webText("Saved Draft ten chapters."))

        // Drop and Finish each ask first.
        app.tapLabeled("Project settings", until: name)
        app.tapWeb("Drop")
        app.tapWeb("Cancel dropping")
        app.tapWeb("Finish")
        app.tapWeb("Yes, finish", until: app.webText("Finished. Open tasks cancelled."))
        // Finished, it leaves its page for Goals, where it waits under Archived.
        let restore = app.webButton("Restore Draft ten chapters")
        app.tapWeb("Archived (1)", until: restore)
        app.tap(restore, until: app.webText("Draft ten chapters restored."))

        // Back on Goals as it was left, the goal still open.
        let goalName = app.page.textFields["Goal name"]
        app.tapWeb("Rename Write a book", until: goalName)
        app.replaceText(in: goalName, with: "Write two books\n")
        exists(app.webText("Renamed to Write two books."))

        // Deleting asks first, naming what goes with it, and Undo brings it all back.
        app.tapWeb("Rename Write two books", until: goalName)
        app.tapWeb("Delete goal", until: app.labeled("1 project: Draft ten chapters, with 0 milestones and 0 tasks"))
        app.tapWeb("Yes, delete", until: app.webText("Deleted Write two books."))
        app.tapWeb("Undo")
        exists(app.webButton(startingWith: "Write two books"))
        exists(app.webButton(startingWith: "Draft ten chapters"))
    }

    func testAnOverdueMilestoneIsAnsweredWithUndoThenItsProjectTakesATaskAndAMilestoneAndTheTaskMovesThereWithUndo() {
        let app = launchApp(seed: "Seed goals overdue")
        // Closed, the goal shows the project that needs it.
        let goal = app.page.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Learn to bake bread' AND label CONTAINS 'Overdue'")).firstMatch
        app.tapWeb("Goals")
        onTab("Goals", goal, in: app)
        app.tap(goal, until: app.webButton(startingWith: "Bake a sourdough loaf"))
        app.tapWeb(startingWith: "Bake a sourdough loaf")

        // A week past its date with a task still open, the milestone asks what to do. Marking it done is undone from the
        // project's line of changes.
        let question = app.labeled(startingWith: "Make a starter was due ")
        exists(question)
        exists(app.webText("1 of 2 tasks done, 2h left."))
        app.tapWeb("Mark 1 task done")
        exists(app.labeled(containing: "Marked Make a starter done, and ticked 1 task."))
        gone(question)
        app.tapWeb("Undo")
        exists(question)
        // Ticking its last open task answers it too. The toast's Undo is tapped at once, before the toast times out.
        app.tapLabeled("Feed the starter done", until: app.webText("Completed Feed the starter."))
        app.tapWeb("Undo")
        exists(question)

        // Return adds the task and keeps the sheet open for the next, its title focused, so the keyboard goes before
        // Done, which it covers.
        let title = app.page.textFields["Title"]
        app.tapLabeled("Add task to Make a starter", until: title)
        app.type("Proof the dough\n", into: title)
        exists(app.webText("Added Proof the dough."))
        app.hideKeyboard()
        app.tapWeb("Done")
        let task = app.labeled("Edit task Proof the dough, 1h")
        exists(task)

        // A new milestone needs a date, from the system's calendar.
        let name = app.page.textFields["Name"]
        app.tapWeb("+ Milestone", until: name)
        app.type("First loaf", into: name)
        app.hideKeyboard()
        app.pickFifteenthOfNextMonth(for: app.control(labeled: "Due date"))
        app.tapWeb("Add")
        exists(app.webText("Added First loaf."))
        app.hideKeyboard()
        app.tapWeb("Done")
        exists(app.labeled("Edit milestone First loaf, due \(appDate(nextFifteenth))"))

        // The task's popup moves it there, into a milestone that stays folded, so the task shows again only with Undo.
        app.tap(task, until: app.webButton("Rename Proof the dough"))
        app.pickOption("Bake a sourdough loaf, First loaf", in: "Belongs to", showing: "Bake a sourdough loaf, Make a starter")
        app.tapWeb("Save")
        exists(app.webText("Moved Proof the dough to Bake a sourdough loaf, First loaf."))
        app.tapWeb("Undo")
        exists(task)
    }

    func testAPracticeWithNoGoalKeepsFridayAtItsOwnTimeWhenReopenedThenLinksToAGoalWithUndo() {
        let app = launchApp(seed: "Seed goals practice")
        let noGoal = app.webButton("Practices with no goal")
        let weekdays = app.webButton("Weekdays")
        app.tapWeb("Goals")
        onTab("Goals", noGoal, in: app)
        app.tap(noGoal, until: app.labeled(startingWith: "Stretch"))
        app.tapLabeled(startingWith: "Stretch", until: weekdays)

        // Monday, Tuesday and Friday, then Friday at 9:30 from the system's time picker.
        weekdays.tap()
        for day in ["Wednesday", "Thursday"] { app.tapLabeled(day) }
        let days = app.labeled("Time on each day")
        app.tapLabeled("Different time on some days", until: days)
        app.pickTime(hour: "9", minute: "30", for: app.control(labeled: "Friday", in: days))
        // The summary as VoiceOver reads it.
        let summary = app.webText("Summary: 15 minutes on Monday and Tuesday around 7 AM, Friday around 9:30 AM")
        exists(summary)
        app.tapWeb("Save")
        exists(app.webText("Saved Stretch: 15m on Mon and Tue around 7am, Fri around 9:30am."))

        app.tapLabeled(startingWith: "Stretch", until: weekdays)
        exists(summary)
        exists(app.labeled("Use the usual time, 7 AM, on Friday"))

        // Linked to a goal, it moves under it, so the place for practices with no goal goes. The toast's Undo is tapped
        // at once, before it times out, and keeps that place; linked again, the place goes.
        app.pickOption("Run a 10k", in: "Goal", showing: "No goal")
        app.tapWeb("Save")
        exists(app.webText("Saved Stretch."))
        app.tapWeb("Undo")
        exists(noGoal)
        app.tapLabeled(startingWith: "Stretch", until: weekdays)
        app.pickOption("Run a 10k", in: "Goal", showing: "No goal")
        app.tapWeb("Save")
        gone(noGoal)
    }

    func testOneOffsAreAddedThreeWaysAWeeklyOneKeepsItsDaysWhenChangedAndOneIsDatedInPlaceThenTickedDoneWithUndo() {
        let app = launchApp(seed: "Seed plan")
        app.tapWeb("More", until: app.webButton(startingWith: "One offs"))
        app.tapLabeled(startingWith: "One offs", until: app.webButton("Add one off"))

        // Each from the sheet, which takes the title first; the row says how it repeats, then its time.
        let title = app.page.textFields["Title"]
        app.tapWeb("Add one off", until: title)
        app.type("Tidy the shed\n", into: title)
        gone(title)
        exists(app.webText("No date, 30m"))
        app.addOneOff("Wash the car", repeats: "In certain months") {
            app.tapLabeled("April")
            app.tapLabeled("October")
        }
        exists(app.labeled(startingWith: "In April and October, next in "))
        app.addOneOff("Put the bins out", repeats: "On a regular schedule") {
            app.tapWeb("Weekdays")
            for day in ["Tuesday", "Wednesday", "Friday"] { app.tapLabeled(day) }
        }
        exists(app.labeled(startingWith: "Weekly on Mon and Thu, next "))

        // Its form opens on its days, ticked, and a change saved from it keeps them. The form opens in the list, where
        // its days sit low enough for the tab bar to cover them, so the change is to its title, near the top, and Return
        // saves it.
        let monday = app.labeled("Monday")
        app.tapLabeled("Change repeat for Put the bins out", until: monday)
        reads(monday, "1")
        reads(app.labeled("Thursday"), "1")
        app.replaceText(in: title, with: "Put the recycling out\n")
        exists(app.webButton("Put the recycling out"))
        exists(app.labeled(startingWith: "Weekly on Mon and Thu, next "))

        // Dated in place, from the system's calendar, which the field opens as it takes focus.
        let day = appDate(nextFifteenth)
        app.tapLabeled("Add date for Tidy the shed")
        app.pickFifteenthOfNextMonth(for: app.control(labeled: "Date"), focusedOnOpen: true)
        app.tapWeb("Set date")
        exists(app.webText("Tidy the shed, \(day)."))
        exists(app.labeled("Change date for Tidy the shed"))
        exists(app.webText("\(day), 30m"))

        // Ticked, it goes until the toast's Undo, tapped at once, brings it back.
        let tick = app.labeled("Tidy the shed done")
        app.tap(tick, until: app.webText("Completed Tidy the shed."))
        app.tapWeb("Undo")
        exists(tick)
    }
}

/// The 15th of next month on the Simulator's own calendar, which WebKit's date picker opens on rather than the seeded
/// app's clock. That clock is at most a day ahead, so this date is after the app's today whatever the day.
private let nextFifteenth: Date = {
    let calendar = Calendar.current
    var parts = calendar.dateComponents([.year, .month], from: calendar.date(byAdding: .month, value: 1, to: Date())!)
    parts.day = 15
    return calendar.date(from: parts)!
}()

/// A date in English, "Dec 15" by default as the app writes it.
private func appDate(_ date: Date, _ pattern: String = "MMM d") -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = pattern
    return formatter.string(from: date)
}

private extension XCUIApplication {
    /// A control by its label. The text of a label around or beside a control has the control's name too, so it's left out.
    func control(labeled label: String, in scope: XCUIElement? = nil) -> XCUIElement {
        let text = NSNumber(value: XCUIElement.ElementType.staticText.rawValue)
        return (scope ?? page).descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType != %@", label, text)).firstMatch
    }

    /// A select by its label and the option it shows, which tells it from the text of its label.
    func select(_ label: String, showing option: String) -> XCUIElement {
        page.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND value == %@", label, option)).firstMatch
    }

    /// Chooses an option of a select, as choose(_:in:) does, finding the select by what it shows now.
    func pickOption(_ option: String, in label: String, showing current: String, file: StaticString = #filePath, line: UInt = #line) {
        tap(select(label, showing: current), file: file, line: line)
        let types = [XCUIElement.ElementType.button, .menuItem, .cell].map(\.rawValue)
        tap(descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType IN %@", option, types)).firstMatch, file: file, line: line)
        // The select shows what its screen holds, which takes the new option a moment after the tap.
        MultiscaleUITests.exists(select(label, showing: option), file: file, line: line)
    }

    /**
     * Replaces a field's text from the keyboard: a tap at the field's right end puts the caret after its text, and that
     * many deletes clear it. A return at the end of `text` submits the field's form. The keyboard types into the field
     * the tap focused, as type(_:into:) does.
     */
    func replaceText(in field: XCUIElement, with text: String, file: StaticString = #filePath, line: UInt = #line) {
        MultiscaleUITests.exists(field, file: file, line: line)
        let old = field.value as? String ?? ""
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        XCTAssertTrue(keyboards.element.waitForExistence(timeout: patience), "no software keyboard came up. On screen:\n\(debugDescription)", file: file, line: line)
        typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count) + text)
    }

    /**
     * Picks the 15th of next month in the calendar WebKit shows for a date field, then closes it. An empty field's
     * calendar opens on the Simulator's month, so it goes on a month first. A field that takes focus as it appears can
     * bring the calendar up itself.
     */
    func pickFifteenthOfNextMonth(for field: XCUIElement, focusedOnOpen: Bool = false, file: StaticString = #filePath, line: UInt = #line) {
        let picker = datePickers.firstMatch
        MultiscaleUITests.exists(field, file: file, line: line)
        if !(focusedOnOpen && picker.waitForExistence(timeout: 5)) { field.tap() }
        tap(picker.buttons["Next Month"], file: file, line: line)
        // A day reads with its weekday and month, in either order: "Tuesday, December 15" or "Tuesday 15 December".
        let month = appDate(nextFifteenth, "MMMM")
        let day = picker.buttons.matching(NSPredicate(format: "label MATCHES %@", ".*\\b(\(month) 15|15 \(month))\\b.*")).firstMatch
        tap(day, file: file, line: line)
        closeSystemPicker(file: file, line: line)
    }

    /// Sets the wheels WebKit shows for a time field to the hour and minute given, as the wheels read them, then closes them.
    func pickTime(hour: String, minute: String, for field: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        tap(field, file: file, line: line)
        let wheels = datePickers.firstMatch.pickerWheels
        MultiscaleUITests.exists(wheels.element(boundBy: 1), file: file, line: line)
        wheels.element(boundBy: 0).adjust(toPickerWheelValue: hour)
        wheels.element(boundBy: 1).adjust(toPickerWheelValue: minute)
        closeSystemPicker(file: file, line: line)
    }

    /// Closes the system's date or time picker by the Done in its toolbar, or else by a tap on the page above it.
    func closeSystemPicker(file: StaticString = #filePath, line: UInt = #line) {
        let picker = datePickers.firstMatch
        let done = toolbars.buttons["Done"]
        if done.exists {
            done.tap()
        } else if picker.exists {
            coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        }
        gone(picker, file: file, line: line)
    }

    /**
     * Puts the keyboard away by the Done in the bar above it. On the Simulator the keyboard covers the foot of a sheet
     * rather than lifting it, and a tap on a button under it lands on a key instead, typing into the field.
     */
    func hideKeyboard(file: StaticString = #filePath, line: UInt = #line) {
        let keyboard = keyboards.element
        guard keyboard.exists else { return }
        tap(toolbars.buttons["Done"], file: file, line: line)
        gone(keyboard, file: file, line: line)
    }

    /// Adds a one off from its sheet: the title, which takes focus, how it repeats, then whatever else `fill` sets.
    func addOneOff(_ title: String, repeats: String, then fill: () -> Void = {}, file: StaticString = #filePath, line: UInt = #line) {
        let field = page.textFields["Title"]
        tapWeb("Add one off", until: field, file: file, line: line)
        type(title, into: field, file: file, line: line)
        pickOption(repeats, in: "Repeats", showing: "Does not repeat", file: file, line: line)
        fill()
        tapWeb("Add one off", file: file, line: line)
        gone(field, file: file, line: line)
    }
}
