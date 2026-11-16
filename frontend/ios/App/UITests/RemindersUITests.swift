import XCTest

/**
 * Reminders and their actions, through the real app. Each seed puts blocks at clock times on the seeded app's morning,
 * so a block's label on Today reads from its start, and each answer brings the next reminder up as the app's soonest:
 * the debug build brings only the soonest forward, two seconds after the app leaves the screen. Labels are matched by
 * their start, since a block that overlaps another goes on to say so.
 */
final class RemindersUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testStartNotificationsTradeThenStartPlanningAndWorkThenAnEndAnswersPartlyAndACheckInSkipsOnceStartsAreOff() {
        let app = launchApp(seed: "Seed reminders start", remindingOnLeave: true)
        allowNotificationsIfAsked()
        seen(app.labeled(startingWith: "Shape the dough, 10:10am to 10:40am, Project."), in: app)

        // Shape the dough's start comes first. Do next block instead trades its work with the next block's, next week's
        // planning, and each block keeps its times.
        answer("Do next block instead", alsoOffering: ["Start"], notOffering: ["Yes, started"], in: app)
        app.activate()
        seen(planning(at: "10:10am to 10:40am", in: app), in: app)
        exists(app.labeled(startingWith: "Shape the dough, 10:50am to 11:20am, Project."))
        // Until the app has set its reminders again, Shape the dough's check-in at 10:15 is still the soonest.
        settle(app)

        // Planning's start, now the soonest, offers the same two, and its Start opens planning on its week.
        answer("Start", alsoOffering: ["Do next block instead"], in: app)
        app.activate()
        exists(app.labeled("Plan the week"))
        app.tapWeb("Save and exit")
        seen(app.labeled(startingWith: "Shape the dough, 10:50am to 11:20am, Project."), in: app)

        // Shape the dough's start, at its new time, starts it. Today can't show that before 10:50, but its end coming next,
        // rather than "Have you started?", does.
        answer("Start", alsoOffering: ["Do next block instead"], notOffering: ["Yes, started"], in: app)
        app.activate()
        // Start reminders off, so Bake the loaf's check-in will come rather than its start. The visit to Settings is also
        // the time the app takes to hear the answer as it comes back to the front, and to set its reminders again.
        app.open("Settings")
        toggle("Notify at block start", in: app)
        app.open("Today")
        seen(app.labeled(startingWith: "Shape the dough, 10:50am to 11:20am, Project."), in: app)

        // Partly opens the app to ask how much is left.
        answer("Partly", alsoOffering: ["Still going", "Not done"], notOffering: ["Done", "Yes, started"], in: app)
        app.activate()
        exists(app.labeled("How much is left?"))
        app.tapWeb("Save")
        seen(app.labeled(startingWith: "Shape the dough, 10:50am to 11:20am, Project. Partly."), in: app)

        // Bake the loaf's check-in. Skip takes its block off the day, and the task waits in To schedule for a new time. It
        // also offers Do next block instead, with no block after it, which does nothing: not asserted either way.
        answer("Skip, choose a new time later", alsoOffering: ["Yes, started", "Ask again in 10 minutes"], notOffering: ["Start"], in: app)
        app.activate()
        seen(app.page.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Bake the loaf, ' AND label ENDSWITH ', to schedule'")).firstMatch, in: app)
        goneFromToday(app.labeled(startingWith: "Bake the loaf, 11:30am to 12pm, Project."), in: app)
    }

    func testTheCheckInDelayDecidesWhenItsNotificationComesThenAskAgainNextBlockYesStartedAndStillGoingTakeEffect() {
        let app = launchApp(seed: "Seed reminders check-in", remindingOnLeave: true)
        allowNotificationsIfAsked()

        // Shape the dough began at 9:54 unstarted, so after the usual 5 minutes the app asks in place. Closed unanswered,
        // by the backdrop above it, it isn't asked again this session.
        let asked = app.labeled("Have you started Shape the dough?")
        exists(asked)
        let backdrop = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        backdrop.tap()
        // A tap after a launch can be lost; the backdrop is only tapped again while the question is still over it.
        if !asked.waitForNonExistence(timeout: 5), asked.exists { backdrop.tap() }
        gone(asked)

        // After 15 minutes instead, its check-in is at 10:09, still to come. XCUITest can't set a web slider's value, so
        // the thumb is dragged from the shortest end to the longest.
        app.open("Settings")
        let delay = app.page.sliders["After"]
        scrollTo(delay, in: app)
        // From points on the screen rather than on the slider: dragged by its own coordinates, XCUITest looked the slider up
        // again for the end of the drag and spent the whole wait failing to, as the page redrew it, and the thumb never
        // moved.
        let track = delay.frame
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: track.minX + track.width * 0.04, dy: track.midY))
            .press(forDuration: 0.2, thenDragTo: origin.withOffset(CGVector(dx: track.maxX - 1, dy: track.midY)))
        reads(delay, "15 minutes")
        app.open("Today")
        let shape = app.labeled(startingWith: "Shape the dough, 9:54am to 10:24am, Project. Now.")
        seen(shape, in: app)

        // So the check-in comes first. With 5 minutes it was already past, and the block's end at 10:24 would have come.
        answer("Ask again in 10 minutes", alsoOffering: ["Yes, started", "Do next block instead", "Skip, choose a new time later"], notOffering: ["Start"], in: app)
        app.activate()
        // Nothing on screen shows a snooze, so there's nothing to wait for before the app sets its reminders again.
        settle(app)
        seen(shape, in: app)

        // Asked again. Do next block instead trades the work with Bake the loaf's, and each block keeps its times.
        answer("Do next block instead", alsoOffering: ["Yes, started", "Ask again in 10 minutes"], notOffering: ["Start"], in: app)
        app.activate()
        seen(app.labeled(startingWith: "Bake the loaf, 9:54am to 10:24am, Project. Now."), in: app)
        exists(app.labeled(startingWith: "Shape the dough, 10:40am to 11:10am, Project."))
        // Until the app has set its reminders again, the check-in still waiting is the one about Shape the dough, which
        // the app would now find out of date and not act on.
        settle(app)

        // The block's snoozed check-in, now about Bake the loaf. Yes, started puts it under way.
        answer("Yes, started", alsoOffering: ["Ask again in 10 minutes", "Skip, choose a new time later"], in: app)
        app.activate()
        seen(app.webText("In progress, time left"), in: app)

        // Started, so its end comes next, with no Done: a task is finished only in the app. Still going adds half an hour.
        answer("Still going", alsoOffering: ["Partly", "Not done"], notOffering: ["Done"], in: app)
        app.activate()
        seen(app.labeled(startingWith: "Bake the loaf, 9:54am to 10:54am, Project. Now."), in: app)
    }

    func testAPausedBlocksResumeThenAPracticesAllAndSkipThenResumeFromItsEndOnceCheckInsAreOff() {
        let app = launchApp(seed: "Seed reminders paused", remindingOnLeave: true)
        allowNotificationsIfAsked()
        seen(app.labeled(startingWith: "Paused for"), in: app)

        // Paused at 9:50, Proof the loaf's one reminder comes at 10:20, before anything else, and offers only Resume.
        answer("Resume", alsoOffering: [], notOffering: ["Partly", "Not done"], in: app)
        app.activate()
        seen(app.webText("In progress, time left"), in: app)

        // Starts and check-ins off, so the practices' ends come next, and a pause gets no reminder of its own.
        app.open("Settings")
        toggle("Notify at block start", in: app)
        toggle("Ask if I've started, unless I already tapped Start", in: app)
        app.open("Today")
        seen(app.labeled(startingWith: "Stretch, 10:30am to 10:45am, Practice."), in: app)

        // A practice's end logs time rather than judging it: All logs the whole session.
        answer("All 15m", alsoOffering: ["Skip"], notOffering: ["Still going", "Partly"], in: app)
        app.activate()
        seen(app.labeled(startingWith: "Stretch, 10:30am to 10:45am, Practice. Done."), in: app)

        // Skip, answered before the session is over, takes it off the day.
        answer("Skip", alsoOffering: ["All 10m"], in: app)
        app.activate()
        goneFromToday(app.labeled(startingWith: "Walk, 10:50am to 11:00am, Practice."), in: app)

        // Paused again from its ring. With check-ins off, its end is what comes, offering Resume with the time left in place
        // of Still going. Until the app has set its reminders again, the end still waiting is the one from before the pause.
        app.tapLabeled(startingWith: "Pause, ", until: app.labeled(startingWith: "Resume, "))
        settle(app)
        answer("Resume, ", startingWith: true, alsoOffering: ["Partly", "Not done"], notOffering: ["Still going"], in: app)
        app.activate()
        seen(app.webText("In progress, time left"), in: app)
    }

    // MARK: - Helpers

    /**
     * Answers the app's notification from its banner, as answerNotification does, and leaves again if no banner comes.
     * After each change the app sets its reminders again, taking every one off and then putting the new list on. Left
     * in the middle of that, the debug build finds nothing to bring forward, or brings one forward that the app then
     * takes off and puts back at its own time, and no banner comes. Back in the app, that finishes, and leaving again
     * brings the soonest forward. With `startingWith`, the action is matched by the start of its title, for one that goes
     * on with a time, such as "Resume, 1h 5m left".
     */
    private func answer(_ action: String, startingWith: Bool = false, alsoOffering others: [String], notOffering absent: [String] = [],
                        in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let banner = springboard.descendants(matching: .any)["NotificationShortLookView"]
        XCUIDevice.shared.press(.home)
        if !banner.waitForExistence(timeout: 10) {
            app.activate()
            settle(app, file: file, line: line)
            XCUIDevice.shared.press(.home)
        }
        exists(banner, in: springboard, file: file, line: line)
        banner.press(forDuration: 1.5)
        let button = springboard.buttons.matching(NSPredicate(format: startingWith ? "label BEGINSWITH %@" : "label == %@", action)).firstMatch
        exists(button, in: springboard, file: file, line: line)
        for other in others { XCTAssertTrue(springboard.buttons[other].exists, "\(other) isn't offered", file: file, line: line) }
        for other in absent { XCTAssertFalse(springboard.buttons[other].exists, "\(other) is offered", file: file, line: line) }
        button.tap()
    }

    /**
     * Goes to Week and back to Today, the time the app takes to set its reminders again after a change, before the app
     * leaves the screen. Nothing on screen shows that it has, and leaving first brings forward a reminder from the list
     * as it was.
     */
    private func settle(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        app.tapWeb("Week", until: app.webButton("Previous week"), file: file, line: line)
        app.tapWeb("Today", file: file, line: line)
    }

    /**
     * Waits for something on Today, as onToday does, but gives Today only a few seconds before hiding it and showing it
     * again. Back from the Home Screen, the tree often holds Today as it was, and onToday's ten seconds every round add up.
     * The round trip also gives the app time to set its reminders again.
     */
    private func seen(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        if element.waitForExistence(timeout: 4) { return }
        settle(app, file: file, line: line)
        exists(element, file: file, line: line)
    }

    /// Next week's planning block on Today, at these times. Its title names the week's Monday.
    private func planning(at times: String, in app: XCUIApplication) -> XCUIElement {
        app.page.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Plan the week of ' AND label CONTAINS %@", ", \(times), Planning.")).firstMatch
    }

    /**
     * Ticks or unticks a checkbox and waits for it to read the other way, as WebKit gives it 1 or 0 once the save lands.
     * The control, not the text beside it, though a tap on either would do. Tapped once only: a second, for a save that
     * came slowly, would put it back.
     */
    private func toggle(_ label: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let text = NSNumber(value: XCUIElement.ElementType.staticText.rawValue)
        let box = app.page.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType != %@", label, text)).firstMatch
        exists(box, file: file, line: line)
        let before = box.value as? String ?? ""
        box.tap()
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", before), object: box)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: patience), .completed, "\(label) still reads \(before)", file: file, line: line)
    }

    /**
     * Scrolls the page up until the element can be touched, for a drag by coordinates, which doesn't scroll by itself as a
     * tap does. Each drag is shorter than the screen and held still at its end, so the page doesn't coast on and nothing is
     * scrolled past, and it runs up the side gutter, where no control can catch it.
     */
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        exists(element, file: file, line: line)
        for _ in 0..<8 where !element.isHittable {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.7)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.35)),
                                                                                   withVelocity: .slow, thenHoldForDuration: 0.3)
        }
        XCTAssertTrue(element.isHittable, "\(element) never came on screen. On screen:\n\(app.debugDescription)", file: file, line: line)
    }

    /// Waits for something to leave Today, hiding Today and showing it again after a few seconds, as seen does.
    private func goneFromToday(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        if element.waitForNonExistence(timeout: 4) { return }
        settle(app, file: file, line: line)
        gone(element, file: file, line: line)
    }
}
