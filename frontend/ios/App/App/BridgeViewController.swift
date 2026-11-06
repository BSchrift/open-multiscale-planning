import UIKit
import Capacitor
import CryptoKit

class BridgeViewController: CAPBridgeViewController {
    /// The web bundle loaded: the one inside the app, or a newer one downloaded over the air.
    private(set) var web = WebBundles.newest()
    private var trial: Timer?
    private var backgroundAt: Date?
    /// Kept until the page loaded after the rollback asks, so telemetry can report it.
    var rolledBack: Int?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShareQueuePlugin())
        bridge?.registerPluginInstance(AppearancePlugin())
        bridge?.registerPluginInstance(DiagnosticsPlugin())
        bridge?.registerPluginInstance(UpdatesPlugin())
        startTrial()
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.backgroundAt = Date() }
        // Back after half an hour away, nobody is mid-task: the moment to switch to a downloaded update.
        center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            if let away = self?.backgroundAt, Date().timeIntervalSince(away) >= 30 * 60 { self?.applyNewest() }
        }
    }

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        #if DEBUG
        // XCUITest starts on its test page this way, which only the bundle inside the app has. Release builds always
        // start on the app.
        if let page = ProcessInfo.processInfo.environment["MULTISCALE_START_PAGE"] {
            descriptor.appStartPath = page
            web = (WebBundles.embeddedRoot, WebBundles.embedded?.build ?? 0)
            return descriptor
        }
        #endif
        descriptor.appLocation = web.root
        return descriptor
    }

    /// Reloads into the newest bundle this app can run, when that's newer than the one loaded.
    func applyNewest() {
        let next = WebBundles.newest()
        if next.build > web.build { load(next) }
    }

    /// The loaded bundle started and drew the app, so it's kept.
    func confirm() {
        trial?.invalidate()
        trial = nil
        if web.root != WebBundles.embeddedRoot { WebBundles.confirm(web.build) }
    }

    private func load(_ next: (root: URL, build: Int)) {
        web = next
        setServerBasePath(path: next.root.path)
        startTrial()
    }

    /// A download that hasn't started before goes back unless it reports ready in time.
    private func startTrial() {
        trial?.invalidate()
        guard web.root != WebBundles.embeddedRoot, web.build > WebBundles.confirmed else { return }
        trial = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
            guard let self else { return }
            CAPLog.print("Web bundle \(self.web.build) didn't start, so it's rolled back")
            self.rolledBack = self.web.build
            WebBundles.reject(self.web.build)
            self.load(WebBundles.newest())
        }
    }
}

/// Refused, with why as a code in brackets, which the page reports: see failure in src/core/updates.ts.
struct UpdateError: LocalizedError {
    let errorDescription: String?
    init(_ code: String, _ message: String) { errorDescription = "[\(code)] \(message)" }
}

/// Web bundles downloaded over the air, kept beside the bundle inside the app. One is installed only when the key inside
/// the app signed it, it was built for this app's native code, and every file matches. electron/updates.ts does the same
/// on the Mac. Used on the main thread only.
enum WebBundles {
    static let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("web", isDirectory: true)
    static let embeddedRoot = Bundle.main.url(forResource: "public", withExtension: nil)!
    static let embedded = info(embeddedRoot)
    private static let badKey = "multiscale.web.bad"
    private static let goodKey = "multiscale.web.good"

    struct Info {
        let build: Int
        let shell: String?
        let releaseKey: String?
    }

    /// version.json, which every build carries.
    static func info(_ root: URL) -> Info? {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("version.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let build = json["build"] as? Int else { return nil }
        return Info(build: build, shell: (json["shell"] as? [String: Any])?["ios"] as? String, releaseKey: json["releaseKey"] as? String)
    }

    private static var bad: [Int] { UserDefaults.standard.array(forKey: badKey) as? [Int] ?? [] }
    /// The newest bundle that has started and drawn the app. A newer one runs on trial until it does.
    static var confirmed: Int { UserDefaults.standard.integer(forKey: goodKey) }
    static func confirm(_ build: Int) { UserDefaults.standard.set(build, forKey: goodKey) }
    /// A bundle that failed its trial never runs again.
    static func reject(_ build: Int) {
        UserDefaults.standard.set(bad + [build], forKey: badKey)
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(String(build)))
    }

    /// Why this app can't run a bundle, or nil when it can.
    private static func cannotRun(build: Int, shell: String?) -> String? {
        if bad.contains(build) { return "rolled-back" }
        guard let embedded, let shell, shell == embedded.shell, build > embedded.build else { return "not-for-this-app" }
        return nil
    }

    /// The newest installed bundle this app can run, else the one inside the app.
    static func newest() -> (root: URL, build: Int) {
        var best = (root: embeddedRoot, build: embedded?.build ?? 0)
        for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] {
            let root = dir.appendingPathComponent(name, isDirectory: true)
            guard let build = Int(name), let found = info(root), found.build == build, cannotRun(build: build, shell: found.shell) == nil, build > best.build else { continue }
            best = (root, build)
        }
        return best
    }

    /// Each segment starts with a letter, digit or _, so no path climbs out or hides.
    private static func safe(_ path: String) -> Bool {
        path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { $0.range(of: "^[A-Za-z0-9_][A-Za-z0-9._-]*$", options: .regularExpression) != nil }
    }

    /// Throws, leaving what's installed as it was, unless every check passes. running is kept; older downloads go.
    static func install(manifest: String, signature: String, files: [String: Data], running: URL) throws {
        guard let keyText = embedded?.releaseKey, let keyData = Data(base64Encoded: keyText),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData) else {
            throw UpdateError("key", "This app was built without a release key, so it takes no updates")
        }
        guard let sig = Data(base64Encoded: signature), key.isValidSignature(sig, for: Data(manifest.utf8)) else {
            throw UpdateError("signature", "The release signature does not match")
        }
        guard let json = try? JSONSerialization.jsonObject(with: Data(manifest.utf8)) as? [String: Any],
              let build = json["build"] as? Int, let list = json["files"] as? [[String: Any]] else {
            throw UpdateError("release", "Bad release")
        }
        switch cannotRun(build: build, shell: (json["shell"] as? [String: Any])?["ios"] as? String) {
        case "rolled-back"?: throw UpdateError("rolled-back", "Build \(build) was rolled back on this device")
        case let reason?: throw UpdateError(reason, "Build \(build) is not newer, or not for this app's native code")
        case nil: break
        }
        let manager = FileManager.default
        let target = dir.appendingPathComponent(String(build), isDirectory: true)
        let partial = dir.appendingPathComponent("\(build).partial", isDirectory: true)
        try? manager.removeItem(at: partial)
        do {
            for file in list {
                guard let path = file["path"] as? String, safe(path), let data = files[path],
                      SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == file["sha256"] as? String else {
                    throw UpdateError("file", "\(file["path"] ?? "A file") does not match the release")
                }
                let url = partial.appendingPathComponent(path)
                try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: url)
            }
            guard info(partial)?.build == build, manager.fileExists(atPath: partial.appendingPathComponent("index.html").path) else {
                throw UpdateError("incomplete", "The release has no index.html, or a version.json for another build")
            }
        } catch {
            try? manager.removeItem(at: partial)
            throw error
        }
        try? manager.removeItem(at: target)
        try manager.moveItem(at: partial, to: target)
        for name in (try? manager.contentsOfDirectory(atPath: dir.path)) ?? [] {
            let url = dir.appendingPathComponent(name, isDirectory: true)
            if url.standardizedFileURL.path != target.standardizedFileURL.path && url.standardizedFileURL.path != running.standardizedFileURL.path {
                try? manager.removeItem(at: url)
            }
        }
    }
}

/// The page's side of over-the-air updates: it downloads a release, and this checks, installs and switches to it.
@objc(MultiscaleUpdatesPlugin)
class UpdatesPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MultiscaleUpdatesPlugin"
    let jsName = "MultiscaleUpdates"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "install", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "staged", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "apply", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ready", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rolledBack", returnType: CAPPluginReturnPromise),
    ]

    private var controller: BridgeViewController? { bridge?.viewController as? BridgeViewController }

    /// files maps each path to its contents in base64.
    @objc func install(_ call: CAPPluginCall) {
        guard let manifest = call.getString("manifest"), let signature = call.getString("signature"), let encoded = call.getObject("files") else {
            return call.reject("[release] Bad release")
        }
        var files: [String: Data] = [:]
        for (path, value) in encoded {
            if let text = value as? String, let data = Data(base64Encoded: text) { files[path] = data }
        }
        DispatchQueue.main.async {
            guard let running = self.controller?.web.root else { return call.reject("No app to update") }
            do {
                try WebBundles.install(manifest: manifest, signature: signature, files: files, running: running)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func staged(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let next = WebBundles.newest()
            call.resolve(["build": next.build > (self.controller?.web.build ?? .max) ? next.build : NSNull()])
        }
    }

    @objc func apply(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.controller?.applyNewest()
            call.resolve()
        }
    }

    @objc func ready(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.controller?.confirm()
            call.resolve()
        }
    }

    /// The build this run rolled back, if any, once.
    @objc func rolledBack(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let build = self.controller?.rolledBack
            self.controller?.rolledBack = nil
            call.resolve(["build": build ?? NSNull()])
        }
    }
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
