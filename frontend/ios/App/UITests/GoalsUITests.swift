import XCTest

/// Goals, projects, milestones, practices and one offs, through the real app.
final class GoalsUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    /// Project settings drop a change on Cancel and save a new name from the keyboard; Drop and Finish each ask first.
    func testANewGoalsProjectIsSetUpFinishedAfterAskingAndRestoredThenTheGoalIsRenamedAndDeletedWithUndo() {
        let app = launchApp(seed: "Seed plan")
        let newGoal = app.page.textFields["New goal"]
        app.tapWeb("Goals", until: app.webButton(startingWith: "Learn to bake bread"))
        app.tapWeb("+ New goal", until: newGoal)
        app.type("Write a book\n", into: newGoal)
        exists(app.webText("Added Write a book."))

        let name = app.page.textFields["Name"]
        app.tapLabeled(startingWith: "Write a book", until: app.webButton("+ Project"))
        app.tapWeb("+ Project", until: name)
        app.type("Draft chapters\n", into: name)
        // It ends where the stretch it was added in ends.
        exists(app.labeled(startingWith: "Project added, "))
        app.tapWeb(startingWith: "Draft chapters")
        exists(app.webText("Draft chapters"))

        app.tapLabeled("Project settings", until: name)
        app.pickOption("Learn to bake bread", in: "Goal", showing: "Write a book")
        app.tapWeb("Cancel")
        gone(name)
        app.tapLabeled("Project settings", until: name)
        exists(app.select("Goal", showing: "Write a book"))
        app.replaceText(in: name, with: "Draft ten chapters\n")
        exists(app.webText("Saved Draft ten chapters."))
        exists(app.webText("Draft ten chapters"))

        app.tapLabeled("Project settings", until: name)
        app.tapWeb("Drop", until: app.webText("Drop this project?"))
        app.tapWeb("Cancel dropping", until: app.webButton("Drop"))
        app.tapWeb("Finish", until: app.webText("Finish this project?"))
        app.tapWeb("Yes, finish", until: app.webText("Finished. Open tasks cancelled."))
        // Finished, it leaves its page for Goals, where it waits under Archived.
        let restore = app.webButton("Restore Draft ten chapters")
        app.tapWeb("Archived (1)", until: restore)
        app.tap(restore, until: app.webText("Draft ten chapters restored."))
        gone(restore)

        // Back on Goals as it was left, the goal still open.
        let goalName = app.page.textFields["Goal name"]
        let project = app.webButton(startingWith: "Draft ten chapters")
        exists(project)
        app.tapWeb("Rename Write a book", until: goalName)
        app.replaceText(in: goalName, with: "Write two books\n")
        exists(app.webText("Renamed to Write two books."))

        // Deleting asks first, naming what goes with it, and Undo brings it all back.
        let ask = app.labeled("Delete Write two books?")
        app.tapWeb("Rename Write two books", until: goalName)
        app.tapWeb("Delete goal", until: ask)
        exists(ask.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Draft ten chapters")).firstMatch)
        app.tapWeb("Yes, delete", until: app.webText("Deleted Write two books."))
        // The goal's row goes, with its name field still open in it.
        gone(goalName)
        gone(project)
        app.tapWeb("Undo")
        exists(app.webButton(startingWith: "Write two books"))
        exists(project)
    }

    func testAnOverdueMilestoneIsAnsweredWithUndoThenItsProjectTakesATaskAndAMilestoneAndTheTaskMovesThereWithUndo() {
        let app = launchApp(seed: "Seed goals overdue")
        // Closed, the goal shows the project that needs it.
        let goal = app.page.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Learn to bake bread' AND label CONTAINS 'Overdue'")).firstMatch
        app.tapWeb("Goals", until: goal)
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
        // Ticking its last open task answers it too, with Undo in the toast.
        app.tapLabeled("Feed the starter done", until: app.webText("Completed Feed the starter."))
        gone(question)
        app.tapWeb("Undo")
        exists(question)

        let title = app.page.textFields["Title"]
        app.tapLabeled("Add task to Make a starter", until: title)
        app.type("Proof the dough\n", into: title)
        exists(app.webText("Added Proof the dough."))
        app.tapWeb("Done")
        let task = app.labeled("Edit task Proof the dough, 1h")
        exists(task)

        // A new milestone needs a date, from the system's calendar.
        let name = app.page.textFields["Name"]
        app.tapWeb("+ Milestone", until: name)
        app.type("First loaf", into: name)
        app.pickFifteenthOfNextMonth(for: app.control(labeled: "Due date"))
        app.tapWeb("Add")
        exists(app.webText("Added First loaf."))
        app.tapWeb("Done")
        exists(app.labeled("Edit milestone First loaf, due \(appDate(nextFifteenth))"))

        // The task's popup moves it there, into a milestone that stays folded, so the task shows again only with Undo.
        app.tap(task, until: app.webButton("Rename Proof the dough"))
        app.pickOption("Bake a sourdough loaf, First loaf", in: "Belongs to", showing: "Bake a sourdough loaf, Make a starter")
        app.tapWeb("Save")
        exists(app.webText("Moved Proof the dough to Bake a sourdough loaf, First loaf."))
        gone(task)
        app.tapWeb("Undo")
        exists(task)
    }

    func testAPracticeWithNoGoalKeepsFridayAtItsOwnTimeWhenReopenedThenLinksToAGoalWithUndo() {
        let app = launchApp(seed: "Seed goals practice")
        let noGoal = app.webButton("Practices with no goal")
        let weekdays = app.webButton("Weekdays")
        app.tapWeb("Goals", until: noGoal)
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

        // Linked to a goal, it moves under it, so the place for practices with no goal goes until Undo.
        app.pickOption("Run a 10k", in: "Goal", showing: "No goal")
        app.tapWeb("Save")
        exists(app.webText("Saved Stretch."))
        gone(noGoal)
        app.tapWeb("Undo")
        exists(noGoal)
    }

    func testOneOffsOfEachKindAreAddedAWeeklyOneKeepsItsDaysWhenChangedAndOneIsDatedInPlaceThenTickedDoneWithUndo() {
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
        app.addOneOff("Test the doorbell", repeats: "By a calendar rule") {
            app.pickOption("Last", in: "Which", showing: "1st")
            app.pickOption("Weekday", in: "Day", showing: "Monday")
            app.pickOption("Quarter", in: "Of each", showing: "Month")
        }
        exists(app.labeled(containing: "on the last weekday, next "))
        app.addOneOff("Descale the kettle", repeats: "A set time after I last did it")
        exists(app.webText("6 weeks after last done, next after first done, 30m"))
        app.addOneOff("Service the boiler", repeats: "Within a flexible window")
        exists(app.labeled(startingWith: "Every 2 to 3 months, next between "))
        app.addOneOff("Put the bins out", repeats: "On a regular schedule") {
            app.tapWeb("Weekdays")
            for day in ["Tuesday", "Wednesday", "Friday"] { app.tapLabeled(day) }
        }
        exists(app.labeled(startingWith: "Weekly on Mon and Thu, next "))

        // Changed, it keeps its days, so Saturday joins Monday and Thursday.
        app.tapLabeled("Change repeat for Put the bins out", until: app.labeled("Saturday"))
        app.tapLabeled("Saturday")
        app.tapWeb("Save")
        exists(app.labeled(startingWith: "Weekly on Mon, Thu and Sat, next "))

        // Dated in place, from the system's calendar, which the field opens as it takes focus.
        let day = appDate(nextFifteenth)
        app.tapLabeled("Add date for Tidy the shed")
        app.pickFifteenthOfNextMonth(for: app.control(labeled: "Date"), focusedOnOpen: true)
        app.tapWeb("Set date")
        exists(app.webText("Tidy the shed, \(day)."))
        exists(app.labeled("Change date for Tidy the shed"))
        exists(app.webText("\(day), 30m"))

        // Ticked, it waits behind Show completed until Undo brings it back.
        let tick = app.labeled("Tidy the shed done")
        app.tap(tick, until: app.webText("Completed Tidy the shed."))
        exists(app.labeled("Show 1 completed in One offs"))
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
