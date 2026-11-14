import XCTest

/// Plan the week and stretch planning, through the real app. Weekly planning goes from its Inbox straight to Schedule by
/// its step, past Pick tasks, which is being rebuilt.
final class PlanningUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testPlanningNextWeekSortsTheInboxIntoThePlanMovesATaskToAnotherDayAndTakesOneOutWithUndo() {
        let app = openPlanningNextWeek()

        // Inbox: the item goes to a project and, with the toggle, into the plan being made.
        let addTo = app.labeled(startingWith: "Add to a project or One offs")
        app.tapWeb("Process 1 item", until: addTo)
        app.tapLabeled(startingWith: "Add to the plan for ", until: app.labeled(startingWith: "Adding to the plan for "))
        app.tap(addTo)
        app.tapWeb(anyStartingWith: "Bake a sourdough loaf")
        exists(app.labeled("Inbox is empty."))

        // Straight to Schedule by its step, past Pick tasks, which is being rebuilt. The practice's session is already
        // placed, so it counts as one of the four, with the item from the Inbox.
        let summary = { (placed: Int, of: Int) in app.labeled("All picked tasks, \(placed) of \(of) placed") }
        app.tapWeb("Schedule", until: summary(1, 4))

        // All tasks has the item sorted from the Inbox, and takes a task out of this week only after a check, with Undo.
        // Its toast lasts five seconds, so Undo follows its text at once; the count shows the task back.
        let removeShape = app.labeled("Remove Shape the loaf from this week")
        app.tap(summary(1, 4), until: removeShape)
        exists(app.webButton(startingWith: "Buy rye flour"))
        app.tap(removeShape, until: app.labeled("Remove"))
        app.tapLabeled("Remove", until: app.labeled("Removed Shape the loaf from this week."))
        app.tapLabeled("Undo", until: summary(1, 4))

        // Mix the dough, chosen from the list, waits at its best time. Compare days shows another day, Move to takes it
        // there, and Place here puts it on the week. It's the only two-hour task, so its time is the one ending (2h).
        app.tap(summary(1, 4), until: removeShape)
        app.tapWeb(startingWith: "Mix the dough")
        let mixAt = app.page.staticTexts.matching(NSPredicate(format: "label ENDSWITH '(2h)'")).firstMatch
        exists(mixAt)
        let day = dayName(days(nextMonday(), mixAt.label.hasPrefix("Sat") ? 6 : 5))
        // Compare days' days are switches, each named for its day, then how free it is: "Sat Nov 21, 15h free". The time
        // being placed starts the same way, as text.
        let pressable = [XCUIElement.ElementType.switch, .toggle, .button].map(\.rawValue)
        let strip = app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ AND elementType IN %@", "\(day), ", pressable)).firstMatch
        app.tap(strip, until: app.labeled("Move to \(day)"))
        app.tapLabeled("Move to \(day)", until: app.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH '(2h)'", "\(day), ")).firstMatch)
        app.tapLabeled("Place here", until: summary(2, 4))
    }

    func testAMovedPracticeSessionAsksAboutFutureWeeksThenPlaceTheRestAndReviewFinishPlanningNextWeek() {
        let app = openPlanningNextWeek()
        let summary = { (placed: Int, of: Int) in app.labeled("All picked tasks, \(placed) of \(of) placed") }
        // Straight to Schedule by its step. The Inbox's item stays there, so the week has the two picks and the practice,
        // whose Monday session is placed already.
        app.tapWeb("Schedule", until: summary(1, 3))

        // The practice chosen from All tasks selects its session, which the day brings into view below the strip, and
        // shows its rule in the dock.
        app.tap(summary(1, 3), until: app.webButton(startingWith: "Morning stretch"))
        app.tapWeb(startingWith: "Morning stretch")
        let rule = { (time: String) in app.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Practice, ' AND label ENDSWITH %@", "around \(time)")).firstMatch }
        exists(rule("7am"))
        // Dragged later on its day, it asks whether that's the time for future weeks too. Held on its left, clear of the
        // handle at its bottom right that changes its length.
        let session = app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Morning stretch.'")).firstMatch
        let from = session.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.3))
        from.press(forDuration: 0.3, thenDragTo: from.withOffset(CGVector(dx: 0, dy: 72)), withVelocity: .slow, thenHoldForDuration: 0.3)
        // The sheet's own name asks the same question without a time.
        let question = app.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Use ' AND label ENDSWITH ' in future weeks too?' AND label != 'Use this in future weeks too?'")).firstMatch
        exists(question)
        let time = String(question.label.dropFirst("Use ".count).dropLast(" in future weeks too?".count))
        app.tapLabeled("Yes, on Mondays", until: app.labeled("Morning stretch is now \(time) on Mondays."))
        exists(rule(time))

        // Place the rest puts the two picks at their suggested times.
        app.tap(summary(1, 3), until: app.labeled("Place the rest at suggested times"))
        app.tapLabeled("Place the rest at suggested times", until: app.labeled("Placed 2 blocks"))
        exists(summary(3, 3))

        // Review: no project has a weekly aim, so it's ready, and Finish plan closes planning with what it says.
        app.tapWeb("Continue to review", until: app.labeled("Ready to finish"))
        app.tapWeb("Finish plan", until: app.labeled(startingWith: "Week planned"))
    }

    func testPlanningTheNextStretchTakesAMilestoneInWithUndoTypesAnotherOnesDateFinishesThenChangesTheCadence() {
        let app = launchApp(seed: "Seed planning stretch")
        // The seed's block in two hours is the first the app reminds about, before planning's own.
        allowNotificationsIfAsked()
        let on = appToday()
        // Every six weeks, this stretch planned and ending in four days, so planning the next, 5 to 46 days out, is due.
        app.open("Plan")
        exists(app.labeled("This stretch: \(md(days(on, -37))) to \(md(days(on, 4))). Time to plan the next stretch."))
        app.tapWeb("Plan the next stretch")
        inFlow(step("Projects", in: app), reopenedBy: "Continue planning", in: app)
        app.tap(step("Projects", in: app), until: app.labeled("Add milestone Share a loaf to this plan"))

        // Share a loaf is due after the stretch. Its name takes it in, by the stretch's end, and the pinned Undo takes it
        // back out.
        let add = app.labeled("Add milestone Share a loaf to this plan")
        let takeOut = app.labeled("Take milestone Share a loaf out of this plan")
        app.tap(add, until: takeOut)
        app.tapLabeled(startingWith: "Undo: Added Share a loaf to this plan, ", until: add)
        gone(takeOut)
        app.tap(add, until: takeOut)

        // A date for Shape the first loaf, a day from its own so the picker shows it in the month it opens on.
        let due = days(on, 20)
        let moved = Calendar.current.isDate(days(on, 19), equalTo: due, toGranularity: .month) ? days(on, 19) : days(on, 21)
        app.tapLabeled(startingWith: "Change the date of Shape the first loaf, ", until: app.labeled("Set date"))
        pickDay(moved, field: "Date for Shape the first loaf", in: app)
        let dated = app.labeled("Undo: Shape the first loaf, \(md(moved)).")
        app.tapLabeled("Set date", until: dated)

        // Finish lists both changes with their Undo, then sets the plan, which the Plan page shows as the next.
        app.tap(step("Finish", in: app), until: app.labeled(containing: "Ready for "))
        exists(app.labeled(startingWith: "Undo: Added Share a loaf to this plan, "))
        exists(dated)
        // The toast goes on with the time planning's block freed.
        let next = "\(md(days(on, 5))) to \(md(days(on, 46)))"
        finish(app, until: app.labeled(startingWith: "Your plan for \(next) is set."))
        exists(app.labeled("Next plan, \(next)"))
        // Only the next plan holds Share a loaf: this stretch's has no milestones.
        exists(app.labeled("Share a loaf"))

        // The cadence changes in place, from the end of this stretch.
        app.tapWeb("Change planning cadence", until: app.labeled("In"))
        app.choose("Months", in: "In")
        // Its toast is plain, so it goes after three and a half seconds: it's read first, then the cadence it set.
        app.tapWeb("Save", until: app.labeled("Your new cadence starts \(md(days(on, 5)))."))
        exists(app.labeled("Every 6 months"))
    }

    func testWithNothingPlannedPlanningIsPlacedByHandThenTheFirstStretchIsPlannedFromTodayWithAGoalAddedAndUndone() {
        let app = launchApp(seed: "Seed planning nothing planned")
        // The seed's block in two hours is the first the app reminds about.
        allowNotificationsIfAsked()
        let on = appToday()

        // Choose another time takes planning to Week, where it waits at the best time until Place here.
        app.open("Week")
        app.tapLabeled("Choose a time to plan this week", until: app.labeled("When will you plan this week?"))
        app.tapLabeled("Choose another time", until: app.labeled(startingWith: "Placing Plan the week of "))
        // The toast says it's scheduled. Its Undo, at once since it lasts five seconds, brings back the prompt, which a
        // planning block hides whether it's still to come or, on a week's last day, already under way.
        app.tapLabeled("Place here", until: app.labeled(startingWith: "Planning scheduled for "))
        app.tapLabeled("Undo")
        exists(app.labeled("Choose a time to plan this week"))

        // Never planned, the first stretch runs from today to the end of this calendar quarter.
        let first = "\(md(on)) to \(md(quarterEnd(on)))"
        app.open("Plan")
        app.tapWeb("Plan your first stretch")
        inFlow(step("Practices", in: app), reopenedBy: "Continue planning", in: app)
        exists(app.labeled(containing: "Your first stretch"))
        exists(app.labeled(containing: first))

        // Add makes a goal from another step, and its pinned Undo takes it back.
        app.tap(step("Practices", in: app), until: app.labeled("Add a goal, practice, project or Inbox task"))
        app.tapLabeled("Add a goal, practice, project or Inbox task", until: app.labeled("Goal"))
        let name = app.page.textFields["New goal"]
        app.tapLabeled("Goal", until: name)
        app.type("Keep fit\n", into: name)
        let undo = app.labeled("Undo: Added goal Keep fit.")
        exists(undo)
        app.tap(step("Goals", in: app), until: app.labeled("Keep fit"))
        app.tap(undo)
        gone(app.labeled("Keep fit"))
        exists(app.labeled("Learn to bake bread"))

        // Finish sets it. Planned once, the Plan page no longer offers a first stretch; whether the next is due yet
        // depends on how near the quarter's end today is.
        app.tap(step("Finish", in: app), until: app.labeled(containing: "Ready for "))
        finish(app, until: app.labeled(startingWith: "Your plan for \(first) is set."))
        exists(app.page.buttons.matching(NSPredicate(format: "label == 'Plan now' OR label == 'Plan the next stretch'")).firstMatch)
        gone(app.webButton("Plan your first stretch"))
    }
}

// The helpers are members, so they never clash with a helper of the same name in another test file.
private extension PlanningUITests {
    /// Week, then next week's Plan next week, which starts planning with a block from now and opens it on the Inbox.
    func openPlanningNextWeek(file: StaticString = #filePath, line: UInt = #line) -> XCUIApplication {
        let app = launchApp(seed: "Seed planning next week")
        // The seed's block in two hours is the first the app reminds about, before planning's own.
        allowNotificationsIfAsked()
        // Next week, since every one of its days is still ahead whatever weekday the seeded clock lands on.
        app.open("Week", file: file, line: line)
        app.tap(app.webButton("Next week"), until: app.webButton("Plan next week"), file: file, line: line)
        app.tapWeb("Plan next week", file: file, line: line)
        inFlow(app.webButton("Process 1 item"), reopenedBy: "Plan next week", in: app, file: file, line: line)
        return app
    }

    /**
     * Waits for something in a planning flow, just opened. On CI's iOS 26 the tree can keep a flow's region as XCUITest
     * first read it, empty while the flow loads its data, as it does Today's (onToday): stretch planning opened straight
     * from Plan now showed its region bare for a minute in two runs, while planning opened by a Start, which writes its
     * block before the flow opens, came in every time. Should it stay empty, Save and exit, tapped where every flow
     * draws it at the top left since the tree has nothing of the flow to find it by, and opening planning again gives a
     * new region.
     */
    func inFlow(_ element: XCUIElement, reopenedBy reopen: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        if element.waitForExistence(timeout: 10) { return }
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 69, dy: 89)).tap()
        app.tapWeb(reopen, file: file, line: line)
        exists(element, file: file, line: line)
    }

    /// A step of stretch planning, which goes on with ", done" once finished, or with what it holds.
    func step(_ name: String, in app: XCUIApplication) -> XCUIElement {
        app.page.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", name, "\(name), ")).firstMatch
    }

    /// Finish in the dock on stretch planning's last step. The step's own tab, also Finish, comes first.
    func finish(_ app: XCUIApplication, until effect: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        let dock = app.page.buttons.matching(NSPredicate(format: "label == 'Finish'")).element(boundBy: 1)
        app.tap(dock, until: effect, file: file, line: line)
    }

    /**
     * Sets a web date field in iOS's own date picker. Its form focuses the field as it opens, which can bring the picker up
     * by itself; otherwise a tap on the field does, the last element of that name, after the form and its label. The
     * calendar opens on the field's month, so the day asked for is in it. A picker still up after the day is chosen
     * covers the page until it's closed.
     */
    func pickDay(_ day: Date, field: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let picker = app.datePickers.firstMatch
        if !picker.waitForExistence(timeout: 5) {
            app.page.descendants(matching: .any).matching(NSPredicate(format: "label == %@", field)).allElementsBoundByIndex.last?.tap()
        }
        exists(picker, file: file, line: line)
        let wheels = picker.pickerWheels
        if wheels.count >= 3 {
            for (i, value) in [formatted(day, "MMMM"), formatted(day, "d"), formatted(day, "yyyy")].enumerated() {
                wheels.element(boundBy: i).adjust(toPickerWheelValue: value)
            }
        } else {
            // A day reads as "Friday, November 20"; the word boundaries keep November 2 from matching November 20.
            let cell = picker.descendants(matching: .any).matching(NSPredicate(format: "label MATCHES %@", ".*\\b\(formatted(day, "MMMM d"))\\b.*")).firstMatch
            exists(cell, file: file, line: line)
            cell.tap()
        }
        // The picker hides the page from the tree, so it's closed by its toolbar's Done, or a tap above it, as GoalsUITests
        // closes it: a tap outside the picker only puts it away.
        let done = app.toolbars.buttons["Done"]
        if done.exists {
            done.tap()
        } else if picker.exists {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        }
        gone(picker, file: file, line: line)
    }

    /// The seeded app's today: its clock runs from the next 10am (launchApp).
    func appToday() -> Date {
        Calendar.current.startOfDay(for: Date().addingTimeInterval(morningShift(now: Date())))
    }

    func days(_ day: Date, _ count: Int) -> Date {
        Calendar.current.date(byAdding: .day, value: count, to: day)!
    }

    /// The Monday after the app's today, which starts next week.
    func nextMonday() -> Date {
        let today = appToday()
        let fromMonday = (Calendar.current.component(.weekday, from: today) + 5) % 7
        return days(today, 7 - fromMonday)
    }

    /// The last day of the calendar quarter a day is in.
    func quarterEnd(_ day: Date) -> Date {
        let calendar = Calendar.current
        var parts = calendar.dateComponents([.year, .month], from: day)
        parts.month = (parts.month! - 1) / 3 * 3 + 1
        parts.day = 1
        let start = calendar.date(from: parts)!
        return days(calendar.date(byAdding: .month, value: 3, to: start)!, -1)
    }

    func formatted(_ day: Date, _ format: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = format
        return formatter.string(from: day)
    }

    /// 'Nov 16', as the app writes a date.
    func md(_ day: Date) -> String { formatted(day, "MMM d") }

    /// 'Mon Nov 16', as the app names a day.
    func dayName(_ day: Date) -> String { formatted(day, "EEE MMM d") }
}
