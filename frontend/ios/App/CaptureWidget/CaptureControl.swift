import AppIntents
import SwiftUI
import WidgetKit

@main
struct CaptureWidgets: WidgetBundle {
    var body: some Widget {
        CaptureControl()
        // Only in a build with the App Group, where the app writes what they draw: without one they'd have nothing.
        #if MULTISCALE_APP_GROUP
        NowNextWidget()
        CaptureHomeWidget()
        LockNowWidget()
        LockInboxWidget()
        TodayWidget()
        #endif
    }
}

struct CaptureControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "capture") {
            ControlWidgetButton(action: OpenCapture()) {
                Label("Capture", systemImage: "plus")
            }
        }
        .displayName("Capture")
        .description("Capture a task in Multiscale.")
    }
}
