import UIKit
import Capacitor

class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShareQueuePlugin())
        bridge?.registerPluginInstance(AppearancePlugin())
    }

    #if DEBUG
    /// XCUITest starts on its test page this way. Release builds always start on the app.
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let page = ProcessInfo.processInfo.environment["MULTISCALE_START_PAGE"] { descriptor.appStartPath = page }
        return descriptor
    }
    #endif
}

/// Settings > Appearance. Light or Dark overrides the phone's setting for the whole window, so the status bar, the
/// keyboard and the web view's background match the page; System goes back to following the phone.
@objc(MultiscaleAppearancePlugin)
class AppearancePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MultiscaleAppearancePlugin"
    let jsName = "MultiscaleAppearance"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
    ]

    @objc func set(_ call: CAPPluginCall) {
        let styles: [String: UIUserInterfaceStyle] = ["light": .light, "dark": .dark]
        let style = styles[call.getString("appearance") ?? ""] ?? .unspecified
        DispatchQueue.main.async {
            let controller = self.bridge?.viewController
            controller?.view.window?.overrideUserInterfaceStyle = style
            controller?.setNeedsStatusBarAppearanceUpdate()
            call.resolve()
        }
    }
}
