import Foundation

/// What This week shows at a moment, worked out from the snapshot alone: each day's planned time with today marked, each
/// aim's planned time against it with its project's pill, and each practice's sessions. It changes only when the app
/// writes a snapshot or a day turns, so its timeline needs an entry only at midnight (WidgetTimeline.weekEntryDates).
public struct WeekState: Equatable, Sendable {
    public enum Mode: String, Equatable, Sendable {
        /// The week is planned, and the snapshot holds it.
        case planned
        /// The week today is in isn't planned: This week says so and opens Plan.
        case unplanned
        case signedOut
        /// No snapshot yet, or one from an app from before This week.
        case noData
        /// The snapshot holds an earlier week: the app hasn't written one since this week began.
        case newWeek
        /// Written by a later app than this widget.
        case tooNew
    }

    public struct Day: Equatable, Sendable {
        public let date: String
        /// "M", "T", "W".
        public let letter: String
        /// "Monday".
        public let name: String
        public let minutes: Int
        public let isToday: Bool
    }

    public struct AimRow: Equatable, Sendable {
        public let name: WidgetText
        /// For VoiceOver.
        public let said: String
        public let kind: Snapshot.Aim.Kind
        public let planned: Int
        public let aim: Int
        public let status: Snapshot.Aim.Status?

        /// How full its bar is: planned time against the aim, full once it's met.
        public var fraction: Double { aim > 0 ? min(1, Double(planned) / Double(aim)) : 0 }
        /// "7h 30m of 8h", as planning's aim meter writes it.
        public var line: String { "\(Format.minutes(planned)) of \(Format.minutes(aim))" }
    }

    public struct PracticeRow: Equatable, Sendable {
        public let name: WidgetText
        public let said: String
        public let done: Int
        public let of: Int

        /// "2 of 3".
        public var line: String { "\(done) of \(of)" }
    }

    public static let letters = ["M", "T", "W", "T", "F", "S", "S"]
    public static let dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    public let date: Date
    public let mode: Mode
    public let zone: TimeZone
    /// The week today is in: "Nov 16 to 22".
    public let range: String
    /// Monday first, for a planned week; empty otherwise.
    public let days: [Day]
    public let aims: [AimRow]
    public let practices: [PracticeRow]
    /// Set only when the last sync is over an hour old.
    public let staleSince: Date?

    /// Where a tap goes: Week, or Plan while the week isn't planned.
    public var link: URL { mode == .unplanned ? WidgetLink.plan : WidgetLink.week }

    /// The most planned on any one day, which the tallest bar stands for.
    public var mostMinutes: Int { days.map(\.minutes).max() ?? 0 }

    public init(_ loaded: LoadedSnapshot, at date: Date) {
        let zone = loaded.snapshot?.timeZone ?? .current
        let monday = Format.weekStart(date, in: zone)
        self.date = date
        self.zone = zone
        range = Format.weekRange(monday)
        guard case let .ok(s) = loaded, s.signedIn else {
            switch loaded {
            case .tooNew: mode = .tooNew
            case .ok: mode = .signedOut
            case .missing, .unreadable: mode = .noData
            }
            (days, aims, practices, staleSince) = ([], [], [], nil)
            return
        }
        let thisWeek = Format.weekDays(from: monday)
        // Whether a week is planned doesn't change from day to day, so either day the snapshot holds will do.
        let planned = s.days.first { thisWeek.contains($0.date) }?.weekPlanned
        let stale = s.syncedAt.flatMap { date.timeIntervalSince($0) > WidgetState.staleAfter ? $0 : nil }
        guard planned != false else {
            (mode, days, aims, practices, staleSince) = (.unplanned, [], [], [], stale)
            return
        }
        // Without the week to show, the message says to open the app, and when it last synced would add nothing.
        guard let week = s.week else {
            (mode, days, aims, practices, staleSince) = (.noData, [], [], [], nil)
            return
        }
        guard week.start == monday, planned == true else {
            (mode, days, aims, practices, staleSince) = (.newWeek, [], [], [], nil)
            return
        }
        let today = Format.day(date, in: zone)
        mode = .planned
        staleSince = stale
        days = thisWeek.enumerated().map { i, d in
            Day(date: d, letter: WeekState.letters[i], name: WeekState.dayNames[i],
                minutes: i < week.plannedMinutes.count ? week.plannedMinutes[i] : 0, isToday: d == today)
        }
        aims = week.aims.map { a in
            let (shown, said) = WeekState.name(a.name, a.space, of: a.kind == .oneoff ? nil : "project")
            return AimRow(name: shown, said: said, kind: a.kind, planned: a.plannedMinutes, aim: a.aimMinutes, status: a.status)
        }
        practices = week.practices.map { p in
            let (shown, said) = WeekState.name(p.name, p.space, of: "practice")
            return PracticeRow(name: shown, said: said, done: p.done, of: p.of)
        }
    }

    /// A name as a widget may show it: a project's or practice's own, which a locked phone may hide, or for one in an
    /// encrypted space only the space's. One offs is the app's word, not anyone's name.
    private static func name(_ name: String?, _ space: Snapshot.Space?, of thing: String?) -> (WidgetText, String) {
        if let name { return (WidgetText(name, sensitive: thing != nil), name) }
        if let space { return (WidgetText(space.name), "a \(thing ?? "project") in \(space.name)") }
        return (WidgetText(thing == "practice" ? "Practice" : "Project"), "a \(thing ?? "project")")
    }

    /// A length as VoiceOver should say it: "7 hours 30 minutes", "1 hour", "45 minutes", "none".
    public static func spoken(_ minutes: Int) -> String {
        let h = minutes / 60, m = minutes % 60
        let hours = h == 1 ? "1 hour" : "\(h) hours"
        let mins = m == 1 ? "1 minute" : "\(m) minutes"
        if h > 0 && m > 0 { return "\(hours) \(mins)" }
        if h > 0 { return hours }
        return m > 0 ? mins : "none"
    }

    /// One VoiceOver element for the widget, read in order of importance: the week, each day's planned time, the aims
    /// with their pills, and on the large widget, the practices. Medium reads the aims it has room to draw.
    public func label(large: Bool, aimsShown: Int? = nil, practicesShown: Int? = nil, redacted: Bool = false) -> String {
        switch mode {
        case .signedOut: return "This week. Sign in to see your week."
        case .noData: return "This week. Open Multiscale once to show your week here."
        case .newWeek: return "This week, \(range). Open Multiscale to show this week here."
        case .tooNew: return "This week. Open Multiscale to update this widget."
        case .unplanned: return "This week, \(range), isn't planned yet. Plan your week."
        case .planned: break
        }
        func said(_ text: WidgetText, _ said: String, placeholder: String) -> String { redacted && text.sensitive ? placeholder : said }
        let planned = days.map { "\($0.name)\($0.isToday ? ", today," : "") \(WeekState.spoken($0.minutes))" }.joined(separator: ", ")
        var parts = ["This week, \(range). Planned: \(planned)."]
        let aimsRead = aims.prefix(aimsShown ?? aims.count)
        if aimsRead.isEmpty {
            parts.append("No weekly aims.")
        } else {
            let read = aimsRead.map { a in
                let pill = a.status.map { ", \($0.pill)" } ?? ""
                return "\(said(a.name, a.said, placeholder: "a project")) \(WeekState.spoken(a.planned)) of \(WeekState.spoken(a.aim)) planned\(pill)"
            }
            parts.append("Aims: \(read.joined(separator: ". ")).")
        }
        if large {
            let practicesRead = practices.prefix(practicesShown ?? practices.count)
            if !practicesRead.isEmpty {
                let read = practicesRead.map { "\(said($0.name, $0.said, placeholder: "a practice")) \($0.done) of \($0.of) sessions" }
                parts.append("Practices: \(read.joined(separator: ", ")).")
            }
        }
        if let since = staleSince { parts.append("Synced at \(Format.time(since, in: zone)).") }
        return parts.joined(separator: " ")
    }
}

extension WidgetTimeline {
    /// This week's entries: now, then each midnight, when today's bar moves along and a new week begins. Everything else
    /// changes only when the app writes a snapshot, and the app reloads the widget then.
    public static func weekEntryDates(_ loaded: LoadedSnapshot, from now: Date) -> [Date] {
        guard let s = loaded.snapshot, s.signedIn else { return [now] }
        var dates = [now]
        var midnight = Format.nextMidnight(after: now, in: s.timeZone)
        while midnight <= now.addingTimeInterval(horizon) {
            dates.append(midnight)
            midnight = Format.nextMidnight(after: midnight, in: s.timeZone)
        }
        // When the last sync turns stale, and "synced" joins the dates.
        if let synced = s.syncedAt?.addingTimeInterval(WidgetState.staleAfter + 1), synced > now, synced <= now.addingTimeInterval(horizon) {
            dates.append(synced)
        }
        return dates.sorted()
    }
}
