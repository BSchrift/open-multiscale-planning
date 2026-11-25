import WidgetCore
import WidgetTestSupport
import XCTest

/// What This week shows, worked out from the app's own fixtures: every state the spec draws, through the week and into
/// the next, what VoiceOver reads, and when its timeline changes.
final class WeekTests: XCTestCase {
    private func week(_ name: String, at time: String? = nil) -> WeekState {
        WeekState(Fixtures.loaded(name), at: time.map(Fixtures.instant) ?? Fixtures.moment(name))
    }

    /// A snapshot as the app wrote it, changed first.
    private func week(_ name: String, at time: String, _ change: (inout Snapshot) -> Void) -> WeekState {
        var s = Fixtures.snapshot(name)
        change(&s)
        return WeekState(.ok(s), at: Fixtures.instant(time))
    }

    func testAPlannedWeekShowsEachDaysTimeTheAimsAndThePractices() {
        let w = week("now")
        XCTAssertEqual(w.mode, .planned)
        XCTAssertEqual(w.range, "Nov 16 to 22")
        XCTAssertEqual(w.days.map(\.letter), ["M", "T", "W", "T", "F", "S", "S"])
        XCTAssertEqual(w.days.map(\.minutes), [255, 105, 240, 60, 0, 60, 0])
        XCTAssertEqual(w.days.map(\.isToday), [false, false, true, false, false, false, false])
        XCTAssertEqual(w.mostMinutes, 255)
        XCTAssertEqual(w.aims.map(\.name.text), ["Garden", "Multiscale", "One offs"])
        XCTAssertEqual(w.aims.map(\.line), ["1h of 2h", "7h 30m of 8h", "1h of 2h"])
        XCTAssertEqual(w.aims.map(\.fraction), [0.5, 0.9375, 0.5])
        XCTAssertEqual(w.aims.map(\.status?.pill), ["Behind", "On track", nil])
        XCTAssertEqual(w.practices.map(\.name.text), ["Piano", "Run"])
        XCTAssertEqual(w.practices.map(\.line), ["1 of 2", "2 of 3"])
        XCTAssertNil(w.staleSince)
        XCTAssertEqual(w.link, WidgetLink.week)
    }

    /// The week stays the same all week, with today's mark moving each midnight; a day the snapshot doesn't hold still
    /// knows the week is planned, since that holds for the whole week.
    func testTodaysMarkMovesThroughTheWeek() {
        let thursday = week("now", at: "2026-11-19T08:00:00Z")
        XCTAssertEqual(thursday.days.map(\.isToday), [false, false, false, true, false, false, false])
        let sunday = week("now", at: "2026-11-23T07:59:00Z")
        XCTAssertEqual(sunday.mode, .planned)
        XCTAssertEqual(sunday.days.last?.isToday, true)
        XCTAssertEqual(week("finished").days.map(\.minutes), week("now").days.map(\.minutes))
    }

    func testAWeekNotPlannedSaysSoAndOpensPlan() {
        let w = week("empty")
        XCTAssertEqual(w.mode, .unplanned)
        XCTAssertEqual(w.range, "Nov 16 to 22")
        XCTAssertEqual(w.link, WidgetLink.plan)
        XCTAssertEqual(w.days, [])
    }

    /// Past Sunday midnight with no new snapshot, the week the snapshot holds is over. If the snapshot knows the new week
    /// isn't planned, that's what shows; otherwise the widget asks for the app rather than show last week as this one.
    func testANewWeekBeforeTheAppHasRunIsntShownAsTheLastOne() {
        let monday = "2026-11-23T17:00:00Z"
        XCTAssertEqual(week("now", at: monday).mode, .newWeek)
        XCTAssertEqual(week("now", at: monday).range, "Nov 23 to 29")
        XCTAssertEqual(week("now", at: monday).link, WidgetLink.week)
        XCTAssertNil(week("now", at: monday).staleSince)
        let unplanned = week("now", at: monday) { $0.days = [.init(date: "2026-11-22", weekPlanned: true), .init(date: "2026-11-23", weekPlanned: false)] }
        XCTAssertEqual(unplanned.mode, .unplanned)
        let planned = week("now", at: monday) { $0.days = [.init(date: "2026-11-22", weekPlanned: true), .init(date: "2026-11-23", weekPlanned: true)] }
        XCTAssertEqual(planned.mode, .newWeek)
    }

    func testWithoutAWeekToShowItSaysWhy() {
        XCTAssertEqual(week("signedout").mode, .signedOut)
        XCTAssertEqual(WeekState(.missing, at: Fixtures.moment("now")).mode, .noData)
        XCTAssertEqual(WeekState(.unreadable, at: Fixtures.moment("now")).mode, .noData)
        XCTAssertEqual(WeekState(.tooNew, at: Fixtures.moment("now")).mode, .tooNew)
        XCTAssertEqual(WeekState(Fixtures.loaded("newer"), at: Fixtures.moment("now")).mode, .tooNew)
        // From an app from before This week: the other widgets draw from it, and this one waits for the app.
        XCTAssertEqual(week("now", at: "2026-11-18T18:04:00Z") { $0.week = nil }.mode, .noData)
    }

    func testAnOldSyncIsSaid() {
        XCTAssertEqual(week("stale").staleSince, Fixtures.instant("2026-11-18T15:58:00Z"))
        XCTAssertEqual(week("stale").mode, .planned)
    }

    /// A project or practice in an encrypted space shows only the space's name, which a locked phone needn't hide; their
    /// own names are marked for iOS to hide, and One offs, the app's own word, isn't.
    func testAnEncryptedSpacesAimsAndPracticesShowTheSpacesName() {
        let w = week("encrypted")
        XCTAssertEqual(w.aims.map(\.name), [WidgetText("Garden", sensitive: true), WidgetText("Acme work"), WidgetText("One offs")])
        XCTAssertEqual(w.aims[1].said, "a project in Acme work")
        XCTAssertEqual(w.aims[1].line, "7h 30m of 8h")
        XCTAssertEqual(w.practices.map(\.name), [WidgetText("Piano", sensitive: true), WidgetText("Acme work")])
        XCTAssertEqual(w.practices[1].said, "a practice in Acme work")
    }

    func testAnAimsBarIsFullOnceMetAndEmptyWithNoAim() {
        let w = week("now", at: "2026-11-18T18:04:00Z") { s in
            s.week!.aims = [.init(name: "Over", kind: .project, plannedMinutes: 600, aimMinutes: 480, status: nil),
                            .init(name: "None", kind: .project, plannedMinutes: 60, aimMinutes: 0, status: nil)]
        }
        XCTAssertEqual(w.aims.map(\.fraction), [1, 0])
        XCTAssertEqual(w.aims[0].line, "10h of 8h")
    }

    func testVoiceOverReadsTheWeekInOrderOfImportance() {
        let days = "Planned: Monday 4 hours 15 minutes, Tuesday 1 hour 45 minutes, Wednesday, today, 4 hours, Thursday 1 hour, Friday none, Saturday 1 hour, Sunday none."
        let aims = "Aims: Garden 1 hour of 2 hours planned, Behind. Multiscale 7 hours 30 minutes of 8 hours planned, On track. One offs 1 hour of 2 hours planned."
        XCTAssertEqual(week("now").label(large: false), "This week, Nov 16 to 22. \(days) \(aims)")
        XCTAssertEqual(week("now").label(large: true), "This week, Nov 16 to 22. \(days) \(aims) Practices: Piano 1 of 2 sessions, Run 2 of 3 sessions.")
        // Only what's drawn is read, when there's room for fewer.
        XCTAssertEqual(week("now").label(large: true, aimsShown: 1, practicesShown: 1),
                       "This week, Nov 16 to 22. \(days) Aims: Garden 1 hour of 2 hours planned, Behind. Practices: Piano 1 of 2 sessions.")
        XCTAssertEqual(week("stale").label(large: false), "This week, Nov 16 to 22. \(days) \(aims) Synced at 7:58am.")
        XCTAssertEqual(week("encrypted").label(large: true),
                       "This week, Nov 16 to 22. \(days) Aims: Garden 1 hour of 2 hours planned, Behind. a project in Acme work 7 hours 30 minutes of 8 hours planned, On track. One offs 1 hour of 2 hours planned. Practices: Piano 1 of 2 sessions, a practice in Acme work 2 of 3 sessions.")
        XCTAssertEqual(week("now").label(large: true, redacted: true),
                       "This week, Nov 16 to 22. \(days) Aims: a project 1 hour of 2 hours planned, Behind. a project 7 hours 30 minutes of 8 hours planned, On track. One offs 1 hour of 2 hours planned. Practices: a practice 1 of 2 sessions, a practice 2 of 3 sessions.")
        XCTAssertEqual(week("now", at: "2026-11-18T18:04:00Z") { $0.week!.aims = [] }.label(large: false), "This week, Nov 16 to 22. \(days) No weekly aims.")
        XCTAssertEqual(week("empty").label(large: false), "This week, Nov 16 to 22, isn't planned yet. Plan your week.")
        XCTAssertEqual(week("signedout").label(large: true), "This week. Sign in to see your week.")
        XCTAssertEqual(WeekState(.missing, at: Date()).label(large: true), "This week. Open Multiscale once to show your week here.")
        XCTAssertEqual(WeekState(.tooNew, at: Date()).label(large: true), "This week. Open Multiscale to update this widget.")
        XCTAssertEqual(week("now", at: "2026-11-23T17:00:00Z").label(large: true), "This week, Nov 23 to 29. Open Multiscale to show this week here.")
    }

    func testLengthsAreSpokenInFull() {
        XCTAssertEqual(WeekState.spoken(0), "none")
        XCTAssertEqual(WeekState.spoken(1), "1 minute")
        XCTAssertEqual(WeekState.spoken(45), "45 minutes")
        XCTAssertEqual(WeekState.spoken(60), "1 hour")
        XCTAssertEqual(WeekState.spoken(61), "1 hour 1 minute")
        XCTAssertEqual(WeekState.spoken(450), "7 hours 30 minutes")
    }

    /// One entry now and one each midnight, plus when the last sync turns stale: the rest changes only with a new
    /// snapshot, and the app reloads the widget when it writes one.
    func testTheTimelineChangesAtMidnightAndWhenTheSyncTurnsStale() {
        let now = Fixtures.instant("2026-11-18T18:04:00Z")
        XCTAssertEqual(WidgetTimeline.weekEntryDates(Fixtures.loaded("now"), from: now),
                       [now, Fixtures.instant("2026-11-18T19:04:01Z"), Fixtures.instant("2026-11-19T08:00:00Z")])
        XCTAssertEqual(WidgetTimeline.weekEntryDates(Fixtures.loaded("stale"), from: now), [now, Fixtures.instant("2026-11-19T08:00:00Z")])
        XCTAssertEqual(WidgetTimeline.weekEntryDates(Fixtures.loaded("signedout"), from: now), [now])
        XCTAssertEqual(WidgetTimeline.weekEntryDates(.missing, from: now), [now])
        // Each entry's state is the state at that moment.
        for date in WidgetTimeline.weekEntryDates(Fixtures.loaded("now"), from: now) {
            XCTAssertEqual(WeekState(Fixtures.loaded("now"), at: date).mode, .planned)
        }
    }

    /// The gallery's and the placeholder's This week: the spec's example week, planned, in the week of the moment.
    func testTheSampleIsAPlannedWeek() {
        let now = Fixtures.instant("2026-11-20T18:00:00Z")
        let w = WeekState(.ok(.sample(at: now, zone: TimeZone(identifier: "America/Los_Angeles")!)), at: now)
        XCTAssertEqual(w.mode, .planned)
        XCTAssertEqual(w.range, "Nov 16 to 22")
        XCTAssertEqual(w.days.first { $0.isToday }?.name, "Friday")
        XCTAssertEqual(w.aims.map(\.line), ["6h 30m of 8h", "1h of 2h"])
        XCTAssertEqual(w.practices.map(\.line), ["2 of 3", "1 of 2"])
    }
}
