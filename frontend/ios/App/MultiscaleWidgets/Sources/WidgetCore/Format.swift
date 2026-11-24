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

    /// The next local midnight after a moment.
    public static func nextMidnight(after date: Date, in zone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.nextDate(after: date, matching: DateComponents(hour: 0, minute: 0, second: 0), matchingPolicy: .nextTime) ?? date.addingTimeInterval(86_400)
    }
}
