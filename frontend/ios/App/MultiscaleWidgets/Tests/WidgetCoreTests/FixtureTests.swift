import WidgetCore
import WidgetTestSupport
import XCTest

/// The contract with the app: the JSON its tests write, read as the widgets read it. A failure here means the two sides
/// drifted. Fix the side that's wrong; never edit a fixture by hand.
final class FixtureTests: XCTestCase {
    func testEverySnapshotTheAppWritesDecodes() {
        for name in Fixtures.scenarios {
            XCTAssertNotNil(Fixtures.loaded(name).snapshot, name)
        }
        let now = Fixtures.snapshot("now")
        XCTAssertEqual(now.zone, "America/Los_Angeles")
        XCTAssertEqual(now.blocks.map(\.id), ["run", "spec", "dentist", "prs", "piano", "notes"])
        XCTAssertEqual(now.blocks.map(\.kind), [.practice, .project, .oneoff, .project, .practice, .project])
        let spec = now.block("spec")!
        XCTAssertEqual(spec.title, "Write widget spec")
        XCTAssertEqual(spec.startedAt, Fixtures.instant("2026-11-18T17:00:41Z"))
        XCTAssertEqual(now.events.map(\.title), ["Standup"])
        XCTAssertEqual(now.days.map(\.weekPlanned), [true, true])
    }

    func testASnapshotFromALaterAppIsntGuessedAt() {
        XCTAssertEqual(Fixtures.loaded("newer"), .tooNew)
        XCTAssertEqual(WidgetState(Fixtures.loaded("newer"), at: Fixtures.moment("now")).mode, .tooNew)
    }

    /// Moment by moment through both days, the widget finds the same block under the clock, the same next block and the
    /// same state as the app's own currentBlock and nextBlock.
    func testTheWidgetsStateMatchesTheAppsAtEveryMoment() {
        let states = Fixtures.states
        XCTAssertEqual(Set(states.keys), Set(Fixtures.scenarios))
        var checked = 0
        for (name, moments) in states {
            let loaded = Fixtures.loaded(name)
            for expected in moments {
                let state = WidgetState(loaded, at: expected.at)
                let at = ISO8601DateFormatter().string(from: expected.at)
                XCTAssertEqual(state.mode.rawValue, expected.mode, "\(name) at \(at)")
                if state.mode != .signedOut {
                    XCTAssertEqual(state.current?.id, expected.current, "\(name) at \(at)")
                    XCTAssertEqual(state.next?.id, expected.next, "\(name) at \(at)")
                }
                checked += 1
            }
        }
        XCTAssertGreaterThan(checked, 100)
    }

    /// Each action the intents write is what the app reads, field for field.
    func testTheActionsAnIntentWritesAreWhatTheAppReads() throws {
        for kind in ["start", "startEarly", "pause", "resume", "undo"] {
            let fixture = Fixtures.data("actions/\(kind).json")
            let action = try WidgetJSON.decoder.decode(WidgetAction.self, from: fixture)
            XCTAssertEqual(action.kind.rawValue, kind)
            XCTAssertTrue(WidgetAction.isFileName(action.id))
            let written = try JSONSerialization.jsonObject(with: WidgetJSON.encoder.encode(action)) as! NSDictionary
            let expected = try JSONSerialization.jsonObject(with: fixture) as! NSDictionary
            XCTAssertEqual(written, expected, kind)
        }
    }

    /// What the widget draws straight after a tap is what the app leaves once it applies the tap.
    func testATapsOverlayMatchesWhatTheAppApplies() {
        let overlays = Fixtures.overlays
        XCTAssertEqual(overlays.count, 7)
        for overlay in overlays {
            let applied = Fixtures.snapshot(overlay.snapshot).applying(overlay.actions)
            let fields = applied.blocks.map {
                Fixtures.Overlay.Fields(id: $0.id, start: $0.start, end: $0.end, startedAt: $0.startedAt, pausedAt: $0.pausedAt, pausedMin: $0.pausedMin)
            }
            XCTAssertEqual(fields, overlay.blocks, overlay.name)
            // The app keeps a start in the snapshot only while Undo is offered, as of its last tap.
            let last = overlay.actions.map(\.at).max()!
            let recent = applied.fromWidget.filter { last < $0.at.addingTimeInterval(WidgetState.undoFor) }.map {
                Fixtures.Overlay.Recent(kind: $0.kind.rawValue, blockId: $0.blockId, at: $0.at, before: $0.before)
            }
            XCTAssertEqual(recent, overlay.fromWidget, overlay.name)
        }
    }

    func testTimesAreWrittenAsTheAppWritesThem() {
        let times = Fixtures.times
        XCTAssertGreaterThan(times.count, 40)
        for t in times {
            XCTAssertEqual(Format.time(t.instant, in: TimeZone(identifier: t.zone)!), t.text, "\(t.instant) in \(t.zone)")
        }
    }
}
