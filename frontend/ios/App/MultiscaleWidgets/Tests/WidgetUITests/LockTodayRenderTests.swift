import SwiftUI
import WidgetCore
import WidgetTestSupport
@testable import WidgetUI
import XCTest

/// The Lock Screen set and Today, drawn in every state the spec draws, light, dark and tinted, at the default and the
/// largest text size: each fits its size and isn't empty. The Lock Screen's are drawn with a margin of wallpaper round
/// them, since they have no margins of their own, and also as a locked phone with Lock Screen widget access off draws
/// them.
@available(iOS 17.0, macOS 14.0, *)
@MainActor
final class LockTodayRenderTests: XCTestCase {
    private let looks: [WidgetLook] = [.light, .dark, .tinted]

    /// A Lock Screen widget's own size, with the 16-point margin the render frame keeps as wallpaper.
    private func framed(_ size: CGSize) -> CGSize { CGSize(width: size.width + 32, height: size.height + 32) }

    private func size(_ family: LockView.Family) -> CGSize {
        switch family {
        case .inline: WidgetSize.inline
        case .rectangular: WidgetSize.rectangular
        case .countdown, .inbox: WidgetSize.circular
        }
    }

    /// The spec's states, and the ones only these widgets draw differently.
    private var lockStates: [(String, WidgetState)] {
        States.all + [
            ("inbox", States.state("inbox")),
            ("shares", WidgetState(Fixtures.loaded("inbox"), shares: 2000, at: Fixtures.moment("inbox"))),
            ("farnext", States.state("next", at: "2026-11-18T17:30:00Z")),
            ("longblock", longBlock()),
        ]
    }

    private var todayStates: [(String, WidgetState)] {
        States.all + [("busy", busy()), ("busyfinished", busy(finished: true)), ("untitledevent", untitledEvent())]
    }

    func testEveryLockScreenWidgetFitsInEveryStateLookAndTextSize() {
        for family in LockView.Family.allCases {
            for (name, state) in lockStates {
                for look in looks {
                    for text in Render.textSizes {
                        Render.check(LockView(state: state, family: family), size: framed(size(family)), look: look, text: text,
                                     name: ["lock", family.rawValue, name])
                    }
                }
            }
        }
    }

    /// With Lock Screen widget access off, iOS hides names: the placeholders show, and an encrypted space's name stays.
    func testALockedPhoneHidingNamesDrawsThePlaceholders() {
        for family in LockView.Family.allCases {
            for name in ["now", "start", "paused", "free", "finished", "encrypted"] {
                let state = States.all.first { $0.0 == name }!.1
                for look in looks {
                    Render.check(LockView(state: state, family: family), size: framed(size(family)), look: look, text: Render.textSizes[0],
                                 name: ["lock", family.rawValue, name, "locked"], redacted: true)
                }
            }
        }
    }

    func testEveryTodayStateFitsMediumAndLargeInEveryLookAndTextSize() {
        for size in TodayView.Size.allCases {
            for (name, state) in todayStates {
                for look in looks {
                    for text in Render.textSizes {
                        Render.check(TodayView(state: state, size: size), size: size == .medium ? WidgetSize.medium : WidgetSize.large,
                                     look: look, text: text, name: ["today", size.rawValue, name])
                    }
                }
            }
        }
    }

    /// Each Lock Screen widget opens what it shows: Today, or the Inbox for its circle, and Today to sign in.
    func testLockScreenLinks() {
        let now = States.state("now")
        for family in [LockView.Family.inline, .rectangular, .countdown] { XCTAssertEqual(LockView.link(family, now), WidgetLink.today) }
        XCTAssertEqual(LockView.link(.inbox, now), WidgetLink.inbox)
        XCTAssertEqual(LockView.link(.inbox, States.state("signedout")), WidgetLink.today)
        XCTAssertEqual(TodayView.link, WidgetLink.today)
    }

    // MARK: States only these widgets show

    /// More than an hour left, so the countdown shows hours, and a long title.
    private func longBlock() -> WidgetState {
        var s = Fixtures.snapshot("now")
        let i = s.blocks.firstIndex { $0.id == "spec" }!
        s.blocks[i].end = Fixtures.instant("2026-11-18T20:30:00Z")
        s.blocks[i].title = "Write the widget spec, with every state, tap and refresh, and the questions for the owner at the end"
        return WidgetState(.ok(s), at: Fixtures.moment("now"))
    }

    /// A day of twelve half-hour blocks with long titles, in progress or finished, more than either size has rows for.
    private func busy(finished: Bool = false) -> WidgetState {
        var s = Fixtures.snapshot("now")
        let template = s.blocks.first { $0.id == "dentist" }!
        let kinds: [Snapshot.Kind] = [.project, .practice, .oneoff, .planning, .inbox]
        let answers: [Snapshot.Answer?] = [.done, .partly, .not, nil]
        s.blocks = (0..<12).map { i in
            var b = template
            b.id = "busy\(i)"
            b.start = Fixtures.instant("2026-11-18T16:00:00Z").addingTimeInterval(Double(i) * 1800)
            b.end = b.start.addingTimeInterval(1800)
            b.kind = kinds[i % kinds.count]
            b.title = "A block with a title long enough to need cutting, number \(i + 1)"
            b.answer = b.end <= Fixtures.instant("2026-11-18T19:10:00Z") ? answers[i % answers.count] : nil
            b.startedAt = i == 6 && !finished ? b.start : nil
            return b
        }
        return WidgetState(.ok(s), at: Fixtures.instant(finished ? "2026-11-19T02:20:00Z" : "2026-11-18T19:10:00Z"))
    }

    /// An event from a calendar tied to an encrypted space, which reaches the snapshot without its title.
    private func untitledEvent() -> WidgetState {
        var s = Fixtures.snapshot("encrypted")
        s.events[0].title = nil
        return WidgetState(.ok(s), at: Fixtures.moment("encrypted"))
    }
}
