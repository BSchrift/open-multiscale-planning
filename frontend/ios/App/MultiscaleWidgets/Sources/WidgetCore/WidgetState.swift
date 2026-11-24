import Foundation

/// What a widget shows at one moment, worked out from the snapshot alone, so it moves on at a block's start or end with
/// no help from the app. The states are the spec's, and the block under the clock and the next one are found as the
/// app's own currentBlock and nextBlock find them (core/blocks.ts), which FixtureTests checks moment by moment.
public struct WidgetState: Equatable, Sendable {
    public enum Mode: String, Equatable, Sendable {
        /// A started block under way.
        case now
        /// A block whose time has come that hasn't been started.
        case start
        /// A started block, paused.
        case paused
        /// Nothing under way, and something later today.
        case free
        /// Nothing at all today.
        case empty
        /// Today's blocks are all behind it.
        case finished
        case signedOut
        /// The app hasn't written a snapshot yet.
        case noData
        /// Written by a later app than this widget.
        case tooNew
    }

    public struct Counts: Equatable, Sendable {
        public var done, partly, notDone, toAnswer: Int

        public init(done: Int = 0, partly: Int = 0, notDone: Int = 0, toAnswer: Int = 0) {
            (self.done, self.partly, self.notDone, self.toAnswer) = (done, partly, notDone, toAnswer)
        }
    }

    /// The last sync is this old before a Home Screen widget says when it was.
    public static let staleAfter: TimeInterval = 3600
    /// How long the widget offers Undo after a start from it.
    public static let undoFor: TimeInterval = 5 * 60

    public let date: Date
    public let mode: Mode
    public let zone: TimeZone
    /// The block under the clock, for now, start and paused.
    public let current: Snapshot.Block?
    /// The first unanswered block still to start, on any day.
    public let next: Snapshot.Block?
    /// The one after that.
    public let after: Snapshot.Block?
    /// Tomorrow's first block.
    public let tomorrow: Snapshot.Block?
    /// Today's blocks, by start.
    public let today: [Snapshot.Block]
    /// Today's events from other calendars.
    public let events: [Snapshot.Event]
    public let counts: Counts
    /// The Inbox, with shares still waiting. Nil before the first snapshot and once signed out.
    public let inbox: Int?
    /// Set only when the last sync is over an hour old.
    public let staleSince: Date?
    public let weekPlanned: Bool
    /// A start from the widget on the current block that it still offers to undo.
    public let justStarted: Snapshot.Recent?

    /// The next block, if it's today.
    public var nextToday: Snapshot.Block? {
        guard let next, Format.day(next.start, in: zone) == Format.day(date, in: zone) else { return nil }
        return next
    }

    public init(_ loaded: LoadedSnapshot, shares: Int = 0, at date: Date) {
        guard case let .ok(s) = loaded, s.signedIn else {
            let mode: Mode
            switch loaded {
            case .tooNew: mode = .tooNew
            case .ok: mode = .signedOut
            case .missing, .unreadable: mode = .noData
            }
            self = WidgetState(date: date, mode: mode, zone: loaded.snapshot?.timeZone ?? .current)
            return
        }
        let zone = s.timeZone
        let day = Format.day(date, in: zone)
        let tomorrowDay = Format.day(Format.nextMidnight(after: date, in: zone), in: zone)
        let blocks = s.blocks.sorted { $0.start < $1.start }
        let current = blocks.first { $0.unanswered && $0.start <= date && date < $0.end }
        let upcoming = blocks.filter { $0.unanswered && $0.start > date }
        let today = blocks.filter { Format.day($0.start, in: zone) == day }
        var counts = Counts()
        for b in today {
            switch b.answer {
            case .done: counts.done += 1
            case .partly: counts.partly += 1
            case .not: counts.notDone += 1
            case nil: if b.endedAt != nil || b.end <= date { counts.toAnswer += 1 }
            }
        }
        let next = upcoming.first
        let mode: Mode
        if let current {
            mode = current.startedAt == nil ? .start : current.pausedAt == nil ? .now : .paused
        } else if let next, Format.day(next.start, in: zone) == day {
            mode = .free
        } else {
            mode = today.isEmpty ? .empty : .finished
        }
        self.date = date
        self.mode = mode
        self.zone = zone
        self.current = current
        self.next = next
        self.after = upcoming.dropFirst().first
        self.tomorrow = blocks.first { Format.day($0.start, in: zone) == tomorrowDay }
        self.today = today
        self.events = s.events.filter { Format.day($0.start, in: zone) == day }
        self.counts = counts
        self.inbox = s.inbox.map { $0.count + shares }
        self.staleSince = s.syncedAt.flatMap { date.timeIntervalSince($0) > WidgetState.staleAfter ? $0 : nil }
        self.weekPlanned = s.days.first { $0.date == day }?.weekPlanned ?? false
        self.justStarted = current.flatMap { c in
            s.fromWidget.last { $0.blockId == c.id && date < $0.at.addingTimeInterval(WidgetState.undoFor) }
        }
    }

    private init(date: Date, mode: Mode, zone: TimeZone) {
        self.date = date
        self.mode = mode
        self.zone = zone
        current = nil
        next = nil
        after = nil
        tomorrow = nil
        today = []
        events = []
        counts = Counts()
        inbox = nil
        staleSince = nil
        weekPlanned = false
        justStarted = nil
    }

    // MARK: The countdown

    /// What's left of the current block: frozen where a pause stopped it.
    public var timeLeft: TimeInterval {
        guard let c = current else { return 0 }
        let from = mode == .paused ? min(date, c.pausedAt ?? date) : date
        return max(0, c.end.timeIntervalSince(from))
    }

    /// The live countdown's range, from now to the end, for Text(timerInterval:pauseTime:), with the moment it stopped
    /// at for a pause. A paused range runs from the pause, so the frozen number is what was left then.
    public var countdown: (range: ClosedRange<Date>, pauseTime: Date?)? {
        guard let c = current, mode == .now || mode == .paused else { return nil }
        if mode == .paused, let paused = c.pausedAt {
            let from = min(paused, c.end)
            return (from...c.end, from)
        }
        return (min(date, c.end)...c.end, nil)
    }

    /// How full the bar of time spent is, as ringFill: spent against spent and left, pauses left out.
    public var spentFraction: Double {
        guard let c = current, mode == .now || mode == .paused else { return 0 }
        let started = c.startedAt ?? c.start
        let paused = TimeInterval((c.pausedMin ?? 0) * 60)
        let stop = mode == .paused ? min(date, c.pausedAt ?? date) : date
        let spent = max(0, min(stop, c.end).timeIntervalSince(started) - paused)
        let total = spent + timeLeft
        return total > 0 ? spent / total : 0
    }

    /// The bar's live range for ProgressView(timerInterval:): from when the work began, its past pauses added on, to the
    /// end, so it fills as the countdown runs. Nil when there's nothing to run, as while paused.
    public var spentRange: ClosedRange<Date>? {
        guard let c = current, mode == .now else { return nil }
        let from = (c.startedAt ?? c.start).addingTimeInterval(TimeInterval((c.pausedMin ?? 0) * 60))
        return from < c.end ? min(from, date)...c.end : nil
    }

    /// While paused: for how long so far, in whole minutes, and the end it would have if resumed now.
    public var pausedMinutes: Int {
        guard mode == .paused, let p = current?.pausedAt else { return 0 }
        return max(0, Int((date.timeIntervalSince(p) / 60).rounded(.down)))
    }

    public var endsIfResumed: Date? {
        guard mode == .paused, let c = current, let p = c.pausedAt else { return nil }
        let minutes = Int((date.timeIntervalSince(p) / 60).rounded(.toNearestOrAwayFromZero))
        return c.end.addingTimeInterval(TimeInterval(max(0, minutes) * 60))
    }

    /// Whole minutes until the next block starts, rounded up, as "Starts in 12 min" says, in the hour before it. Further
    /// off, the widget gives its time instead, which needs no entry a minute.
    public var minutesToNext: Int? {
        guard mode == .free, let next = nextToday else { return nil }
        let minutes = Int((next.start.timeIntervalSince(date) / 60).rounded(.up))
        return minutes <= 60 ? minutes : nil
    }
}
