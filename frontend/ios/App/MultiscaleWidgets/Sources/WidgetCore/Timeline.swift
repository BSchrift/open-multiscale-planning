import Foundation

/// When a widget's timeline needs a new entry: only where what it shows changes. The countdown and the bar run live
/// between entries (Text(timerInterval:) and ProgressView(timerInterval:)), so they need none. Entries cost nothing
/// against iOS's daily reload budget; only reloads do, and those are left for real changes.
public enum WidgetTimeline {
    /// The longest timeline asked for at once: iOS asks for the next when it ends.
    public static let horizon: TimeInterval = 24 * 3600
    public static let maxEntries = 240

    /// Each moment from `now` on where the widget changes: now; each block's start and end; midnight; when the last sync
    /// turns stale; when the widget stops offering Undo; each minute of the hour before a block, while "Starts in" counts
    /// down; and each minute of a pause, while "Paused for" counts up.
    public static func entryDates(_ loaded: LoadedSnapshot, from now: Date) -> [Date] {
        guard let s = loaded.snapshot, s.signedIn else { return [now] }
        let end = now.addingTimeInterval(horizon)
        let zone = s.timeZone
        var dates: Set<Date> = [now]
        func add(_ d: Date) { if d > now && d <= end { dates.insert(d) } }
        for b in s.blocks {
            add(b.start)
            add(b.end)
        }
        var midnight = Format.nextMidnight(after: now, in: zone)
        while midnight <= end {
            add(midnight)
            midnight = Format.nextMidnight(after: midnight, in: zone)
        }
        if let synced = s.syncedAt { add(synced.addingTimeInterval(WidgetState.staleAfter + 1)) }
        for r in s.fromWidget { add(r.at.addingTimeInterval(WidgetState.undoFor)) }
        // The hour before each start, a minute at a time, where the widget is waiting on that block.
        for b in s.blocks where b.unanswered && b.start > now {
            for k in 1...60 {
                let d = b.start.addingTimeInterval(TimeInterval(-60 * k))
                guard d > now, d <= end else { continue }
                let state = WidgetState(loaded, at: d)
                if state.mode == .free, state.next?.id == b.id { dates.insert(d) }
            }
        }
        // A pause under way, a minute at a time from when it began, for the next hour or until the block's end.
        if let paused = WidgetState(loaded, at: now).current, let p = paused.pausedAt, paused.startedAt != nil {
            var d = p.addingTimeInterval(60)
            while d <= min(end, now.addingTimeInterval(3600), paused.end) {
                add(d)
                d = d.addingTimeInterval(60)
            }
        }
        return Array(dates.sorted().prefix(maxEntries))
    }

    /// How much the widget matters at a moment, for a Smart Stack: most from ten minutes before a block until its end,
    /// least when nothing more is planned today. With how long that lasts from the moment.
    public static func relevance(_ state: WidgetState) -> (score: Float, duration: TimeInterval) {
        switch state.mode {
        case .now, .start, .paused:
            return (1, max(0, (state.current?.end ?? state.date).timeIntervalSince(state.date)))
        case .free:
            guard let next = state.nextToday else { return (0.3, 0) }
            let lead = next.start.timeIntervalSince(state.date)
            return lead <= 600 ? (1, max(0, next.end.timeIntervalSince(state.date))) : (0.3, lead - 600)
        case .empty, .finished, .signedOut, .noData, .tooNew:
            return (0.1, 0)
        }
    }
}
