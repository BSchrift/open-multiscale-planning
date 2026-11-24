import WidgetCore
import WidgetTestSupport
import XCTest

/// What VoiceOver reads for each widget in each state, and which words a locked phone may hide.
final class WordsTests: XCTestCase {
    private func state(_ name: String, at time: String? = nil) -> WidgetState {
        WidgetState(Fixtures.loaded(name), at: time.map(Fixtures.instant) ?? Fixtures.moment(name))
    }

    func testNowAndNextReadsOneElementInOrderOfImportanceWithEndTimes() {
        XCTAssertEqual(state("now").nowNextLabel(medium: true),
                       "Now and next. Now: Write widget spec, 9am to 10:30am, ends at 10:30am. Next at 11am: Call the dentist.")
        XCTAssertEqual(state("now").nowNextLabel(medium: false), "Now and next. Now: Write widget spec, 9am to 10:30am, ends at 10:30am.")
        XCTAssertEqual(state("start").nowNextLabel(medium: true),
                       "Now and next. Write widget spec, 9am to 10:30am, not started. Next at 11am: Call the dentist.")
        XCTAssertEqual(state("paused").nowNextLabel(medium: true),
                       "Now and next. Paused for 12 minutes: Write widget spec. Ends at 10:42am unless you resume. Next at 11am: Call the dentist.")
        XCTAssertEqual(state("next").nowNextLabel(medium: true),
                       "Now and next. Free until 11am. Next: Call the dentist, starts at 11am. After that at 1pm: Review pull requests.")
        XCTAssertEqual(state("next").nowNextLabel(medium: false), "Now and next. Free until 11am. Next: Call the dentist, starts at 11am.")
        XCTAssertEqual(state("empty").nowNextLabel(medium: true), "Now and next. Nothing planned today. This week isn't planned yet.")
        XCTAssertEqual(state("finished").nowNextLabel(medium: true),
                       "Now and next. Nothing else planned today. 2 done, 1 partly, 1 not done, 1 to answer. Tomorrow at 9am: Draft release notes.")
        XCTAssertEqual(state("signedout").nowNextLabel(medium: true), "Now and next. Sign in to see your day.")
        XCTAssertEqual(WidgetState(.missing, at: Date()).nowNextLabel(medium: true), "Now and next. Open Multiscale once to show your day here.")
        XCTAssertEqual(WidgetState(.tooNew, at: Date()).nowNextLabel(medium: true), "Now and next. Open Multiscale to update this widget.")
        XCTAssertEqual(state("stale").nowNextLabel(medium: false),
                       "Now and next. Now: Write widget spec, 9am to 10:30am, ends at 10:30am. Synced at 7:58am.")
    }

    func testAnEncryptedSpacesBlockIsReadByItsSpace() {
        XCTAssertEqual(state("encrypted").nowNextLabel(medium: false),
                       "Now and next. Now: a block in Acme work, 9am to 10:30am, ends at 10:30am.")
    }

    func testALockedPhoneHidingNamesReadsThePlaceholdersInstead() {
        XCTAssertEqual(state("now").nowNextLabel(medium: true, redacted: true),
                       "Now and next. Now: block in progress, 9am to 10:30am, ends at 10:30am. Next at 11am: next block.")
        // The space's name stays, as the spaces spec keeps it on the Lock Screen.
        XCTAssertEqual(state("encrypted").nowNextLabel(medium: false, redacted: true),
                       "Now and next. Now: a block in Acme work, 9am to 10:30am, ends at 10:30am.")
    }

    /// Every name from the snapshot, and only names, is marked for iOS to hide on a locked phone: the fields the app's
    /// privacy test lists as free text (blocks' and events' titles).
    func testOnlyNamesAreMarkedPrivate() {
        for name in Fixtures.scenarios {
            for block in Fixtures.snapshot(name).blocks {
                let shown = BlockName(block).shown
                XCTAssertEqual(shown.sensitive, block.title != nil, "\(name) \(block.id)")
                if let title = block.title { XCTAssertEqual(shown.text, title) }
            }
        }
    }

    func testButtonsAreNamedInFull() {
        XCTAssertEqual(WidgetButton.start(blockId: "spec").label("Write widget spec"), "Start Write widget spec")
        XCTAssertEqual(WidgetButton.startEarly(blockId: "d").label("Call the dentist"), "Start early, Call the dentist")
        XCTAssertEqual(WidgetButton.pause(blockId: "spec").label("Write widget spec"), "Pause Write widget spec")
        XCTAssertEqual(WidgetButton.resume(blockId: "spec").label("Write widget spec"), "Resume Write widget spec")
        XCTAssertEqual(WidgetButton.undo(actionId: "a", blockId: "spec", early: false).label("Write widget spec"), "Undo start, Write widget spec")
        XCTAssertEqual(WidgetButton.undo(actionId: "a", blockId: "d", early: true).label("Call the dentist"), "Undo start early, Call the dentist")
    }

    func testCaptureSaysHowFullTheInboxIs() {
        XCTAssertEqual(state("inbox").captureLabel, "Capture. 4 in Inbox.")
        XCTAssertEqual(state("inbox").inboxLine, "4 in Inbox")
        XCTAssertEqual(state("now").inboxLine, "Inbox is empty")
        XCTAssertEqual(state("signedout").captureLabel, "Capture. Sign in to Multiscale first.")
        XCTAssertEqual(state("signedout").inboxLine, "Sign in first")
        XCTAssertEqual(WidgetState(.missing, at: Date()).inboxLine, "Inbox")
        XCTAssertEqual(WidgetState(.missing, at: Date()).captureLabel, "Capture. Inbox.")
    }

    func testTimesAndPausesReadAsTheAppWritesThem() {
        XCTAssertEqual(Format.minutes(45), "45m")
        XCTAssertEqual(Format.minutes(120), "2h")
        XCTAssertEqual(Format.minutes(90), "1h 30m")
        XCTAssertEqual(Format.pause(1), "1 minute")
        XCTAssertEqual(Format.pause(12), "12 minutes")
        XCTAssertEqual(Format.pause(70), "1h 10m")
    }
}
