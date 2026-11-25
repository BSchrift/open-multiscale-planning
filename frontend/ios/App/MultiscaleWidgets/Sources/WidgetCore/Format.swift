import Foundation

/// Times and lengths written as the app writes them (frontend/src/core/dates.ts), which FixtureTests checks against
/// the app's own output.
public enum Format {
    /// "9am", "10:30am", "12pm", in the given zone.
    public static func time(_ date: Date, in zone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let h = parts.hour ?? 0, m = parts.minute ?? 0
        let hour = h % 12 == 0 ? 12 : h % 12
        return "\(hour)\(m == 0 ? "" : String(format: ":%02d", m))\(h < 12 ? "am" : "pm")"
    }

    /// "45m", "2h", "1h 30m", as formatMinutes.
    public static func minutes(_ minutes: Int) -> String {
        let h = minutes / 60, m = minutes % 60
        if h > 0 && m > 0 { return "\(h)h \(m)m" }
        return h > 0 ? "\(h)h" : "\(m)m"
    }

    /// How long a pause has run, in words: "1 minute", "12 minutes", "1h 10m", or where room is short, "12 min".
    public static func pause(_ minutes: Int, short: Bool = false) -> String {
        if minutes >= 60 { return Format.minutes(minutes) }
        if short { return "\(minutes) min" }
        return minutes == 1 ? "1 minute" : "\(minutes) minutes"
    }

    /// The local day, "2026-11-18".
    public static func day(_ date: Date, in zone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// "Wednesday, Nov 18", as formatDayLong, in the given zone.
    public static func dayLong(_ date: Date, in zone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.weekday, .month, .day], from: date)
        let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return "\(weekdays[(parts.weekday ?? 1) - 1]), \(months[(parts.month ?? 1) - 1]) \(parts.day ?? 1)"
    }

    /// The days of a week from its Monday, "2026-11-16" to "2026-11-22", as weekDates.
    public static func weekDays(from start: String) -> [String] {
        let utc = TimeZone(identifier: "UTC")!
        guard let monday = ISO8601DateFormatter().date(from: "\(start)T12:00:00Z") else { return [] }
        return (0..<7).map { day(monday.addingTimeInterval(TimeInterval($0) * 86_400), in: utc) }
    }

    /// The Monday of the week a moment falls in, in the given zone.
    public static func weekStart(_ date: Date, in zone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let weekday = calendar.component(.weekday, from: date)
        return Format.day(calendar.date(byAdding: .day, value: -((weekday + 5) % 7), to: date) ?? date, in: zone)
    }

    /// "Nov 16 to 22", or "Nov 30 to Dec 6" across months, as formatWeekRange.
    public static func weekRange(_ start: String) -> String {
        let days = weekDays(from: start)
        guard let end = days.last else { return start }
        func date(_ d: String) -> String { "\(monthName(d)) \(Int(d.suffix(2)) ?? 0)" }
        return "\(date(start)) to \(end.dropLast(3) == start.dropLast(3) ? String(Int(end.suffix(2)) ?? 0) : date(end))"
    }

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    private static func monthName(_ day: String) -> String {
        let m = Int(day.dropFirst(5).prefix(2)) ?? 1
        return months[max(0, min(11, m - 1))]
    }

    /// The next local midnight after a moment.
    public static func nextMidnight(after date: Date, in zone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.nextDate(after: date, matching: DateComponents(hour: 0, minute: 0, second: 0), matchingPolicy: .nextTime) ?? date.addingTimeInterval(86_400)
    }
}
