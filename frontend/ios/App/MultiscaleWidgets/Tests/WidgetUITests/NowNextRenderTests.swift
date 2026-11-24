import SwiftUI
import WidgetCore
import WidgetTestSupport
@testable import WidgetUI
import XCTest

@available(iOS 17.0, macOS 14.0, *)
/// The states every Now and next and Capture render covers: each the spec draws, from the app's own fixtures.
@MainActor
enum States {
    static func state(_ name: String, at time: String? = nil) -> WidgetState {
        WidgetState(Fixtures.loaded(name), at: time.map(Fixtures.instant) ?? Fixtures.moment(name))
    }

    /// A start from the widget a minute ago, and a Start early, both still offered to undo.
    static func justStarted(early: Bool) -> WidgetState {
        let action = WidgetAction(v: 1, id: "1795107960000-6F9619FF-8B86-4011-B42D-00C04FC96401.json", kind: early ? .startEarly : .start,
                                  blockId: early ? "dentist" : "spec", rev: "x",
                                  at: Fixtures.instant(early ? "2026-11-18T18:48:00Z" : "2026-11-18T17:06:00Z"), target: nil)
        let snapshot = Fixtures.snapshot(early ? "next" : "start").applying([action])
        return WidgetState(.ok(snapshot), at: Fixtures.instant(early ? "2026-11-18T18:49:00Z" : "2026-11-18T17:07:00Z"))
    }

    static var all: [(String, WidgetState)] {
        [
            ("now", state("now")), ("start", state("start")), ("paused", state("paused")), ("free", state("next")),
            ("empty", state("empty")), ("finished", state("finished")), ("signedout", state("signedout")),
            ("nodata", WidgetState(.missing, at: Fixtures.moment("now"))), ("toonew", WidgetState(.tooNew, at: Fixtures.moment("now"))),
            ("stale", state("stale")), ("encrypted", state("encrypted")),
            ("started", justStarted(early: false)), ("startedearly", justStarted(early: true)),
            // A long title in each mode that shows one.
            ("longtitle", long()),
        ]
    }

    private static func long() -> WidgetState {
        var s = Fixtures.snapshot("now")
        let i = s.blocks.firstIndex { $0.id == "spec" }!
        s.blocks[i].title = "Write the widget spec, with every state, tap and refresh, and the questions for the owner at the end"
        return WidgetState(.ok(s), at: Fixtures.moment("now"))
    }
}

@available(iOS 17.0, macOS 14.0, *)
@MainActor
final class NowNextRenderTests: XCTestCase {
    func testEveryNowAndNextStateFitsItsSizeInEveryLookAtEveryTextSize() {
        for (name, state) in States.all {
            for size in NowNextView.Size.allCases {
                for look in [WidgetLook.light, .dark, .tinted] {
                    for text in Render.textSizes {
                        Render.check(NowNextView(state: state, size: size), size: size == .small ? WidgetSize.small : WidgetSize.medium,
                                     look: look, text: text, name: ["nownext", size.rawValue, name])
                    }
                }
            }
        }
    }

    /// StandBy draws the small widget larger, on black, and red at night; a locked phone with Lock Screen widget access
    /// off shows the placeholders, and an encrypted space's block its space's name.
    func testStandByShowsTheSmallWidgetDarkAndAtNightAndHidesNamesWhenLocked() {
        for (name, state) in States.all {
            for look in [WidgetLook.dark, .night] {
                Render.check(NowNextView(state: state, size: .small), size: WidgetSize.small, look: look, text: Render.textSizes[0], name: ["standby", name])
            }
        }
        for name in ["now", "encrypted", "free"] {
            let state = States.all.first { $0.0 == name }!.1
            Render.check(NowNextView(state: state, size: .small), size: WidgetSize.small, look: .night, text: Render.textSizes[0],
                         name: ["standby", name, "locked"], redacted: true)
        }
    }

    func testCaptureFitsInEveryLookAtEveryTextSize() {
        let cases: [(String, WidgetState)] = [
            ("inbox", States.state("inbox")), ("emptyinbox", States.state("now")), ("signedout", States.state("signedout")),
            ("nodata", WidgetState(.missing, at: Fixtures.moment("now"))),
            ("shares", WidgetState(Fixtures.loaded("inbox"), shares: 120, at: Fixtures.moment("inbox"))),
        ]
        for (name, state) in cases {
            for look in [WidgetLook.light, .dark, .tinted] {
                for text in Render.textSizes {
                    Render.check(CaptureView(state: state), size: WidgetSize.small, look: look, text: text, name: ["capture", "small", name])
                }
            }
        }
    }

    /// The medium widget's button is the one the state calls for, named in full, and the small widget has none.
    func testTheButtonFollowsTheBlock() {
        XCTAssertEqual(States.state("now").button, .pause(blockId: "spec"))
        XCTAssertEqual(States.state("start").button, .start(blockId: "spec"))
        XCTAssertEqual(States.state("paused").button, .resume(blockId: "spec"))
        XCTAssertEqual(States.state("next").button, .startEarly(blockId: "dentist"))
        XCTAssertEqual(States.justStarted(early: false).button, .undo(actionId: "1795107960000-6F9619FF-8B86-4011-B42D-00C04FC96401.json", blockId: "spec", early: false))
        for name in ["empty", "finished", "signedout"] { XCTAssertNil(States.state(name).button, name) }
    }
}
