import XCTest

/// Plan the week and stretch planning, through the real app. Pick tasks is only passed through: it's being rebuilt, so
/// nothing here reads what it shows.
final class PlanningUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testPlanningNextWeekSortsTheInboxPlacesATaskOnAnotherDayKeepsAMovedPracticesTimeAndFinishes() {
        let app = launchApp(seed: "Seed planning next week")
        // The seed's block in two hours is the first the app reminds about.
        allowNotificationsIfAsked()
        // Next week, since every one of its days is still ahead whatever weekday the seeded clock lands on.
        let monday = nextMonday()
        app.open("Week")
        app.tap(app.webButton("Next week"), until: app.webButton("Plan next week"))
        app.tapWeb("Plan next week", until: app.webButton("Continue to picking tasks"))

        // Inbox: the item goes to a project and, with the toggle, into the plan being made.
        let addTo = app.labeled(startingWith: "Add to a project or One offs")
        app.tapWeb("Process 1 item", until: addTo)
        app.tapLabeled(startingWith: "Add to the plan for ", until: app.labeled(startingWith: "Adding to the plan for "))
        app.tap(addTo)
        app.tapWeb(anyStartingWith: "Bake a sourdough loaf")
        exists(app.labeled("Inbox is empty."))

        // Past Pick tasks, which the seed's picks leave nothing to do in, to Schedule. The practice's session is already
        // placed, so it counts as one of the four.
        let summary = { (placed: Int, of: Int) in app.labeled("All picked tasks, \(placed) of \(of) placed") }
        app.tapWeb("Continue to picking tasks", until: app.webButton("Continue to scheduling"))
        app.tapWeb("Continue to scheduling", until: summary(1, 4))

        // All tasks has the item sorted from the Inbox, and takes a task out of this week only after a check, with Undo.
        let removeShape = app.labeled("Remove Shape the loaf from this week")
        app.tap(summary(1, 4), until: removeShape)
        exists(app.webButton(startingWith: "Buy rye flour"))
        app.tap(removeShape, until: app.labeled("Cancel"))
        app.tapLabeled("Cancel")
        gone(app.labeled("Cancel"))
        app.tap(removeShape, until: app.labeled("Remove"))
        app.tapLabeled("Remove", until: app.labeled("Removed Shape the loaf from this week."))
        exists(summary(1, 3))
        app.tapLabeled("Undo", until: summary(1, 4))

        // Mix the dough, chosen from the list, waits at its best time. Compare days shows another day, Move to takes it
        // there, and Place here puts it on the week. It's the only two-hour task, so its time is the one ending (2h).
        app.tap(summary(1, 4), until: removeShape)
        app.tapWeb(startingWith: "Mix the dough")
        let mixAt = app.page.staticTexts.matching(NSPredicate(format: "label ENDSWITH '(2h)'")).firstMatch
        exists(mixAt)
        let day = dayName(days(monday, mixAt.label.hasPrefix("Sat") ? 6 : 5))
        let strip = { (day: String) in app.page.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", day)).firstMatch }
        app.tap(strip(day), until: app.labeled("Move to \(day)"))
        app.tapLabeled("Move to \(day)", until: app.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH '(2h)'", "\(day), ")).firstMatch)
        app.tapLabeled("Place here", until: summary(2, 4))

        // The practice's session on Monday, tapped, shows its rule in the dock; dragged later on its day, it asks whether
        // that's the time for future weeks too. Held on its left, clear of the handle at its bottom right that changes
        // its length.
        let mon = dayName(monday)
        app.tap(strip(mon), until: app.labeled(mon))
        let session = app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Morning stretch.'")).firstMatch
        let rule = { (time: String) in app.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Practice, ' AND label ENDSWITH %@", "around \(time)")).firstMatch }
        app.tap(session, until: rule("7am"))
        let from = session.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.3))
        from.press(forDuration: 0.3, thenDragTo: from.withOffset(CGVector(dx: 0, dy: 72)), withVelocity: .slow, thenHoldForDuration: 0.3)
        // The sheet's own name asks the same question without a time.
        let question = app.page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Use ' AND label ENDSWITH ' in future weeks too?' AND label != 'Use this in future weeks too?'")).firstMatch
        exists(question)
        let time = String(question.label.dropFirst("Use ".count).dropLast(" in future weeks too?".count))
        app.tapLabeled("Yes, on Mondays", until: app.labeled("Morning stretch is now \(time) on Mondays."))
        exists(rule(time))

        // Place the rest puts the other two at their suggested times.
        app.tap(summary(2, 4), until: app.labeled("Place the rest at suggested times"))
        app.tapLabeled("Place the rest at suggested times", until: app.labeled("Placed 2 blocks"))
        exists(summary(4, 4))
        exists(app.labeled("All tasks are placed"))

        // Review: no project has a weekly aim, so it's ready, and Finish plan closes planning with what it says.
        app.tapWeb("Continue to review", until: app.labeled("Ready to finish"))
        app.tapWeb("Finish plan", until: app.labeled(startingWith: "Week planned"))
    }

    func testPlanningTheNextStretchTakesAMilestoneInWithUndoTypesAnotherOnesDateFinishesThenChangesTheCadence() {
        let app = launchApp(seed: "Seed planning stretch")
        let on = appToday()
        // Every six weeks from a week ago, this stretch planned: the next runs from 35 to 76 days out, not yet due.
        app.open("Plan")
        exists(app.labeled("This stretch: \(md(days(on, -7))) to \(md(days(on, 34))). Next planning: \(md(days(on, 27)))."))
        app.tapWeb("Plan now", until: step("Projects", in: app))
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
        let due = days(on, 50)
        let moved = Calendar.current.isDate(days(on, 49), equalTo: due, toGranularity: .month) ? days(on, 49) : days(on, 51)
        app.tapLabeled(startingWith: "Change the date of Shape the first loaf, ", until: app.labeled("Set date"))
        pickDay(moved, field: "Date for Shape the first loaf", in: app)
        let dated = app.labeled("Undo: Shape the first loaf, \(md(moved)).")
        app.tapLabeled("Set date", until: dated)

        // Finish lists both changes with their Undo, then sets the plan, which the Plan page shows as the next.
        app.tap(step("Finish", in: app), until: app.labeled(containing: "Ready for "))
        exists(app.labeled(startingWith: "Undo: Added Share a loaf to this plan, "))
        exists(dated)
        let next = "\(md(days(on, 35))) to \(md(days(on, 76)))"
        finish(app, until: app.labeled("Your plan for \(next) is set."))
        exists(app.labeled("Next plan, \(next)"))
        // Only the next plan holds Share a loaf: this stretch's has just its first milestone.
        exists(app.labeled("Share a loaf"))

        // The cadence changes in place, from the end of this stretch.
        app.tapWeb("Change planning cadence", until: app.labeled("In"))
        app.choose("Months", in: "In")
        app.tapWeb("Save", until: app.labeled("Every 6 months"))
        exists(app.labeled("Your new cadence starts \(md(days(on, 35)))."))
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
        let scheduled = app.labeled(startingWith: "Planning scheduled for ")
        app.tapLabeled("Place here", until: scheduled)
        // The line that takes the prompt's place names the time the toast does.
        let set = app.labeled(scheduled.label.replacingOccurrences(of: "Planning scheduled for ", with: "Planning is set for "))
        exists(set)
        app.tapLabeled("Undo")
        gone(set)
        exists(app.labeled("Choose a time to plan this week"))

        // Never planned, the first stretch runs from today to the end of this calendar quarter.
        let first = "\(md(on)) to \(md(quarterEnd(on)))"
        app.open("Plan")
        app.tapWeb("Plan your first stretch", until: step("Practices", in: app))
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
     * calendar opens on the field's month, so the day asked for is in it. A picker still up covers the page until a tap
     * outside it, beside Save and exit, where the flow shows only its dates.
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
        if picker.exists {
            app.webButton("Save and exit").coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5)).withOffset(CGVector(dx: 40, dy: 0)).tap()
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
