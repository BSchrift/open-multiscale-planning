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

    /// This week's part, field for field as the app wrote it, with names in an encrypted space left out.
    func testTheWeekTheAppWritesDecodes() throws {
        let week = try XCTUnwrap(Fixtures.snapshot("now").week)
        XCTAssertEqual(week.start, "2026-11-16")
        XCTAssertEqual(week.plannedMinutes, [255, 105, 240, 60, 0, 60, 0])
        XCTAssertEqual(week.aims.map(\.name), ["Garden", "Multiscale", "One offs"])
        XCTAssertEqual(week.aims.map(\.kind), [.project, .project, .oneoff])
        XCTAssertEqual(week.aims.map(\.plannedMinutes), [60, 450, 60])
        XCTAssertEqual(week.aims.map(\.aimMinutes), [120, 480, 120])
        XCTAssertEqual(week.aims.map(\.status), [.init(pill: "Behind", tone: .amber), .init(pill: "On track", tone: .green), nil])
        XCTAssertEqual(week.practices.map(\.name), ["Piano", "Run"])
        XCTAssertEqual(week.practices.map(\.done), [1, 2])
        XCTAssertEqual(week.practices.map(\.of), [2, 3])

        let encrypted = try XCTUnwrap(Fixtures.snapshot("encrypted").week)
        let acme = Snapshot.Space(name: "Acme work", encrypted: true)
        XCTAssertEqual(encrypted.aims.map(\.name), ["Garden", nil, "One offs"])
        XCTAssertEqual(encrypted.aims[1].space, acme)
        XCTAssertEqual(encrypted.practices.map(\.name), ["Piano", nil])
        XCTAssertEqual(encrypted.practices[1].space, acme)

        let empty = try XCTUnwrap(Fixtures.snapshot("empty").week)
        XCTAssertEqual(empty.plannedMinutes, [0, 0, 0, 0, 0, 0, 0])
        XCTAssertEqual(empty.aims, [])
        XCTAssertEqual(empty.practices, [])
        XCTAssertNil(Fixtures.snapshot("signedout").week)
    }

    /// A snapshot an older app wrote, before This week, still reads: the other widgets draw from it as before.
    func testASnapshotWithNoWeekStillDecodes() throws {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Fixtures.data("snapshots/now.json")) as? [String: Any])
        json["week"] = nil
        let loaded = LoadedSnapshot.decode(try JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(loaded.snapshot?.week)
        XCTAssertEqual(loaded.snapshot?.blocks, Fixtures.snapshot("now").blocks)
    }

    /// Kinds and tones from a later app draw as the plainest there is, rather than failing the whole snapshot.
    func testAnAimFromALaterAppStillReads() throws {
        let json = #"{"name":"Multiscale","space":null,"kind":"goal","plannedMinutes":60,"aimMinutes":120,"status":{"pill":"Ahead","tone":"blue"}}"#
        let aim = try WidgetJSON.decoder.decode(Snapshot.Aim.self, from: Data(json.utf8))
        XCTAssertEqual(aim.kind, .project)
        XCTAssertEqual(aim.status, .init(pill: "Ahead", tone: .grey))
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

    func testWeeksAndLengthsAreWrittenAsTheAppWritesThem() {
        let fixture = Fixtures.weeks
        XCTAssertGreaterThan(fixture.weeks.count, 4)
        for w in fixture.weeks {
            XCTAssertEqual(Format.weekRange(w.start), w.range, w.start)
            XCTAssertEqual(Format.weekDays(from: w.start), w.days, w.start)
        }
        for m in fixture.minutes {
            XCTAssertEqual(Format.minutes(m.minutes), m.text, "\(m.minutes)")
        }
    }

    /// The Monday of a moment's week, in the snapshot's zone: a Sunday night in Los Angeles is already Monday in UTC.
    func testAMomentsWeekStartsOnItsMonday() {
        let la = TimeZone(identifier: "America/Los_Angeles")!
        XCTAssertEqual(Format.weekStart(Fixtures.instant("2026-11-18T18:04:00Z"), in: la), "2026-11-16")
        XCTAssertEqual(Format.weekStart(Fixtures.instant("2026-11-16T08:00:00Z"), in: la), "2026-11-16")
        XCTAssertEqual(Format.weekStart(Fixtures.instant("2026-11-16T07:59:59Z"), in: la), "2026-11-09")
        XCTAssertEqual(Format.weekStart(Fixtures.instant("2026-11-23T07:59:59Z"), in: la), "2026-11-16")
        XCTAssertEqual(Format.weekStart(Fixtures.instant("2026-11-23T07:59:59Z"), in: TimeZone(identifier: "UTC")!), "2026-11-23")
    }
}
