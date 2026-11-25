import Foundation

/// One row of the Today widget: a block of today's, or an event from another calendar, with its state in words.
public struct DayRow: Equatable, Sendable, Identifiable {
    public enum Status: Equatable, Sendable {
        case now, paused, notStarted, planned, done, partly, notDone, toAnswer, event
    }

    public let id: String
    /// Nil for an event, which isn't a block of the app's.
    public let blockId: String?
    public let start: Date
    /// The start as the time column writes it, "10:30am".
    public let time: String
    /// Nil for an event, drawn as a grey stripe.
    public let kind: Snapshot.Kind?
    public let shown: WidgetText
    public let status: Status
    /// For VoiceOver: "9am, Write widget spec, now".
    public let said: String

    /// Today at this block, brought into view; an event's row opens Today itself.
    public var link: URL { blockId.map(WidgetLink.today(block:)) ?? WidgetLink.today }
}

extension WidgetState.Counts {
    /// The folded line's words, naming only what happened: "2 done, 1 partly".
    public var earlierSaid: String {
        [(done, "done"), (partly, "partly"), (notDone, "not done"), (toAnswer, "to answer")]
            .filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }.joined(separator: ", ")
    }

    var isEmpty: Bool { done + partly + notDone + toAnswer == 0 }
}

extension WidgetState {
    private func status(_ b: Snapshot.Block) -> DayRow.Status {
        switch b.answer {
        case .done: return .done
        case .partly: return .partly
        case .not: return .notDone
        case nil: break
        }
        if b.id == current?.id { return mode == .paused ? .paused : mode == .start ? .notStarted : .now }
        return b.endedAt != nil || b.end <= date ? .toAnswer : .planned
    }

    private func row(_ b: Snapshot.Block) -> DayRow {
        let name = BlockName(b)
        let st = status(b)
        let word: [DayRow.Status: String] = [.now: ", now", .paused: ", paused", .notStarted: ", not started", .done: ", done",
                                             .partly: ", partly", .notDone: ", not done", .toAnswer: ", to answer"]
        return DayRow(id: b.id, blockId: b.id, start: b.start, time: time(b.start), kind: b.kind, shown: name.shown, status: st,
                      said: "\(time(b.start)), \(name.said)\(word[st] ?? "")")
    }

    private func row(_ e: Snapshot.Event) -> DayRow {
        let shown = e.title.map { WidgetText($0, sensitive: true) } ?? WidgetText("Calendar event")
        let said = e.title.map { "\(time(e.start)), \($0), calendar event" } ?? "\(time(e.start)), calendar event"
        return DayRow(id: "event-\(Int(e.start.timeIntervalSince1970))-\(Int(e.end.timeIntervalSince1970))", blockId: nil,
                      start: e.start, time: time(e.start), kind: nil, shown: shown, status: .event, said: said)
    }

    private func counts(_ blocks: [Snapshot.Block]) -> Counts {
        var c = Counts()
        for b in blocks {
            switch status(b) {
            case .done: c.done += 1
            case .partly: c.partly += 1
            case .notDone: c.notDone += 1
            default: c.toAnswer += 1
            }
        }
        return c
    }

    /// Today's rows, at most `limit`: from the block in progress on, with the blocks behind it folded into counts and
    /// the events behind it dropped. A finished day keeps every row, and past the limit folds its earliest instead, so
    /// the blocks still to answer, which come last, stay in view.
    public func day(limit: Int) -> (earlier: Counts?, rows: [DayRow]) {
        guard [.now, .start, .paused, .free, .finished].contains(mode) else { return (nil, []) }
        // Blocks before events that start with them, as Today draws them.
        let all = (today.map { (block: Optional($0), end: $0.end, row: row($0)) } + events.map { (block: nil, end: $0.end, row: row($0)) })
            .enumerated().sorted { ($0.element.row.start, $0.offset) < ($1.element.row.start, $1.offset) }.map(\.element)
        let behind: ArraySlice<(block: Snapshot.Block?, end: Date, row: DayRow)>
        let rows: [DayRow]
        if mode == .finished {
            let cut = max(0, all.count - limit)
            behind = all.prefix(cut)
            rows = all.dropFirst(cut).map(\.row)
        } else {
            behind = all.filter { $0.end <= date }[...]
            rows = all.filter { $0.end > date }.prefix(limit).map(\.row)
        }
        let folded = counts(behind.compactMap(\.block))
        return (folded.isEmpty ? nil : folded, rows)
    }

    /// The line on top: "Today" or "Free until 11am", then the date, or when the last sync was once it's over an hour old.
    public var todayHead: (left: String, right: String) {
        let left = mode == .free ? nextToday.map { "Free until \(time($0.start))" } ?? "Today" : "Today"
        return (left, staleSince.map { "Synced at \(time($0))" } ?? Format.dayLong(date, in: zone))
    }

    public var todayHeadSaid: String {
        let free = mode == .free ? nextToday.map { " Free until \(time($0.start))." } ?? "" : ""
        let synced = staleSince.map { " Synced at \(time($0))." } ?? ""
        return "Today, \(Format.dayLong(date, in: zone)).\(free)\(synced)"
    }

    /// The large widget's last line on a finished day: tomorrow's first block.
    public var tomorrowSaid: String? {
        tomorrow.map { "Tomorrow at \(time($0.start)): \(BlockName($0).said)" }
    }

    /// The medium widget, one element read in order, with the rows it shows.
    public func todayLabel(limit: Int) -> String {
        switch mode {
        case .signedOut: return "Today. Sign in to see your day."
        case .noData: return "Today. Open Multiscale once to show your day here."
        case .tooNew: return "Today. Open Multiscale to update this widget."
        case .empty:
            let week = weekPlanned ? "" : " This week isn't planned yet."
            let inbox = inbox.map { $0 == 0 ? " Inbox is empty." : " \($0) in Inbox." } ?? ""
            return "Today. Nothing planned today.\(week)\(inbox)"
        case .finished:
            return "Today. Nothing else planned today. \(countsSaid).\(tomorrowSaid.map { " \($0)." } ?? "")"
        case .now, .start, .paused, .free:
            let free = mode == .free ? nextToday.map { " Free until \(time($0.start))." } ?? "" : ""
            let rows = day(limit: limit).rows.map { " \($0.said)." }.joined()
            let synced = staleSince.map { " Synced at \(time($0))." } ?? ""
            return "Today, \(Format.dayLong(date, in: zone)).\(free)\(rows)\(synced)"
        }
    }
}
