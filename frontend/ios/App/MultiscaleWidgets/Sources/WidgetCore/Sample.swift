import Foundation

extension Snapshot {
    /// The spec's example day around a moment, for the widget gallery and placeholders, which show before any real
    /// snapshot is read: a block in progress with 26 minutes left, then the next, in a planned week. Never written to the
    /// App Group.
    public static func sample(at now: Date, zone: TimeZone = .current) -> Snapshot {
        let minute: TimeInterval = 60
        func block(_ id: String, _ title: String, _ kind: Kind, from: Double, to: Double, started: Bool = false) -> Block {
            let start = now.addingTimeInterval(from * minute)
            return Block(id: id, rev: "sample", start: start, end: now.addingTimeInterval(to * minute), kind: kind, title: title, space: nil,
                         startedAt: started ? start : nil, pausedAt: nil, pausedMin: nil, endedAt: nil, answer: nil)
        }
        let day = Format.day(now, in: zone)
        return Snapshot(
            v: Snapshot.version, writtenAt: now, syncedAt: now, zone: zone.identifier, signedIn: true,
            days: [Day(date: day, weekPlanned: true)],
            blocks: [
                block("sample-now", "Write widget spec", .project, from: -64, to: 26, started: true),
                block("sample-next", "Call the dentist", .oneoff, from: 56, to: 71),
                block("sample-after", "Review pull requests", .project, from: 176, to: 236),
            ],
            events: [], inbox: Inbox(count: 4), fromWidget: [],
            week: Week(
                start: Format.weekStart(now, in: zone), plannedMinutes: [300, 330, 360, 240, 300, 60, 0],
                aims: [Aim(name: "Multiscale", kind: .project, plannedMinutes: 390, aimMinutes: 480, status: .init(pill: "On track", tone: .green)),
                       Aim(name: "One offs", kind: .oneoff, plannedMinutes: 60, aimMinutes: 120, status: nil)],
                practices: [Practice(name: "Run", done: 2, of: 3), Practice(name: "Piano", done: 1, of: 2)]
            )
        )
    }
}
