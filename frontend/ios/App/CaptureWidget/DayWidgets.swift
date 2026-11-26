import SwiftUI
import WidgetCore
import WidgetKit
import WidgetUI

/// The app's look for a widget, from how iOS is drawing it: the app's light or dark in full colour, and one colour on
/// glass on a tinted or clear Home Screen. StandBy at night turns everything red itself.
struct Looked<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.widgetRenderingMode) private var mode
    @ViewBuilder let content: Content

    private var look: WidgetLook { mode == .fullColor ? (scheme == .dark ? .dark : .light) : .tinted }

    var body: some View {
        content.widgetLook(look).containerBackground(for: .widget) { look.card }
    }
}

/// Now and next: the two-second glance, from the Home Screen, StandBy and a Smart Stack. A tap anywhere but the medium
/// widget's button opens Today with the Now card in view.
struct NowNextWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "now-next", provider: DayProvider()) { entry in
            NowNextEntry(entry: entry)
        }
        .configurationDisplayName("Now and next")
        .description("The block in progress with its countdown, or what's next and when.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct NowNextEntry: View {
    let entry: DayEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Looked {
            NowNextView(state: entry.state, size: family == .systemMedium ? .medium : .small)
        }
        // Buttons run in place on iOS 17 and later, which this extension needs anyway, inactive until a locked phone unlocks.
        .widgetButtons(WidgetButtonMaker { button, label in
            AnyView(Button(intent: WidgetButtonIntent(button)) { label }.buttonStyle(.plain))
        })
        .widgetURL(NowNextView.link)
    }
}

/// Capture: one tap into Capture, and how full the Inbox is.
struct CaptureHomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "capture-home", provider: DayProvider()) { entry in
            Looked { CaptureView(state: entry.state) }
        }
        .configurationDisplayName("Capture")
        .description("Capture a task in one tap, and see how full your Inbox is.")
        .supportedFamilies([.systemSmall])
    }
}

/// This week: whether the week's plan is holding, from the Home Screen. A tap opens Week, or Plan while the week isn't
/// planned. No buttons.
struct WeekWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "this-week", provider: WeekProvider()) { entry in
            WeekEntryView(entry: entry)
        }
        .configurationDisplayName("This week")
        .description("Each day's planned time, your weekly aims and your practices.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

private struct WeekEntryView: View {
    let entry: WeekEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Looked { WeekView(state: entry.state, size: family == .systemLarge ? .large : .medium) }
            .widgetURL(entry.state.link)
    }
}

struct WeekEntry: TimelineEntry {
    let date: Date
    let state: WeekState
}

/// This week's timeline: an entry now and at each midnight, read from the App Group's snapshot. The app reloads it
/// whenever it writes a snapshot, which is when anything else it shows changes.
struct WeekProvider: TimelineProvider {
    func placeholder(in context: Context) -> WeekEntry { WeekProvider.sample(at: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (WeekEntry) -> Void) {
        completion(context.isPreview ? WeekProvider.sample(at: Date()) : WeekProvider.entries(from: Date()).first!)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WeekEntry>) -> Void) {
        completion(Timeline(entries: WeekProvider.entries(from: Date()), policy: .atEnd))
    }

    static func entries(from now: Date) -> [WeekEntry] {
        let loaded = WidgetFiles.appGroup()?.readSnapshot() ?? .missing
        return WidgetTimeline.weekEntryDates(loaded, from: now).map { WeekEntry(date: $0, state: WeekState(loaded, at: $0)) }
    }

    /// The gallery's and the placeholder's: the spec's example week, never anyone's own.
    static func sample(at now: Date) -> WeekEntry {
        WeekEntry(date: now, state: WeekState(.ok(.sample(at: now)), at: now))
    }
}
