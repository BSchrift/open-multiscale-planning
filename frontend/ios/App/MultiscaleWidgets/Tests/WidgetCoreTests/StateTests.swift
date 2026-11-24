import WidgetCore
import WidgetTestSupport
import XCTest

/// What each widget shows in each of the spec's states, from the app's own snapshots of them.
final class StateTests: XCTestCase {
    private func state(_ name: String, at time: String? = nil, shares: Int = 0) -> WidgetState {
        WidgetState(Fixtures.loaded(name), shares: shares, at: time.map(Fixtures.instant) ?? Fixtures.moment(name))
    }

    func testABlockInProgressCountsDownToItsEndWithTheBarOfTimeSpent() {
        let s = state("now")
        XCTAssertEqual(s.mode, .now)
        XCTAssertEqual(s.current?.id, "spec")
        XCTAssertEqual(s.nextToday?.id, "dentist")
        XCTAssertEqual(s.timeLeft, 26 * 60)
        let countdown = s.countdown!
        XCTAssertEqual(countdown.range, Fixtures.moment("now")...Fixtures.instant("2026-11-18T18:30:00Z"))
        XCTAssertNil(countdown.pauseTime)
        // Started 41 seconds late: 63m19s spent of 89m19s.
        XCTAssertEqual(s.spentFraction, 3799.0 / 5359.0, accuracy: 0.0001)
        XCTAssertEqual(s.spentRange, Fixtures.instant("2026-11-18T17:00:41Z")...Fixtures.instant("2026-11-18T18:30:00Z"))
        XCTAssertEqual(s.button, .pause(blockId: "spec"))
        XCTAssertNil(s.staleSince)
    }

    func testABlockWhoseTimeHasComeOffersStartAndNoCountdown() {
        let s = state("start")
        XCTAssertEqual(s.mode, .start)
        XCTAssertNil(s.countdown)
        XCTAssertNil(s.spentRange)
        XCTAssertEqual(s.button, .start(blockId: "spec"))
    }

    func testAPauseStopsTheCountdownWhereItStoppedAndSaysWhenItWouldEnd() {
        let s = state("paused")
        XCTAssertEqual(s.mode, .paused)
        XCTAssertEqual(s.timeLeft, 38 * 60)
        XCTAssertEqual(s.countdown!.pauseTime, Fixtures.instant("2026-11-18T17:52:00Z"))
        XCTAssertEqual(s.countdown!.range.upperBound.timeIntervalSince(s.countdown!.range.lowerBound), 38 * 60)
        XCTAssertNil(s.spentRange, "a paused bar doesn't run")
        XCTAssertEqual(s.pausedMinutes, 12)
        XCTAssertEqual(s.endsIfResumed, Fixtures.instant("2026-11-18T18:42:00Z"))
        XCTAssertEqual(s.button, .resume(blockId: "spec"))
        // Still frozen a minute on.
        let later = state("paused", at: "2026-11-18T18:05:00Z")
        XCTAssertEqual(later.timeLeft, 38 * 60)
        XCTAssertEqual(later.pausedMinutes, 13)
        XCTAssertEqual(later.endsIfResumed, Fixtures.instant("2026-11-18T18:43:00Z"))
    }

    func testFreeTimeSaysWhatsNextAndOffersStartEarly() {
        let s = state("next")
        XCTAssertEqual(s.mode, .free)
        XCTAssertEqual(s.nextToday?.id, "dentist")
        XCTAssertEqual(s.after?.id, "prs")
        XCTAssertEqual(s.minutesToNext, 12)
        XCTAssertEqual(s.button, .startEarly(blockId: "dentist"))
        XCTAssertEqual(state("next", at: "2026-11-18T18:48:30Z").minutesToNext, 12, "rounded up")
    }

    func testANothingPlannedDaySaysWhetherTheWeekIs() {
        let s = state("empty")
        XCTAssertEqual(s.mode, .empty)
        XCTAssertFalse(s.weekPlanned)
        XCTAssertNil(s.button)
        XCTAssertNil(s.tomorrow)
    }

    func testAFinishedDayTalliesItsAnswersAndShowsTomorrow() {
        let s = state("finished")
        XCTAssertEqual(s.mode, .finished)
        XCTAssertEqual(s.counts, .init(done: 2, partly: 1, notDone: 1, toAnswer: 1))
        XCTAssertEqual(s.tomorrow?.id, "notes")
        XCTAssertNil(s.button)
    }

    func testSignedOutShowsNoneOfTheAccount() {
        let s = state("signedout")
        XCTAssertEqual(s.mode, .signedOut)
        XCTAssertNil(s.inbox)
        XCTAssertNil(s.current)
    }

    func testBeforeTheFirstSnapshotOrWithAnUnreadableOneItAsksToOpenTheApp() {
        XCTAssertEqual(WidgetState(.missing, at: Date()).mode, .noData)
        XCTAssertEqual(WidgetState(.unreadable, at: Date()).mode, .noData)
        XCTAssertEqual(LoadedSnapshot.decode(Data("{\"v\":1}".utf8)), .unreadable)
        XCTAssertEqual(LoadedSnapshot.decode(Data("not json".utf8)), .unreadable)
        XCTAssertEqual(LoadedSnapshot.decode(Data(count: Snapshot.maxBytes + 1)), .unreadable)
        XCTAssertEqual(LoadedSnapshot.decode(nil), .missing)
    }

    func testAnOldSyncIsSaidOnlyOnceItsOverAnHourOld() {
        XCTAssertEqual(state("stale").staleSince, Fixtures.instant("2026-11-18T15:58:00Z"))
        XCTAssertNil(state("stale", at: "2026-11-18T16:58:00Z").staleSince)
        XCTAssertNotNil(state("stale", at: "2026-11-18T16:58:01Z").staleSince)
    }

    func testTheInboxCountsSharesStillWaitingToImport() {
        XCTAssertEqual(state("inbox").inbox, 4)
        XCTAssertEqual(state("inbox", shares: 2).inbox, 6)
        XCTAssertNil(WidgetState(.missing, shares: 2, at: Date()).inbox, "no count before the first snapshot")
    }

    func testAStartFromTheWidgetOffersUndoForFiveMinutes() {
        let action = WidgetAction(v: 1, id: "1795107960000-6F9619FF-8B86-4011-B42D-00C04FC96401.json", kind: .start, blockId: "spec", rev: "x", at: Fixtures.instant("2026-11-18T17:06:00Z"), target: nil)
        let loaded = LoadedSnapshot.ok(Fixtures.snapshot("start").applying([action]))
        let s = WidgetState(loaded, at: Fixtures.instant("2026-11-18T17:10:59Z"))
        XCTAssertEqual(s.mode, .now)
        XCTAssertEqual(s.justStarted?.id, action.id)
        XCTAssertEqual(s.button, .undo(actionId: action.id, blockId: "spec", early: false))
        XCTAssertEqual(WidgetState(loaded, at: Fixtures.instant("2026-11-18T17:11:00Z")).button, .pause(blockId: "spec"))
    }

    func testButtonsAreCheckedAtTheTapAgainstThePlanAsItThenIs() {
        let s = state("start")
        XCTAssertTrue(s.accepts(.start(blockId: "spec")))
        XCTAssertFalse(s.accepts(.pause(blockId: "spec")))
        XCTAssertFalse(s.accepts(.start(blockId: "dentist")))
        // The block's time passed while the widget still showed Start.
        XCTAssertFalse(state("start", at: "2026-11-18T18:30:00Z").accepts(.start(blockId: "spec")))
        XCTAssertFalse(state("now").accepts(.undo(actionId: "x", blockId: "spec", early: false)))
    }

    func testAnEncryptedSpacesBlockIsNamedOnlyByItsSpace() {
        let s = state("encrypted")
        XCTAssertNil(s.current?.title)
        XCTAssertEqual(BlockName(s.current!).shown, WidgetText("Acme work", sensitive: false))
        XCTAssertEqual(BlockName(s.current!).said, "a block in Acme work")
    }
}
