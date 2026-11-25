import SwiftUI
import WidgetCore
import WidgetKit
import WidgetUI

/// The Lock Screen's Now and next: a line beside the date, a rectangular card, or the countdown circle. A tap opens
/// Today after unlock.
struct LockNowWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "lock-now-next", provider: DayProvider()) { entry in
            LockEntry(state: entry.state, family: nil)
        }
        .configurationDisplayName("Now and next")
        .description("The block in progress and its countdown, or what's next, without unlocking.")
        .supportedFamilies([.accessoryInline, .accessoryRectangular, .accessoryCircular])
    }
}

/// The Lock Screen's Inbox circle: how full the Inbox is. A tap opens the Inbox after unlock. The Capture control can
/// already sit in the Lock Screen's corner, so there's no second Capture button.
struct LockInboxWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "lock-inbox", provider: DayProvider()) { entry in
            LockEntry(state: entry.state, family: .inbox)
        }
        .configurationDisplayName("Inbox")
        .description("How many items are waiting in your Inbox.")
        .supportedFamilies([.accessoryCircular])
    }
}

/// iOS draws Lock Screen widgets in one vibrant colour on the wallpaper, from the content's own brightness, so they
/// take the one-colour look, with no background but the circles' own.
private struct LockEntry: View {
    let state: WidgetState
    let family: LockView.Family?
    @Environment(\.widgetFamily) private var widgetFamily

    private var shown: LockView.Family {
        if let family { return family }
        switch widgetFamily {
        case .accessoryInline: return .inline
        case .accessoryRectangular: return .rectangular
        default: return .countdown
        }
    }

    var body: some View {
        LockView(state: state, family: shown)
            .widgetLook(.tinted)
            .containerBackground(for: .widget) { Color.clear }
            .widgetURL(LockView.link(shown, state))
    }
}

/// Today: the rest of the day, medium or large. Large's rows each open Today at their block, and its last line the Inbox;
/// anywhere else opens Today.
struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "today", provider: DayProvider()) { entry in
            TodayEntry(state: entry.state)
        }
        .configurationDisplayName("Today")
        .description("The rest of your day, with each block one tap from Today.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

private struct TodayEntry: View {
    let state: WidgetState
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Looked { TodayView(state: state, size: family == .systemLarge ? .large : .medium) }
            .widgetURL(TodayView.link)
    }
}
