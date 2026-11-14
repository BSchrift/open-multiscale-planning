import XCTest

/// Week, through the real app.
final class WeekUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testWeekStepsToOtherWeeksThenABlockNextWeekMovesToAnotherDayAndIsRemovedWithUndo() {
        // Read before the launch, which shifts the app's clock to the same 10am.
        let today = appToday()
        let monday = monday(of: today)
        let app = launchApp(seed: "Seed week")
        // The seed's blocks to come are something to remind about.
        allowNotificationsIfAsked()

        app.tapWeb("Week", until: app.webButton("Previous week"))
        exists(app.labeled("This week"))
        exists(app.labeled(weekLabel(monday)))
        app.tapWeb("Previous week", until: app.labeled("Past week"))
        exists(app.labeled(weekLabel(shifted(monday, days: -7))))
        exists(app.labeled("Past weeks can be viewed but not changed."))
        // Only this week offers to edit its plan, so its tray says the week is back.
        app.tapLabeled("This week", until: app.labeled("Edit this week's plan"))
        exists(app.labeled(weekLabel(monday)))

        // Next week opens on its Monday, so the strip picks Tuesday, which holds the block.
        let next = shifted(monday, days: 7)
        let tuesday = written(shifted(next, days: 1), "EEE MMM d")
        let thursday = written(shifted(next, days: 3), "EEE MMM d")
        app.tapWeb("Next week", until: app.labeled(weekLabel(next)))
        app.tap(stripDay(tuesday, in: app), until: app.labeled(tuesday))
        let block = app.labeled(startingWith: "Shape the dough, 9am to 10am")
        app.tap(block, until: app.labeled("Move"))
        exists(app.labeled("Remove"))

        // Moved to Thursday at the same time, which is free there.
        app.tapLabeled("Move", until: app.labeled("Moving Shape the dough, 1h, from Tue 9am"))
        app.tap(stripDay(thursday, in: app), until: app.labeled(thursday))
        app.tapLabeled("Move here", until: app.labeled("Moved Shape the dough to \(thursday), 9am"))
        exists(app.labeled(thursday))
        exists(block)
        app.tap(stripDay(tuesday, in: app), until: app.labeled(tuesday))
        gone(block)

        // Removed from Thursday, then put back by Undo.
        app.tap(stripDay(thursday, in: app), until: block)
        app.tap(block, until: app.labeled("Remove"))
        app.tapLabeled("Remove", until: app.labeled("Removed Shape the dough"))
        gone(block)
        app.tapLabeled("Undo", until: block)

        app.tapLabeled("This week", until: app.labeled("Edit this week's plan"))
        exists(app.labeled(weekLabel(monday)))
    }

    func testPickedWorkWaitsAboveTheWeekASuggestionPlacesItWithUndoThenEditingAddsATaskFromTheDrawer() {
        let app = launchApp(seed: "Seed week")
        allowNotificationsIfAsked()
        app.tapWeb("Week", until: app.webButton("Previous week"))
        // Its own label, since the block it becomes is a button too.
        let card = app.page.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Mix the dough, ' AND label ENDSWITH ', to schedule'")).firstMatch
        exists(card)

        // The first suggestion, as "1 · Sat 9am to 9:30am", says where the toast and the day's row will say it went,
        // whichever day it picks. Its times tell it from the lane's count, "1 · 30m".
        let suggestion = app.page.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS ' to '", "1 · ")).firstMatch
        app.tap(card, until: suggestion)
        let (day, times) = suggested(suggestion.label)
        let start = times.prefix { $0 != " " }
        let placed = app.page.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH %@", "Placed Mix the dough, \(day) ", ", \(start)")).firstMatch
        app.tap(suggestion, until: placed)
        // The toast's Undo lasts five seconds, so it's pressed at once, and the place is checked on a second one.
        app.tapLabeled("Undo", until: card)

        app.tap(card, until: suggestion)
        let again = suggested(suggestion.label).times
        // Placing shows the day it went to, where it's a row.
        app.tap(suggestion, until: app.labeled(startingWith: "Mix the dough, \(again)"))
        gone(card)

        app.tapLabeled("Edit this week's plan", until: app.labeled("Editing this week"))
        app.tapLabeled("Add a task", until: app.labeled("Add to this week"))
        // Each offer reads its day and time, as "Fri Nov 13, 11am", then a note. The task's row goes on with the time
        // it needs.
        let offer = app.page.descendants(matching: .any)
            .matching(NSPredicate(format: "label MATCHES %@", "(?s)\(offerPattern).*")).firstMatch
        app.tapLabeled(startingWith: "Clean the banneton", until: offer)
        let at = String(offer.label[offer.label.range(of: offerPattern, options: .regularExpression)!])
        app.tap(offer, until: app.labeled("Placed Clean the banneton, \(at)"))
        gone(app.labeled("Add to this week"))
        // While editing, a block is a slider named for its task.
        exists(app.labeled(startingWith: "Clean the banneton."))

        app.tapLabeled("Done editing", until: app.labeled("Edit this week's plan"))
        exists(app.labeled("This week"))
    }
}

/// The start of an offer's label: its day, then its time.
private let offerPattern = "^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [0-9]{1,2}, [0-9]{1,2}(:[0-9]{2})?(am|pm)"

/// A suggestion's day and times: "1 · Fri 10:30am to 11am" gives "Fri" and "10:30am to 11am".
private func suggested(_ label: String) -> (day: String, times: String) {
    let words = label.split(separator: " ", maxSplits: 3).map(String.init)
    XCTAssertEqual(words.count, 4, "the suggestion reads \(label)")
    return (words[2], words[3])
}

/// A day of Week's strip. Its label goes on with its free time and hints, as "Tue Nov 17, 11h free", while the day's own
/// heading is the day alone.
private func stripDay(_ day: String, in app: XCUIApplication) -> XCUIElement { app.labeled(startingWith: day + ", ") }

/// The seeded app's date: its clock runs from the next 10am (launchApp), so this is read just before the launch.
private func appToday() -> Date {
    let now = Date()
    return now.addingTimeInterval(morningShift(now: now))
}

private func shifted(_ date: Date, days: Int) -> Date { Calendar.current.date(byAdding: .day, value: days, to: date)! }

/// The Monday of a date's week, where the app's weeks start.
private func monday(of date: Date) -> Date { shifted(date, days: -((Calendar.current.component(.weekday, from: date) + 5) % 7)) }

/// A date as the app writes it, in English whatever the Simulator's language: "Tue Nov 17" is EEE MMM d.
private func written(_ date: Date, _ format: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = format
    return formatter.string(from: date)
}

/// The line over Week's title: "Nov 16 to Nov 22".
private func weekLabel(_ monday: Date) -> String { "\(written(monday, "MMM d")) to \(written(shifted(monday, days: 6), "MMM d"))" }
