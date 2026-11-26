import WidgetCore
import WidgetTestSupport
import XCTest

/// What the Lock Screen set shows and reads in each state: inline beside the date, rectangular, the countdown circle and
/// the Inbox circle. Names are the only words a locked phone hides.
final class LockTests: XCTestCase {
    private func state(_ name: String, at time: String? = nil) -> WidgetState {
        WidgetState(Fixtures.loaded(name), at: time.map(Fixtures.instant) ?? Fixtures.moment(name))
    }

    func testInlineSaysTheBlockAndItsTimeInOneLine() {
        let cases: [(String, WidgetState.InlineMark, String, String)] = [
            ("now", .live, "Until 10:30am · Write widget spec", "Now and next. Now: Write widget spec, until 10:30am."),
            ("start", .clock, "Not started · Write widget spec", "Now and next. Write widget spec, not started."),
            ("paused", .clock, "Paused · Write widget spec", "Now and next. Paused: Write widget spec."),
            ("next", .clock, "11am · Call the dentist", "Now and next. Next at 11am: Call the dentist."),
            ("empty", .today, "Nothing planned today", "Now and next. Nothing planned today."),
            ("finished", .today, "Tomorrow 9am · Draft release notes", "Now and next. Tomorrow at 9am: Draft release notes."),
            ("signedout", .today, "Sign in to Multiscale", "Now and next. Sign in to Multiscale."),
            ("stale", .live, "Until 10:30am · Write widget spec", "Now and next. Now: Write widget spec, until 10:30am."),
        ]
        for (name, mark, text, label) in cases {
            let line = state(name).inline()
            XCTAssertEqual(line.mark, mark, name)
            XCTAssertEqual(line.text.text, text, name)
            XCTAssertEqual(state(name).inlineLabel(), label, name)
        }
        XCTAssertEqual(WidgetState(.missing, at: Date()).inline().text.text, "Open Multiscale")
        XCTAssertEqual(WidgetState(.missing, at: Date()).inlineLabel(), "Now and next. Open Multiscale once to show your day.")
        XCTAssertEqual(WidgetState(.tooNew, at: Date()).inlineLabel(), "Now and next. Open Multiscale to update this widget.")
    }

    func testRectangularHasAnEyebrowANameAndAFoot() {
        let cases: [(String, String, String, WidgetState.LockFoot, String)] = [
            ("now", "Now, until 10:30am", "Write widget spec", .countdown,
             "Now and next. Now: Write widget spec, ends at 10:30am."),
            ("start", "Now, 9am to 10:30am", "Write widget spec", .words(["Not started"]),
             "Now and next. Write widget spec, 9am to 10:30am, not started."),
            ("paused", "Paused for 12 minutes", "Write widget spec", .words(["Ends at 10:42am unless you resume", "Ends at 10:42am"]),
             "Now and next. Paused: Write widget spec. Ends at 10:42am unless you resume."),
            ("next", "Free until 11am. Next:", "Call the dentist", .words(["Starts in 12 min"]),
             "Now and next. Free until 11am. Next: Call the dentist."),
            ("empty", "Today", "Nothing planned", .none, "Now and next. Nothing planned today."),
            ("finished", "Tomorrow, 9am", "Draft release notes", .words(["1 block to answer today", "1 to answer"]),
             "Now and next. Tomorrow at 9am: Draft release notes. 1 block to answer today."),
            ("signedout", "Multiscale", "Sign in to see your day", .none, "Now and next. Sign in to see your day."),
            ("stale", "Now, until 10:30am", "Write widget spec", .countdown,
             "Now and next. Now: Write widget spec, ends at 10:30am. Synced at 7:58am."),
        ]
        for (name, eyebrow, title, foot, label) in cases {
            let card = state(name).rectangular()
            XCTAssertEqual(card.eyebrow, eyebrow, name)
            XCTAssertEqual(card.title.text, title, name)
            XCTAssertEqual(card.foot, foot, name)
            XCTAssertEqual(state(name).rectangularLabel(), label, name)
        }
        XCTAssertEqual(WidgetState(.missing, at: Date()).rectangular().title.text, "Open the app once")
        XCTAssertEqual(WidgetState(.tooNew, at: Date()).rectangular().title.text, "Open the app to update")
    }

    /// More than an hour before the next block, it gives the time rather than a count that would need an entry a minute.
    func testFarOffNextBlocksGiveTheirTime() {
        let early = state("next", at: "2026-11-18T17:30:00Z") // 9:30am, with the dentist at 11am
        XCTAssertEqual(early.mode, .free)
        XCTAssertEqual(early.rectangular().foot, .words(["Starts at 11am"]))
        XCTAssertEqual(early.ring.middle, .at("11am"))
    }

    func testAFinishedDayWithNothingToAnswerOrTomorrowSaysSo() {
        var s = Fixtures.snapshot("finished")
        s.blocks = s.blocks.filter { $0.id != "notes" }.map { b in
            var b = b
            if b.answer == nil { b.answer = .done }
            return b
        }
        let st = WidgetState(.ok(s), at: Fixtures.moment("finished"))
        XCTAssertEqual(st.mode, .finished)
        XCTAssertEqual(st.inline().text.text, "Nothing else planned today")
        XCTAssertEqual(st.rectangular().eyebrow, "Today")
        XCTAssertEqual(st.rectangular().title.text, "Nothing else planned")
        XCTAssertEqual(st.rectangular().foot, .none)
        XCTAssertEqual(st.rectangularLabel(), "Now and next. Nothing else planned today.")
        XCTAssertEqual(st.ringLabel, "Nothing else today.")
    }

    func testTwoBlocksToAnswerArePlural() {
        var s = Fixtures.snapshot("finished")
        if let i = s.blocks.firstIndex(where: { $0.id == "prs" }) { s.blocks[i].answer = nil }
        let st = WidgetState(.ok(s), at: Fixtures.moment("finished"))
        XCTAssertEqual(st.rectangular().foot, .words(["2 blocks to answer today", "2 to answer"]))
    }

    func testTheCountdownCircleFillsWithTimeSpent() {
        let now = state("now")
        XCTAssertEqual(now.ring.middle, .countdown)
        XCTAssertEqual(now.ring.fill, now.spentFraction)
        XCTAssertGreaterThan(now.ring.fill, 0.5)
        XCTAssertEqual(now.ringLabel, "Countdown, ends at 10:30am.")

        let paused = state("paused")
        XCTAssertEqual(paused.ring.middle, .paused)
        XCTAssertEqual(paused.ring.fill, paused.spentFraction)
        XCTAssertEqual(paused.ringLabel, "Countdown, paused. Ends at 10:42am unless you resume.")

        XCTAssertEqual(state("start").ring, WidgetState.LockRing(middle: .notStarted, fill: 0))
        XCTAssertEqual(state("start").ringLabel, "Countdown, not started.")
        XCTAssertEqual(state("next").ring, WidgetState.LockRing(middle: .minutes(12), fill: 0))
        XCTAssertEqual(state("next").ringLabel, "Next block starts at 11am.")
        for name in ["empty", "finished", "signedout"] { XCTAssertEqual(state(name).ring.middle, .today, name) }
        XCTAssertEqual(state("empty").ringLabel, "Nothing planned today.")
        XCTAssertEqual(state("signedout").ringLabel, "Sign in to Multiscale.")
        XCTAssertEqual(WidgetState(.missing, at: Date()).ringLabel, "Open Multiscale.")
    }

    func testTheInboxCircleCountsTheInboxAndWaitingShares() {
        XCTAssertEqual(state("inbox").inboxCircle.count, "4")
        XCTAssertEqual(state("inbox").inboxCircle.said, "Inbox, 4 items.")
        XCTAssertEqual(WidgetState(Fixtures.loaded("now"), shares: 1, at: Fixtures.moment("now")).inboxCircle.said, "Inbox, 1 item.")
        XCTAssertEqual(state("now").inboxCircle.count, "0")
        XCTAssertEqual(state("now").inboxCircle.said, "Inbox is empty.")
        XCTAssertNil(state("signedout").inboxCircle.count)
        XCTAssertEqual(state("signedout").inboxCircle.said, "Inbox.")
        XCTAssertNil(WidgetState(.missing, at: Date()).inboxCircle.count)
        // A circle has room for three figures.
        let many = WidgetState(Fixtures.loaded("inbox"), shares: 2000, at: Fixtures.moment("inbox"))
        XCTAssertEqual(many.inboxCircle.count, "999+")
        XCTAssertEqual(many.inboxCircle.said, "Inbox, 2004 items.")
    }

    /// The Lock Screen marks names, and only names, for iOS to hide, and reads the placeholders when it does.
    func testALockedPhoneHidingNamesShowsAndReadsThePlaceholders() {
        let now = state("now")
        XCTAssertTrue(now.inline().text.sensitive)
        XCTAssertTrue(now.rectangular().title.sensitive)
        XCTAssertEqual(now.inline(redacted: true).text, WidgetText("Until 10:30am · Block in progress"))
        XCTAssertEqual(now.rectangular(redacted: true).title, WidgetText("Block in progress"))
        XCTAssertEqual(now.inlineLabel(redacted: true), "Now and next. Now: block in progress, until 10:30am.")
        XCTAssertEqual(now.rectangularLabel(redacted: true), "Now and next. Now: block in progress, ends at 10:30am.")
        XCTAssertEqual(state("next").inline(redacted: true).text.text, "11am · Next block")
        XCTAssertEqual(state("finished").rectangular(redacted: true).title.text, "Next block")
        // Words with no name in them aren't hidden.
        for name in ["empty", "signedout"] {
            XCTAssertFalse(state(name).inline().text.sensitive, name)
            XCTAssertFalse(state(name).rectangular().title.sensitive, name)
        }
    }

    /// An encrypted space's block shows its space's name everywhere, locked or not, which the spaces spec allows.
    func testAnEncryptedSpacesBlockShowsItsSpaceEvenLocked() {
        let st = state("encrypted")
        for redacted in [false, true] {
            XCTAssertEqual(st.inline(redacted: redacted).text, WidgetText("Until 10:30am · Acme work"))
            XCTAssertEqual(st.rectangular(redacted: redacted).title, WidgetText("Acme work"))
            XCTAssertEqual(st.inlineLabel(redacted: redacted), "Now and next. Now: a block in Acme work, until 10:30am.")
        }
    }
}
