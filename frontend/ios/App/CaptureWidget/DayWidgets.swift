import SwiftUI
import WidgetCore
import WidgetKit
import WidgetUI

/// The app's look for a widget, from how iOS is drawing it: the app's light or dark in full colour, and one colour on
/// glass on a tinted or clear Home Screen. StandBy at night turns everything red itself.
private struct Looked<Content: View>: View {
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
