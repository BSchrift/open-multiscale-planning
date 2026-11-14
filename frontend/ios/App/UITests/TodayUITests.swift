import XCTest

/// Today, through the real app.
final class TodayUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testTheNowCardCountsDownFreesTheTimeWithUndoAndItsTimelineOpensAndMovesABlockAsACalendarOrAList() {
        let app = launchApp(seed: "Seed today now")
        allowNotificationsIfAsked()

        // WebKit gives "Now," and the block's times a line each.
        let now = app.labeled(startingWith: "Now,")
        onToday(now, in: app)
        app.tapLabeled("Start", until: app.webText("In progress, time left"))
        // The block began a minute before the seed and runs an hour, so under an hour is left, and it ticks.
        let timer = app.labeled("timer")
        exists(timer)
        let first = countdown(timer)
        XCTAssertNotNil(first.range(of: "^5[0-9]:[0-9]{2}$", options: .regularExpression), "the countdown reads \(first)")
        let ticking = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in countdown(timer) != first }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ticking], timeout: 10), .completed, "the countdown stayed at \(first)")

        // Mark done now frees the time until the next block, which the toast and the card name alike.
        let marked = app.labeled(startingWith: "Marked done")
        app.tapLabeled("Mark done now", until: marked)
        let free = app.webText("Free until \(words(of: marked, after: "free until ")). Next:")
        exists(free)
        app.tapLabeled("Undo", until: now)
        gone(free)
        exists(app.webText("In progress, time left"))

        // The task's name on the card opens its popup.
        app.tap(app.webButton("Mix the dough"), until: app.webButton("Rename Mix the dough"))
        app.tapLabeled("Close")
        gone(app.webButton("Rename Mix the dough"))

        // On the calendar a block still to come is a slider, which a tap opens.
        reads(app.labeled("Calendar"), "1")
        let shape = app.page.sliders.matching(NSPredicate(format: "label BEGINSWITH 'Shape the dough, '")).firstMatch
        let popup = app.webButton("Rename Shape the dough")
        app.tap(shape, until: popup)
        app.tapLabeled("Close")
        gone(popup)

        // Held, then dragged up an hour and a half at the calendar's 30 points an hour. The tap above brought it into
        // view, and up stays in view however near the bottom that left it. Wherever it lands, the toast says, and the
        // block reads the same.
        let before = shape.label
        let from = shape.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.3))
        from.press(forDuration: 0.8, thenDragTo: from.withOffset(CGVector(dx: 0, dy: -45)), withVelocity: .slow, thenHoldForDuration: 0.5)
        let moved = app.labeled(startingWith: "Shape the dough is now ")
        exists(moved)
        let to = words(of: moved, after: "is now ")
        exists(app.page.sliders.matching(NSPredicate(format: "label BEGINSWITH %@", "Shape the dough, \(to), ")).firstMatch)
        XCTAssertFalse(before.hasPrefix("Shape the dough, \(to), "), "the block stayed at \(to)")
        app.tapLabeled("Undo")
        exists(app.page.sliders.matching(NSPredicate(format: "label == %@", before)).firstMatch)

        // The list shows the same blocks as rows, none of them a slider, and a row opens its task too.
        app.tapLabeled("List")
        reads(app.labeled("List"), "1")
        gone(app.labeled("Zoom in"))
        gone(shape)
        exists(app.labeled(startingWith: "Mix the dough, "))
        app.tap(app.labeled(startingWith: "Shape the dough, "), until: popup)
        app.tapLabeled("Close")
        gone(popup)
        app.tapLabeled("Calendar", until: app.labeled("Zoom in"))
        exists(shape)
    }

    func testNotDoneWaitsInNeedsANewTimeToBePlacedAndSkippingABlockNotStartedSendsItToToScheduleUntilUndo() {
        let app = launchApp(seed: "Seed today")
        allowNotificationsIfAsked()

        // The block that ended half an hour ago asks first, then the one that began six minutes ago without a Start.
        exists(app.webText("Feed the starter"))
        app.tapLabeled("Not done", until: app.webText("Have you started Shape the dough?"))
        app.tapLabeled("Skip, choose a new time later", until: app.webText("Took Shape the dough off the calendar. It's in To schedule on Week."))
        let block = element(app, startingWith: "Shape the dough, ", endingWith: ". Now.")
        let card = element(app, startingWith: "Shape the dough, ", endingWith: ", to schedule")
        exists(card)
        gone(block)
        app.tapLabeled("Undo", until: block)
        gone(card)

        // Not done waits in Needs a new time, which offers its best time in one tap.
        app.tapLabeled(startingWith: "1 task needs a new time", until: app.webText("Not done today"))
        app.tapLabeled(startingWith: "Place Feed the starter, ", until: app.webText("Nothing needs a new time."))
        app.tapLabeled("Close")
        gone(app.webText("Nothing needs a new time."))
        gone(app.labeled(startingWith: "1 task needs a new time"))
        exists(element(app, startingWith: "Feed the starter, ", endingWith: ", Project. Not done."))
    }

    func testTheRingPausesAndResumesTheBlockUnderWayEachWithAToastWhoseUndoTakesItBack() {
        let app = launchApp(seed: "Seed soon")
        allowNotificationsIfAsked()
        let pause = app.labeled(startingWith: "Pause, ")
        onToday(pause, in: app)

        let key = app.webText("Tap the ring to pause the countdown")
        app.tapLabeled("What the ring means", until: key)
        app.tapLabeled("What the ring means")
        gone(key)

        // A toast with Undo goes after five seconds, so its Undo comes before anything else is checked.
        app.tap(pause, until: app.webText("Paused Proof the loaf"))
        exists(app.labeled(startingWith: "Resume, "))
        app.tapLabeled("Undo", until: pause)
        exists(app.webText("In progress, time left"))
        gone(app.labeled(startingWith: "Ends at"))

        app.tap(pause, until: app.labeled(startingWith: "Ends at"))
        let resumed = app.labeled(startingWith: "Resumed. It now ends at ")
        app.tap(app.labeled(startingWith: "Resume, "), until: resumed)
        // The block on the timeline ends where the toast says.
        let end = words(of: resumed, after: "ends at ")
        exists(app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Proof the loaf, ' AND label CONTAINS %@", " to \(end), ")).firstMatch)
        // Resume's Undo puts the pause back.
        app.tapLabeled("Undo", until: app.labeled(startingWith: "Ends at"))
        exists(app.labeled(startingWith: "Resume, "))
    }

    func testAPauseThatRanToTheEndAsksTheEndQuestionWhoseResumeRunsIntoTheNextBlockAndOffersTheShiftWithUndo() {
        // Seeded paused 22 minutes into a 50-minute block that ended ten minutes ago, so the pause ran to the end
        // without waiting for it.
        let app = launchApp(seed: "Seed today paused")
        allowNotificationsIfAsked()
        exists(app.labeled(startingWith: "22m spent. Paused at "))
        // A paused block can't still be going.
        XCTAssertFalse(app.labeled(startingWith: "Still going").exists, "a paused block offers Still going")

        // Resume gives back what was left, from now. The minutes spent hold for a minute after, unlike the percent.
        app.tapLabeled("Resume, 28m left", until: app.labeled(startingWith: "Pause, 22 minutes spent, "))
        let resumed = app.labeled(startingWith: "Resumed. It now ends at ")
        exists(resumed)
        let end = words(of: resumed, after: "ends at ")
        exists(app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Proof the loaf, ' AND label CONTAINS %@", " to \(end), ")).firstMatch)

        // That runs into the next block, and the shift moves it to start where the resumed one now ends.
        exists(app.webText("Bake the loaf conflicts with Proof the loaf."))
        let bake = app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Bake the loaf, '")).firstMatch
        exists(bake)
        let before = bake.label
        app.tapLabeled("Shift rest of today", until: app.labeled("Apply"))
        app.tapLabeled("Apply", until: app.webText("Rest of today shifted."))
        exists(app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Bake the loaf, \(end) to ")).firstMatch)
        app.tapLabeled("Undo")
        exists(app.page.descendants(matching: .any).matching(NSPredicate(format: "label == %@", before)).firstMatch)
        exists(app.webText("Bake the loaf conflicts with Proof the loaf."))
    }

    func testMissedBlocksShareASheetAnsweredByRowOrSelectionThatASwipeDownPutsAwayUntilReview() {
        let app = launchApp(seed: "Seed today missed")
        // Not onToday: the sheet is drawn outside Today's region, and hides the tab bar that would go to Week and back.
        exists(app.labeled("5 missed blocks"))

        app.tapLabeled("Not done: Mix the dough", until: app.labeled("4 missed blocks"))
        gone(app.labeled("Not done: Mix the dough"))

        // Select ticks rows, as switches here, and Partly asks how much is left of each before it saves them together.
        app.tapLabeled("Select", until: app.labeled("Select all"))
        for title in ["Feed the starter", "Fold the dough"] {
            let tick = app.page.switches[title]
            app.tap(tick)
            reads(tick, "1")
        }
        app.tapLabeled("Partly", until: app.labeled("How much is left?"))
        app.tapLabeled("Save 2 answers", until: app.labeled("2 missed blocks"))

        // A swipe down from the sheet's top strip, above its heading, puts it away, as Later does.
        let sheet = app.labeled(startingWith: "2 missed blocks,")
        exists(sheet)
        let strip = sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: 8))
        strip.press(forDuration: 0.1, thenDragTo: strip.withOffset(CGVector(dx: 0, dy: 200)))
        gone(sheet)
        app.tapLabeled(startingWith: "Check in on 2 missed blocks", until: sheet)

        // Answering the last row closes the sheet, so its toast shows. Undo brings that block back, on its own now, so
        // it asks in the end prompt, whose Task finished counts it done.
        app.tapLabeled("Finished: Shape the dough", until: app.labeled("1 missed block"))
        app.tapLabeled("Finished: Proof the loaf", until: app.webText("Proof the loaf: finished."))
        app.tapLabeled("Undo", until: app.labeled("Task finished"))
        app.tapLabeled("Task finished")
        gone(app.labeled("Task finished"))
        exists(element(app, startingWith: "Proof the loaf, ", endingWith: ", Project. Done."))
        exists(app.labeled(startingWith: "Done today: 2 finished"))
        // The one not done and the two partly done wait for a new time.
        exists(app.labeled(startingWith: "3 tasks need a new time"))
    }

    func testAnUnplannedWeekOpensOnThePromptToPlanAndSkippingLeavesABannerAndNextUpThatStayAfterARestart() {
        let app = launchApp(seed: "Seed today unplanned")
        let prompt = app.webText("Plan your week")
        onToday(prompt, in: app)

        app.tapLabeled("Skip for now", until: app.webText("Skipped planning this week."))
        app.tapLabeled("Undo", until: prompt)
        let banner = app.webText("This week isn't planned")
        app.tapLabeled("Skip for now", until: banner)

        // Next up offers the one off, and Start puts it on the calendar from now.
        app.tapLabeled("Start Buy flour", until: app.webText("In progress, time left"))
        exists(app.webButton("Buy flour"))
        allowNotificationsIfAsked()

        // The skip is saved on the week's plan, so it holds after a restart.
        app.terminate()
        app.launchLoaded()
        onToday(banner, in: app)
        exists(app.webText("In progress, time left"))
        XCTAssertFalse(prompt.exists, "Today asks to plan the skipped week again")
    }
}

/// Any element whose label starts and ends as given, such as a block on the timeline with how it went.
private func element(_ app: XCUIApplication, startingWith prefix: String, endingWith suffix: String) -> XCUIElement {
    app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH %@", prefix, suffix)).firstMatch
}

/// The words of a label after `start`, up to its next full stop, such as the time a toast says a block now ends.
private func words(of element: XCUIElement, after start: String, file: StaticString = #filePath, line: UInt = #line) -> String {
    let label = element.label
    guard let at = label.range(of: start) else {
        XCTFail("\"\(label)\" doesn't say \"\(start)\"", file: file, line: line)
        return ""
    }
    return String(label[at.upperBound...].prefix { $0 != "." })
}

/// The countdown as it reads, such as "58:42": WebKit gives its minutes, its colon and its seconds a line each.
private func countdown(_ timer: XCUIElement) -> String {
    timer.staticTexts.allElementsBoundByIndex.map(\.label).joined()
}
