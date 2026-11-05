import UIKit
import Capacitor

class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShareQueuePlugin())
        bridge?.registerPluginInstance(AppearancePlugin())
        bridge?.registerPluginInstance(DiagnosticsPlugin())
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

/// How the app runs, for telemetry: its memory footprint, iOS's memory warnings, and how the last run ended. Each sample
/// is saved as it's taken, so a run iOS kills still leaves its last numbers for the next run to report.
@objc(MultiscaleDiagnosticsPlugin)
class DiagnosticsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MultiscaleDiagnosticsPlugin"
    let jsName = "MultiscaleDiagnostics"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise),
    ]
    private static let key = "multiscale.diagnostics.run"
    private let started = Date()
    private var previous: [String: Any]?
    private var peak = 0
    private var warnings = 0
    private var pageLoads = 0
    // active, background or terminated: the last one saved says how the run ended.
    private var state = "active"
    private var timer: Timer?

    override func load() {
        previous = UserDefaults.standard.dictionary(forKey: Self.key)
        sample()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.sample() }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(memoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
        center.addObserver(self, selector: #selector(moved(_:)), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(moved(_:)), name: UIApplication.willEnterForegroundNotification, object: nil)
        center.addObserver(self, selector: #selector(moved(_:)), name: UIApplication.willTerminateNotification, object: nil)
    }

    /// The phys_footprint iOS judges memory limits by, in bytes.
    static func footprint() -> Int {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Int(info.phys_footprint) : 0
    }

    @discardableResult private func sample() -> Int {
        let now = Self.footprint()
        peak = max(peak, now)
        UserDefaults.standard.set([
            "peak": peak, "last": now, "warnings": warnings, "state": state,
            "uptime": Int(Date().timeIntervalSince(started)),
        ], forKey: Self.key)
        return now
    }

    @objc private func memoryWarning() {
        warnings += 1
        sample()
        notifyListeners("memoryWarning", data: [:])
    }

    @objc private func moved(_ note: Notification) {
        switch note.name {
        case UIApplication.didEnterBackgroundNotification: state = "background"
        case UIApplication.willTerminateNotification: state = "terminated"
        default: state = "active"
        }
        sample()
    }

    /// On the main thread, where the timer and the notifications also change these numbers.
    @objc func snapshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pageLoads += 1
            var machine = utsname()
            uname(&machine)
            let model = withUnsafeBytes(of: &machine.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
            let os = ProcessInfo.processInfo.operatingSystemVersion
            var result: [String: Any] = [
                "footprint": self.sample(), "peak": self.peak, "warnings": self.warnings, "pageLoads": self.pageLoads,
                "model": model, "osVersion": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            ]
            // Reported once: a reload of the page in this run shouldn't report the last run again.
            if let last = self.previous, self.pageLoads == 1 { result["previous"] = last }
            call.resolve(result)
        }
    }
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
