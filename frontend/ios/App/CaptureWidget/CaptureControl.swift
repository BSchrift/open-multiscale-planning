import AppIntents
import SwiftUI
import WidgetKit

@main
struct CaptureWidgets: WidgetBundle {
    var body: some Widget {
        CaptureControl()
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
