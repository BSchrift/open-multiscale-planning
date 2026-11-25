import Foundation

/// The Lock Screen set: a line beside the date, a rectangular card, a countdown circle and an Inbox circle. iOS draws
/// them in one vibrant colour, so state is carried by the live dot, the ring and words, never colour. Names are marked
/// for iOS to hide on a locked phone with Lock Screen widget access off; `redacted` is that phone, which reads the
/// placeholders instead. An encrypted space's block shows its space's name, which is never hidden.
extension WidgetState {
    /// The mark before the inline line: the live dot while a block runs, a clock while something waits.
    public enum InlineMark: Equatable, Sendable { case live, clock, today }

    /// What the rectangular card shows under its name.
    public enum LockFoot: Equatable, Sendable {
        /// The live countdown and the bar of time spent, or the last sync once that's over an hour old.
        case countdown
        /// A line of words, longest first, for the first that fits.
        case words([String])
        case none
    }

    public struct LockCard: Equatable, Sendable {
        public let eyebrow: String
        public let title: WidgetText
        public let foot: LockFoot
        /// What VoiceOver reads, without the widget's name.
        let said: String
    }

    /// The countdown circle: a ring of time spent, and what sits inside it.
    public struct LockRing: Equatable, Sendable {
        public enum Middle: Equatable, Sendable {
            case countdown, paused, notStarted
            /// Whole minutes to the next block, in the hour before it.
            case minutes(Int)
            /// The next block's time, further off.
            case at(String)
            case today
        }

        public let middle: Middle
        public let fill: Double

        public init(middle: Middle, fill: Double) {
            self.middle = middle
            self.fill = fill
        }
    }

    private func lockName(_ block: Snapshot.Block, current: Bool, redacted: Bool) -> BlockName {
        let name = BlockName(block)
        return redacted ? name.redacted(current: current) : name
    }

    /// A line of words with a name in it, hidden on a locked phone only when the name is.
    private func line(_ text: String, _ name: BlockName) -> WidgetText {
        WidgetText(text, sensitive: name.shown.sensitive)
    }

    // MARK: Inline

    /// One short line beside the date, "Until 10:30am · Write widget spec", and what VoiceOver reads of it.
    public func inline(redacted: Bool = false) -> (mark: InlineMark, text: WidgetText, said: String) {
        switch mode {
        case .now, .paused, .start:
            let c = current!
            let n = lockName(c, current: true, redacted: redacted)
            switch mode {
            case .now: return (.live, line("Until \(time(c.end)) · \(n.shown.text)", n), "Now: \(n.said), until \(time(c.end))")
            case .paused: return (.clock, line("Paused · \(n.shown.text)", n), "Paused: \(n.said)")
            default: return (.clock, line("Not started · \(n.shown.text)", n), "\(n.said), not started")
            }
        case .free:
            let next = nextToday!
            let n = lockName(next, current: false, redacted: redacted)
            return (.clock, line("\(time(next.start)) · \(n.shown.text)", n), "Next at \(time(next.start)): \(n.said)")
        case .empty:
            return (.today, WidgetText("Nothing planned today"), "Nothing planned today")
        case .finished:
            guard let t = tomorrow else { return (.today, WidgetText("Nothing else planned today"), "Nothing else planned today") }
            let n = lockName(t, current: false, redacted: redacted)
            return (.today, line("Tomorrow \(time(t.start)) · \(n.shown.text)", n), "Tomorrow at \(time(t.start)): \(n.said)")
        case .signedOut:
            return (.today, WidgetText("Sign in to Multiscale"), "Sign in to Multiscale")
        case .noData:
            return (.today, WidgetText("Open Multiscale"), "Open Multiscale once to show your day")
        case .tooNew:
            return (.today, WidgetText("Open Multiscale"), "Open Multiscale to update this widget")
        }
    }

    public func inlineLabel(redacted: Bool = false) -> String { "Now and next. \(inline(redacted: redacted).said)." }

    // MARK: Rectangular

    /// "1 block to answer today", and shorter.
    private var toAnswerFoot: LockFoot {
        let n = counts.toAnswer
        guard n > 0 else { return .none }
        return .words(["\(n) \(n == 1 ? "block" : "blocks") to answer today", "\(n) to answer"])
    }

    /// The rectangular card: a few words on top, the name, and the countdown or a line under it.
    public func rectangular(redacted: Bool = false) -> LockCard {
        switch mode {
        case .now:
            let c = current!
            let n = lockName(c, current: true, redacted: redacted)
            let synced = staleSince.map { " Synced at \(time($0))." } ?? ""
            return LockCard(eyebrow: "Now, until \(time(c.end))", title: n.shown, foot: .countdown, said: "Now: \(n.said), ends at \(time(c.end)).\(synced)")
        case .start:
            let c = current!
            let n = lockName(c, current: true, redacted: redacted)
            return LockCard(eyebrow: "Now, \(time(c.start)) to \(time(c.end))", title: n.shown, foot: .words(["Not started"]),
                            said: "\(n.said), \(time(c.start)) to \(time(c.end)), not started.")
        case .paused:
            let c = current!
            let n = lockName(c, current: true, redacted: redacted)
            let ends = time(endsIfResumed ?? c.end)
            return LockCard(eyebrow: "Paused for \(Format.pause(pausedMinutes))", title: n.shown,
                            foot: .words(["Ends at \(ends) unless you resume", "Ends at \(ends)"]),
                            said: "Paused: \(n.said). Ends at \(ends) unless you resume.")
        case .free:
            let next = nextToday!
            let n = lockName(next, current: false, redacted: redacted)
            let starts = minutesToNext.map { "Starts in \($0) min" } ?? "Starts at \(time(next.start))"
            return LockCard(eyebrow: "Free until \(time(next.start)). Next:", title: n.shown, foot: .words([starts]),
                            said: "Free until \(time(next.start)). Next: \(n.said).")
        case .empty:
            return LockCard(eyebrow: "Today", title: WidgetText("Nothing planned"), foot: .none, said: "Nothing planned today.")
        case .finished:
            let answer: String = {
                guard case let .words(w) = toAnswerFoot else { return "" }
                return " \(w[0])."
            }()
            guard let t = tomorrow else {
                return LockCard(eyebrow: "Today", title: WidgetText("Nothing else planned"), foot: toAnswerFoot, said: "Nothing else planned today.\(answer)")
            }
            let n = lockName(t, current: false, redacted: redacted)
            return LockCard(eyebrow: "Tomorrow, \(time(t.start))", title: n.shown, foot: toAnswerFoot,
                            said: "Tomorrow at \(time(t.start)): \(n.said).\(answer)")
        case .signedOut:
            return LockCard(eyebrow: "Multiscale", title: WidgetText("Sign in to see your day"), foot: .none, said: "Sign in to see your day.")
        case .noData:
            return LockCard(eyebrow: "Multiscale", title: WidgetText("Open the app once"), foot: .none, said: "Open Multiscale once to show your day.")
        case .tooNew:
            return LockCard(eyebrow: "Multiscale", title: WidgetText("Open the app to update"), foot: .none, said: "Open Multiscale to update this widget.")
        }
    }

    public func rectangularLabel(redacted: Bool = false) -> String { "Now and next. \(rectangular(redacted: redacted).said)" }

    // MARK: Circles

    /// The countdown circle. It shows no names, so a locked phone hides nothing in it.
    public var ring: LockRing {
        switch mode {
        case .now: LockRing(middle: .countdown, fill: spentFraction)
        case .paused: LockRing(middle: .paused, fill: spentFraction)
        case .start: LockRing(middle: .notStarted, fill: 0)
        case .free: LockRing(middle: minutesToNext.map { .minutes($0) } ?? .at(time(nextToday!.start)), fill: 0)
        case .empty, .finished, .signedOut, .noData, .tooNew: LockRing(middle: .today, fill: 0)
        }
    }

    /// With the end time rather than minutes left, since a label can't tick.
    public var ringLabel: String {
        switch mode {
        case .now: return "Countdown, ends at \(time(current!.end))."
        case .paused: return "Countdown, paused. Ends at \(time(endsIfResumed ?? current!.end)) unless you resume."
        case .start: return "Countdown, not started."
        case .free: return "Next block starts at \(time(nextToday!.start))."
        case .empty: return "Nothing planned today."
        case .finished: return "Nothing else today."
        case .signedOut: return "Sign in to Multiscale."
        case .noData, .tooNew: return "Open Multiscale."
        }
    }

    /// The Inbox circle: the count, with shares still waiting, up to three figures; none before the first snapshot or
    /// once signed out.
    public var inboxCircle: (count: String?, said: String) {
        guard let inbox else { return (nil, "Inbox.") }
        let count = inbox > 999 ? "999+" : "\(inbox)"
        switch inbox {
        case 0: return (count, "Inbox is empty.")
        case 1: return (count, "Inbox, 1 item.")
        default: return (count, "Inbox, \(inbox) items.")
        }
    }
}
