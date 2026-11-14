import XCTest

/// Done, through the real app.
final class DoneUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testFromTodaysLineToDoneABlockNotMarkedYetIsMarkedFinishedWithUndoThenWeeksDayHeadingAndMoreOpenDone() {
        // Read before the launch, which shifts the app's clock to the same 10am.
        let today = appToday()
        let todayTitle = written(today, "EEEE, MMM d")
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: today)!
        let app = launchApp(seed: "Seed done")

        // Shape the dough's block ended with no answer, so Today asks about it first; it can wait for Done.
        app.tapLabeled("Answer later")
        gone(app.labeled("Answer later"))
        let line = app.labeled("Done today: 1 finished, 1h worked")
        onToday(line, in: app)
        // Today's own date line reads the same as Done's heading, so the back button says Done is open.
        app.tap(line, until: app.labeled("Back to Today"))
        exists(app.labeled(todayTitle))
        // The totals' bar, by kind of work: Feed the starter's hour.
        exists(app.labeled("1h projects"))
        exists(app.labeled("Not marked yet"))

        // The answer's toast keeps Undo for five seconds, so it's pressed at once.
        let mark = app.labeled("Mark how Shape the dough went")
        let finished = app.labeled("Finished: Shape the dough")
        app.tap(mark, until: finished)
        app.tap(finished, until: app.labeled("Shape the dough: finished."))
        app.tapLabeled("Undo", until: mark)
        exists(app.labeled("1h projects"))

        // Answered again, it leaves Not marked yet for the list, and its hour counts.
        app.tap(mark, until: finished)
        app.tap(finished, until: app.labeled("Shape the dough: finished."))
        gone(mark)
        gone(app.labeled("Not marked yet"))
        exists(app.labeled("2h projects"))
        exists(app.labeled("Shape the dough"))

        // A day back has nothing finished, and Next day comes back to today, the last day there is.
        app.tapLabeled("Previous day", until: app.labeled(written(yesterday, "EEEE, MMM d")))
        exists(app.labeled("Nothing finished on \(written(yesterday, "EEEE"))"))
        app.tapLabeled("Next day", until: app.labeled(todayTitle))
        XCTAssertFalse(app.labeled("Next day").isEnabled, "Next day goes past today")

        // Week's heading for the chosen day, today, opens Done on it.
        app.tapWeb("Week", until: app.webButton("Previous week"))
        let heading = app.labeled("Done on \(written(today, "EEE MMM d")): 2 finished")
        app.tap(heading, until: app.labeled("Back to Week"))
        exists(app.labeled(todayTitle))

        // Done lives under More, whose row says the day so far.
        app.tapWeb("More")
        app.tap(app.labeled(containing: "2 finished today, 2h worked"), until: app.labeled("Back to More"))
        exists(app.labeled(todayTitle))
    }
}

/// Analytics, through the real app.
final class AnalyticsUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testAnalyticsReadsAWeekMovesBetweenWeeksAndStopsSuggestingAPatternWithUndo() {
        let today = appToday()
        let monday = monday(of: today)
        let app = launchApp(seed: "Seed analytics")

        // More's row reads this week so far: this morning's two blocks, one done.
        app.tapWeb("More")
        app.tap(app.labeled(containing: "50% reliable this week, 1h of 2h so far"), until: app.labeled("Back to More"))
        exists(app.labeled("Analytics"))
        exists(app.labeled(weekLabel(monday)))
        exists(app.labeled("This week, so far"))
        exists(app.labeled("Learn to bake bread: 1h delivered of 2h planned"))
        exists(app.labeled("Project tasks: 1 done, 0 partly, 1 not done"))
        XCTAssertFalse(app.labeled("Next week").isEnabled, "Next week goes past this week")

        // Last week holds only its evening that didn't hold.
        app.tapLabeled("Previous week", until: app.labeled(weekLabel(Calendar.current.date(byAdding: .day, value: -7, to: monday)!)))
        exists(app.labeled("Past week"))
        exists(app.labeled("Project tasks: 0 done, 0 partly, 1 not done"))
        app.tapLabeled("Show each week's numbers", until: app.labeled("Hide each week's numbers"))

        // The same evening of the week failed in each of the last five weeks, so the stretch offers to stop suggesting it.
        let day = written(today, "EEEE")
        let pattern = app.labeled("\(day) evenings rarely hold: 0 of the last 5 blocks were done.")
        app.tapLabeled("This stretch", until: pattern)
        exists(app.labeled(startingWith: "This stretch, "))
        let avoided = app.labeled("\(day) evenings are no longer suggested.")
        app.tapLabeled("Stop suggesting them", until: app.labeled("Stopped suggesting those times."))
        exists(avoided)
        exists(app.labeled("Suggest them again"))
        gone(pattern)
        app.tapLabeled("Undo", until: pattern)
        gone(avoided)
        exists(app.labeled("Stop suggesting them"))
    }
}

/// The seeded app's date: its clock runs from the next 10am (launchApp), so this is read just before the launch.
private func appToday() -> Date {
    let now = Date()
    return now.addingTimeInterval(morningShift(now: now))
}

/// The Monday of a date's week, where the app's weeks start.
private func monday(of date: Date) -> Date {
    Calendar.current.date(byAdding: .day, value: -((Calendar.current.component(.weekday, from: date) + 5) % 7), to: date)!
}

/// A date as the app writes it, in English whatever the Simulator's language: "Friday, Nov 13" is EEEE, MMM d.
private func written(_ date: Date, _ format: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = format
    return formatter.string(from: date)
}

/// The line over Analytics' week: "Nov 9 to Nov 15".
private func weekLabel(_ monday: Date) -> String {
    "\(written(monday, "MMM d")) to \(written(Calendar.current.date(byAdding: .day, value: 6, to: monday)!, "MMM d"))"
}
