import WidgetCore
import WidgetTestSupport
import XCTest

/// The timeline's entries fall only where what a widget shows changes, so the reload budget is left for real changes.
final class TimelineTests: XCTestCase {
    private let t = Fixtures.instant

    func testEntriesFallAtEachBlocksStartAndEndAndAtMidnight() {
        let dates = WidgetTimeline.entryDates(Fixtures.loaded("now"), from: Fixtures.moment("now"))
        XCTAssertEqual(dates.first, Fixtures.moment("now"))
        for edge in ["2026-11-18T18:30:00Z", "2026-11-18T19:00:00Z", "2026-11-18T19:15:00Z", "2026-11-18T21:00:00Z", "2026-11-18T22:00:00Z",
                     "2026-11-19T01:30:00Z", "2026-11-19T02:00:00Z", "2026-11-19T17:00:00Z", "2026-11-19T18:00:00Z"] {
            XCTAssertTrue(dates.contains(t(edge)), edge)
        }
        // Midnight in Los Angeles.
        XCTAssertTrue(dates.contains(t("2026-11-19T08:00:00Z")))
        XCTAssertEqual(dates, dates.sorted())
        XCTAssertLessThanOrEqual(dates.last!, Fixtures.moment("now").addingTimeInterval(WidgetTimeline.horizon))
    }

    func testEachEntrysStateChangesOnlyAtAnEntry() {
        // Between two entries the state, and so what's drawn, doesn't change: checked a minute at a time through the day.
        let loaded = Fixtures.loaded("now")
        let start = Fixtures.moment("now")
        let dates = WidgetTimeline.entryDates(loaded, from: start)
        for (from, to) in zip(dates, dates.dropFirst()) {
            let drawn = WidgetState(loaded, at: from)
            var d = from.addingTimeInterval(30)
            while d < to {
                let s = WidgetState(loaded, at: d)
                XCTAssertEqual(s.mode, drawn.mode, "\(d)")
                XCTAssertEqual(s.current?.id, drawn.current?.id, "\(d)")
                XCTAssertEqual(s.minutesToNext, drawn.minutesToNext, "\(d)")
                d = d.addingTimeInterval(30)
            }
        }
    }

    func testStartsInCountsDownAMinuteAtATimeThroughTheHourBefore() {
        let dates = WidgetTimeline.entryDates(Fixtures.loaded("next"), from: Fixtures.moment("next"))
        let before = dates.filter { $0 > Fixtures.moment("next") && $0 < t("2026-11-18T19:00:00Z") }
        XCTAssertEqual(before.count, 11, "10:49 to 10:59")
        XCTAssertEqual(WidgetState(Fixtures.loaded("next"), at: t("2026-11-18T18:59:00Z")).minutesToNext, 1)
    }

    func testAPauseCountsUpAMinuteAtATime() {
        let dates = WidgetTimeline.entryDates(Fixtures.loaded("paused"), from: Fixtures.moment("paused"))
        for minute in 5...29 { XCTAssertTrue(dates.contains(t(String(format: "2026-11-18T18:%02d:00Z", minute))), "\(minute)") }
        XCTAssertFalse(dates.contains(t("2026-11-18T18:04:30Z")))
    }

    func testTheSyncTurningStaleAndUndoRunningOutEachGetAnEntry() {
        let stale = WidgetTimeline.entryDates(Fixtures.loaded("now"), from: t("2026-11-18T18:04:00Z"))
        XCTAssertTrue(stale.contains(t("2026-11-18T19:04:01Z")))
        let action = WidgetAction(v: 1, id: "1795107960000-6F9619FF-8B86-4011-B42D-00C04FC96401.json", kind: .start, blockId: "spec", rev: "x", at: t("2026-11-18T17:06:00Z"), target: nil)
        let started = LoadedSnapshot.ok(Fixtures.snapshot("start").applying([action]))
        XCTAssertTrue(WidgetTimeline.entryDates(started, from: t("2026-11-18T17:06:00Z")).contains(t("2026-11-18T17:11:00Z")))
    }

    func testSignedOutOrWithoutASnapshotNeedsOneEntry() {
        let now = Date()
        XCTAssertEqual(WidgetTimeline.entryDates(.missing, from: now), [now])
        XCTAssertEqual(WidgetTimeline.entryDates(Fixtures.loaded("signedout"), from: now), [now])
    }

    func testABusyDayStaysWithinTheEntryCap() {
        var s = Fixtures.snapshot("now")
        let base = s.blocks[1]
        s.blocks = (0..<60).map { i in
            var b = base
            b.id = "b\(i)"
            b.start = t("2026-11-18T18:05:00Z").addingTimeInterval(TimeInterval(i * 1800))
            b.end = b.start.addingTimeInterval(900)
            b.startedAt = nil
            return b
        }
        XCTAssertLessThanOrEqual(WidgetTimeline.entryDates(.ok(s), from: Fixtures.moment("now")).count, WidgetTimeline.maxEntries)
    }

    func testSmartStackRelevanceRisesTenMinutesBeforeABlockAndFallsWhenNothingIsLeft() {
        let loaded = Fixtures.loaded("next")
        XCTAssertEqual(WidgetTimeline.relevance(WidgetState(loaded, at: t("2026-11-18T18:40:00Z"))).score, 0.3)
        let soon = WidgetTimeline.relevance(WidgetState(loaded, at: t("2026-11-18T18:50:00Z")))
        XCTAssertEqual(soon.score, 1)
        XCTAssertEqual(soon.duration, 25 * 60, "until the block ends")
        XCTAssertEqual(WidgetTimeline.relevance(WidgetState(Fixtures.loaded("now"), at: Fixtures.moment("now"))).score, 1)
        XCTAssertEqual(WidgetTimeline.relevance(WidgetState(Fixtures.loaded("finished"), at: Fixtures.moment("finished"))).score, 0.1)
        XCTAssertEqual(WidgetTimeline.relevance(WidgetState(Fixtures.loaded("empty"), at: Fixtures.moment("empty"))).score, 0.1)
    }
}
