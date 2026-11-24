import SwiftUI
import WidgetCore
import WidgetTestSupport
@testable import WidgetUI
import XCTest

@available(iOS 17.0, macOS 14.0, *)
/// The states every This week render covers: each the spec draws, from the app's own fixtures, and the weeks that
/// stretch it: long names, more aims and practices than fit, a busy week with an overdue project, and no aims at all.
@MainActor
enum Weeks {
    static func week(_ name: String, at time: String? = nil) -> WeekState {
        WeekState(Fixtures.loaded(name), at: time.map(Fixtures.instant) ?? Fixtures.moment(name))
    }

    static func changed(_ change: (inout Snapshot.Week) -> Void) -> WeekState {
        var s = Fixtures.snapshot("now")
        change(&s.week!)
        return WeekState(.ok(s), at: Fixtures.moment("now"))
    }

    static var all: [(String, WeekState)] {
        [
            ("planned", week("now")), ("stale", week("stale")), ("encrypted", week("encrypted")),
            ("unplanned", week("empty")), ("signedout", week("signedout")),
            ("nodata", WeekState(.missing, at: Fixtures.moment("now"))), ("toonew", WeekState(.tooNew, at: Fixtures.moment("now"))),
            ("newweek", week("now", at: "2026-11-23T17:00:00Z")),
            ("noaims", changed { $0.aims = []; $0.practices = [] }),
            ("longnames", changed { w in
                w.aims[0].name = "Plant the spring bulbs along the whole of the back fence before the ground freezes"
                w.practices[0].name = "Piano scales, arpeggios and the slow movement, every evening after dinner"
            }),
            ("many", changed { w in
                w.aims = (1...10).map { .init(name: "Project \($0)", kind: .project, plannedMinutes: $0 * 30, aimMinutes: 300, status: .init(pill: "On track", tone: .green)) }
                w.practices = (1...10).map { .init(name: "Practice \($0)", done: $0 % 4, of: 7) }
            }),
            ("busy", changed { w in
                w.plannedMinutes = [600, 540, 720, 480, 660, 240, 120]
                w.aims[0] = .init(name: "Garden", kind: .project, plannedMinutes: 900, aimMinutes: 120, status: .init(pill: "Past end date", tone: .red))
                w.aims[1].status = .init(pill: "Overdue", tone: .red)
                w.practices[1] = .init(name: "Run", done: 5, of: 3)
            }),
        ]
    }
}

@available(iOS 17.0, macOS 14.0, *)
@MainActor
final class WeekRenderTests: XCTestCase {
    /// Every state, medium and large, in light, dark and tinted, at the default and the largest text size: it fits its
    /// size and isn't empty. Each is saved as widget-week-<size>-<state>-<look>-<text>.png for review.
    func testEveryWeekStateFitsItsSizeInEveryLookAtEveryTextSize() {
        for (name, state) in Weeks.all {
            for size in WeekView.Size.allCases {
                for look in [WidgetLook.light, .dark, .tinted] {
                    for text in Render.textSizes {
                        Render.check(WeekView(state: state, size: size), size: size == .medium ? WidgetSize.medium : WidgetSize.large,
                                     look: look, text: text, name: ["week", size.rawValue, name])
                    }
                }
            }
        }
    }

    /// A locked iPad with Lock Screen widget access off draws placeholders for names, and still fits.
    func testNamesHiddenOnALockedDeviceStillFit() {
        for name in ["planned", "encrypted"] {
            let state = Weeks.all.first { $0.0 == name }!.1
            for size in WeekView.Size.allCases {
                Render.check(WeekView(state: state, size: size), size: size == .medium ? WidgetSize.medium : WidgetSize.large,
                             look: .light, text: Render.textSizes[0], name: ["week", size.rawValue, name, "locked"], redacted: true)
            }
        }
    }

    /// At larger text, less rather than smaller, and the aims go last: practices first, then aims beyond one, then the
    /// bars, so the largest text still shows an aim and its pill rather than only the days.
    func testLargerTextDropsPracticesThenBarsBeforeTheLastAim() {
        for (name, state) in Weeks.all where state.mode == .planned && !state.aims.isEmpty {
            for size in WeekView.Size.allCases {
                let layouts = WeekView.layouts(state, size)
                XCTAssertEqual(layouts.first?.aims, min(state.aims.count, 3), "\(name) \(size)")
                for layout in layouts {
                    XCTAssertGreaterThan(layout.aims, 0, "\(name) \(size) \(layout)")
                    if !layout.bars { XCTAssertEqual(layout.practices, 0, "\(name) \(size) \(layout)") }
                }
                XCTAssertEqual(layouts.last, .init(header: false, bars: false, aims: 1), "\(name) \(size)")
            }
        }
    }

    /// A tap opens Week, or Plan while the week isn't planned.
    func testATapOpensWeekOrPlan() {
        XCTAssertEqual(WeekView(state: Weeks.week("now"), size: .medium).link, WidgetLink.week)
        XCTAssertEqual(WeekView(state: Weeks.week("empty"), size: .large).link, WidgetLink.plan)
        XCTAssertEqual(WeekView(state: Weeks.week("signedout"), size: .large).link, WidgetLink.week)
    }
}
