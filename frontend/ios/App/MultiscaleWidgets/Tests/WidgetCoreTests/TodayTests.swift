import WidgetCore
import WidgetTestSupport
import XCTest

/// The Today widget's rows: the block in progress on, with what's behind folded into one line, each row's state in
/// words, and each block's link to Today at that block.
final class TodayTests: XCTestCase {
    private func state(_ name: String, at time: String? = nil) -> WidgetState {
        WidgetState(Fixtures.loaded(name), at: time.map(Fixtures.instant) ?? Fixtures.moment(name))
    }

    private func said(_ rows: [DayRow]) -> [String] { rows.map(\.said) }

    func testInProgressFoldsWhatsBehindAndListsTheRest() {
        let day = state("now").day(limit: 6)
        XCTAssertEqual(day.earlier, WidgetState.Counts(done: 1))
        XCTAssertEqual(said(day.rows), [
            "9am, Write widget spec, now", "10:30am, Standup, calendar event", "11am, Call the dentist",
            "1pm, Review pull requests", "5:30pm, Piano",
        ])
        XCTAssertEqual(day.rows.map(\.status), [.now, .event, .planned, .planned, .planned])
        XCTAssertEqual(day.rows.map(\.kind), [.project, nil, .oneoff, .project, .practice])
    }

    func testEachStateReadsAsWords() {
        XCTAssertEqual(state("start").day(limit: 1).rows.first?.said, "9am, Write widget spec, not started")
        XCTAssertEqual(state("paused").day(limit: 1).rows.first?.said, "9am, Write widget spec, paused")
        let next = state("next").day(limit: 6)
        // The standup has gone by, so it drops out; the spec, answered, folds into Earlier with the run.
        XCTAssertEqual(next.earlier, WidgetState.Counts(done: 2))
        XCTAssertEqual(said(next.rows), ["11am, Call the dentist", "1pm, Review pull requests", "5:30pm, Piano"])
        let finished = state("finished").day(limit: 6)
        XCTAssertNil(finished.earlier)
        XCTAssertEqual(said(finished.rows), [
            "7am, Run, done", "9am, Write widget spec, done", "10:30am, Standup, calendar event",
            "11am, Call the dentist, not done", "1pm, Review pull requests, partly", "5:30pm, Piano, to answer",
        ])
        XCTAssertEqual(finished.rows.map(\.status), [.done, .done, .event, .notDone, .partly, .toAnswer])
    }

    /// With less room, the day keeps the next rows; a finished day keeps its last ones, the earlier folded.
    func testFewerRowsKeepWhatMattersMost() {
        XCTAssertEqual(said(state("now").day(limit: 3).rows), [
            "9am, Write widget spec, now", "10:30am, Standup, calendar event", "11am, Call the dentist",
        ])
        let finished = state("finished").day(limit: 3)
        XCTAssertEqual(finished.earlier, WidgetState.Counts(done: 2))
        XCTAssertEqual(said(finished.rows), ["11am, Call the dentist, not done", "1pm, Review pull requests, partly", "5:30pm, Piano, to answer"])
    }

    func testRowsLinkToTodayAtTheirBlock() {
        let rows = state("now").day(limit: 6).rows
        XCTAssertEqual(rows[0].link.absoluteString, "multiscale://today?block=spec")
        XCTAssertEqual(rows[0].blockId, "spec")
        // An event isn't a block of the app's, so its row opens Today itself.
        XCTAssertNil(rows[1].blockId)
        XCTAssertEqual(rows[1].link, WidgetLink.today)
        XCTAssertEqual(rows[2].link.absoluteString, "multiscale://today?block=dentist")
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count, "row ids are unique")
        // Every character the app's link parser takes in an id (appLinks.ts) arrives as it was, so the app finds the block.
        XCTAssertEqual(WidgetLink.today(block: "blk_8f2c-1:a.B9").absoluteString, "multiscale://today?block=blk_8f2c-1:a.B9")
    }

    func testNothingToListWithoutADay() {
        for st in [state("empty"), state("signedout"), WidgetState(.missing, at: Date()), WidgetState(.tooNew, at: Date())] {
            let day = st.day(limit: 6)
            XCTAssertNil(day.earlier, "\(st.mode)")
            XCTAssertTrue(day.rows.isEmpty, "\(st.mode)")
        }
    }

    func testTheHeadSaysTheDayOrTheFreeTimeAndWhenItLastSyncedIfStale() {
        XCTAssertEqual(state("now").todayHead.left, "Today")
        XCTAssertEqual(state("now").todayHead.right, "Wednesday, Nov 18")
        XCTAssertEqual(state("next").todayHead.left, "Free until 11am")
        XCTAssertEqual(state("stale").todayHead.right, "Synced at 7:58am")
        // At 6:20pm in Los Angeles it's already the 19th in UTC: the day is the snapshot's zone's.
        XCTAssertEqual(state("finished").todayHead.right, "Wednesday, Nov 18")
    }

    func testTheEarlierLineNamesOnlyWhatHappened() {
        XCTAssertEqual(WidgetState.Counts(done: 1).earlierSaid, "1 done")
        XCTAssertEqual(WidgetState.Counts(done: 2, partly: 1, notDone: 0, toAnswer: 3).earlierSaid, "2 done, 1 partly, 3 to answer")
        XCTAssertEqual(WidgetState.Counts(notDone: 1).earlierSaid, "1 not done")
    }

    /// The medium widget is one element, read in order; the large one's rows are each their own link.
    func testVoiceOverReadsTheDayInOrder() {
        XCTAssertEqual(state("now").todayLabel(limit: 3),
                       "Today, Wednesday, Nov 18. 9am, Write widget spec, now. 10:30am, Standup, calendar event. 11am, Call the dentist.")
        XCTAssertEqual(state("next").todayLabel(limit: 3),
                       "Today, Wednesday, Nov 18. Free until 11am. 11am, Call the dentist. 1pm, Review pull requests. 5:30pm, Piano.")
        XCTAssertEqual(state("stale").todayLabel(limit: 1), "Today, Wednesday, Nov 18. 9am, Write widget spec, now. Synced at 7:58am.")
        XCTAssertEqual(state("finished").todayLabel(limit: 3),
                       "Today. Nothing else planned today. 2 done, 1 partly, 1 not done, 1 to answer. Tomorrow at 9am: Draft release notes.")
        XCTAssertEqual(state("empty").todayLabel(limit: 3), "Today. Nothing planned today. This week isn't planned yet. Inbox is empty.")
        XCTAssertEqual(state("signedout").todayLabel(limit: 3), "Today. Sign in to see your day.")
        XCTAssertEqual(WidgetState(.missing, at: Date()).todayLabel(limit: 3), "Today. Open Multiscale once to show your day here.")
        XCTAssertEqual(WidgetState(.tooNew, at: Date()).todayLabel(limit: 3), "Today. Open Multiscale to update this widget.")
        XCTAssertEqual(state("now").todayHeadSaid, "Today, Wednesday, Nov 18.")
        XCTAssertEqual(state("next").todayHeadSaid, "Today, Wednesday, Nov 18. Free until 11am.")
        XCTAssertEqual(state("stale").todayHeadSaid, "Today, Wednesday, Nov 18. Synced at 7:58am.")
        XCTAssertEqual(state("finished").tomorrowSaid, "Tomorrow at 9am: Draft release notes")
    }

    func testAnEncryptedSpacesBlockIsItsSpaceAndAnUntitledEventIsAnEvent() {
        var s = Fixtures.snapshot("encrypted")
        s.events[0].title = nil
        let rows = WidgetState(.ok(s), at: Fixtures.moment("encrypted")).day(limit: 2).rows
        XCTAssertEqual(rows[0].shown, WidgetText("Acme work"))
        XCTAssertEqual(rows[0].said, "9am, a block in Acme work, now")
        XCTAssertEqual(rows[1].shown, WidgetText("Calendar event"))
        XCTAssertEqual(rows[1].said, "10:30am, calendar event")
        // Every other name is marked for a locked phone to hide.
        XCTAssertEqual(state("now").day(limit: 6).rows.map(\.shown.sensitive), [true, true, true, true, true])
    }

    func testTheDayReadsAsTheAppWritesIt() {
        let zone = TimeZone(identifier: "America/Los_Angeles")!
        XCTAssertEqual(Format.dayLong(Fixtures.instant("2026-11-18T18:04:00Z"), in: zone), "Wednesday, Nov 18")
        XCTAssertEqual(Format.dayLong(Fixtures.instant("2026-11-02T08:00:00Z"), in: zone), "Monday, Nov 2")
        XCTAssertEqual(Format.dayLong(Fixtures.instant("2027-01-01T07:59:00Z"), in: zone), "Thursday, Dec 31")
    }
}
