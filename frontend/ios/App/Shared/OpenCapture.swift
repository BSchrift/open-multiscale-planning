import AppIntents
import Foundation

/// Opens the app on Capture. iOS runs an intent that opens the app in the app's own process, so this is built into the
/// app as well as the widget. OpenURLIntent can't open a custom scheme from a control, so it hands the app the link
/// the way Capacitor's App plugin hears about any opened URL.
@available(iOS 18.0, *)
struct OpenCapture: AppIntent {
    static let title: LocalizedStringResource = "Capture"
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        // Capacitor's Notification.Name.capacitorOpenURL, spelled out because the widget doesn't link Capacitor.
        NotificationCenter.default.post(
            name: Notification.Name("CapacitorOpenURLNotification"),
            object: ["url": URL(string: "multiscale://capture")!, "options": [:] as [String: Any]]
        )
        return .result()
    }
}
