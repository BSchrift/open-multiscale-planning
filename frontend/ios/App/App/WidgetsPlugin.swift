import BackgroundTasks
import Capacitor
import WidgetCore
import WidgetKit

/// The page's way to the widgets (frontend/src/platform/capacitor.ts): it writes the snapshot they draw from, reads what
/// their buttons queued, and hears when iOS wakes the app to refresh them. All through the App Group, so a build without
/// one, as a free personal team's is, reports itself off and the page carries on without widgets.
@objc(MultiscaleWidgetsPlugin)
class WidgetsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MultiscaleWidgetsPlugin"
    let jsName = "MultiscaleWidgets"
    #if DEBUG
    let pluginMethods: [CAPPluginMethod] = WidgetsPlugin.methods + [
        CAPPluginMethod(name: "snapshotForTest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tapForTest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refreshForTest", returnType: CAPPluginReturnPromise),
    ]
    #else
    let pluginMethods = WidgetsPlugin.methods
    #endif
    private static let methods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "actions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refreshed", returnType: CAPPluginReturnPromise),
    ]

    /// The page that's running, for a background refresh to ask.
    static weak var current: WidgetsPlugin?

    private var files: WidgetFiles? { WidgetFiles.appGroup() }

    override func load() {
        WidgetsPlugin.current = self
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(["enabled": files != nil])
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let files else { return call.reject("This build has no App Group for widgets") }
        guard let json = call.getString("json") else { return call.reject("No snapshot") }
        do {
            try files.writeSnapshot(Data(json.utf8))
        } catch {
            return call.reject("The widgets couldn't read that snapshot", nil, error)
        }
        // Reloads asked for while the app is in front don't count against the widgets' daily budget.
        WidgetCenter.shared.reloadAllTimelines()
        #if DEBUG
        // XCUITest waits for these to know the app wrote the snapshot after a change, and with how many blocks started,
        // so it can wait for the one write a change leads to rather than any write.
        let started = LoadedSnapshot.decode(Data(json.utf8)).snapshot?.blocks.filter { $0.startedAt != nil }.count ?? 0
        for suffix in ["", ".started-\(started)"] {
            let name = CFNotificationName("io.github.bschrift.multiscale.widget-snapshot\(suffix)" as CFString)
            CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), name, nil, nil, true)
        }
        #endif
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        files?.clear()
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func actions(_ call: CAPPluginCall) {
        call.resolve(["items": (files?.actions.items() ?? []).map { ["id": $0.id, "text": $0.text] }])
    }

    @objc func remove(_ call: CAPPluginCall) {
        for id in call.getArray("ids", String.self) ?? [] { files?.actions.remove(id) }
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func refreshed(_ call: CAPPluginCall) {
        WidgetRefresh.finish(success: call.getBool("ok") ?? false)
        call.resolve()
    }

    /// Asks the page to sync and write the snapshot. Kept until the page listens, as after a launch into the background.
    func requestRefresh() {
        notifyListeners("refresh", data: [:], retainUntilConsumed: true)
    }

    #if DEBUG
    /// What the snapshot holds, for the test page to report.
    @objc func snapshotForTest(_ call: CAPPluginCall) {
        guard let snapshot = files?.readSnapshot().snapshot else { return call.resolve(["snapshot": NSNull()]) }
        call.resolve(["snapshot": String(decoding: (try? WidgetJSON.encoder.encode(snapshot)) ?? Data(), as: UTF8.self)])
    }

    /// The medium widget's button as an App Intent runs it, on the page's clock, which XCUITest can move: XCUITest can't
    /// put a widget on the Home Screen to tap it.
    @objc func tapForTest(_ call: CAPPluginCall) {
        guard let files else { return call.reject("No App Group") }
        let at = Date(timeIntervalSince1970: (call.getDouble("at") ?? Date().timeIntervalSince1970 * 1000) / 1000)
        let state = WidgetState(files.load().snapshot, at: at)
        guard let button = state.button else { return call.resolve(["tapped": NSNull(), "mode": state.mode.rawValue]) }
        do {
            let changed = try WidgetTap.perform(button, files: files, at: at)
            call.resolve(["tapped": changed ? button.title : NSNull(), "mode": state.mode.rawValue])
        } catch {
            call.reject("The tap failed", nil, error)
        }
    }

    /// A background refresh as iOS runs it, with a stand-in for its task that reports when it's done.
    @objc func refreshForTest(_ call: CAPPluginCall) {
        WidgetRefresh.handle(TestTask { call.resolve(["completed": $0]) })
    }
    #endif
}

#if DEBUG
private final class TestTask: RefreshTask {
    var expirationHandler: (() -> Void)?
    private let done: (Bool) -> Void
    init(_ done: @escaping (Bool) -> Void) { self.done = done }
    func setTaskCompleted(success: Bool) { done(success) }
}
#endif

/// What a background refresh needs of iOS's task, so the debug build can run one with a stand-in.
protocol RefreshTask: AnyObject {
    var expirationHandler: (() -> Void)? { get set }
    func setTaskCompleted(success: Bool)
}

extension BGTask: RefreshTask {}

/// iOS's background refresh, whose timing iOS decides: the page syncs and rewrites the snapshot, so a plan changed on the
/// Mac reaches the widgets without opening the phone app. No silent push: the server sends none.
enum WidgetRefresh {
    static var identifier: String { (Bundle.main.bundleIdentifier ?? "multiscale") + ".widget-refresh" }
    private static var running: RefreshTask?

    /// At launch, before it ends, as iOS requires. Only in a build with the App Group, where there are widgets to refresh.
    static func register() {
        guard WidgetFiles.appGroup() != nil else { return }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { handle($0) }
        schedule()
    }

    /// Asks for the next refresh, no sooner than half an hour on. iOS may run it much later, or not at all.
    static func schedule() {
        guard WidgetFiles.appGroup() != nil else { return }
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    static func handle(_ task: RefreshTask) {
        DispatchQueue.main.async {
            schedule()
            running?.setTaskCompleted(success: false)
            // shortcut: launched into the background with no scene, there's no page to sync, so the widgets only redraw
            // from the snapshot they have; start the page headless if widgets lag behind the Mac.
            guard let plugin = WidgetsPlugin.current else {
                WidgetCenter.shared.reloadAllTimelines()
                task.setTaskCompleted(success: true)
                return
            }
            running = task
            task.expirationHandler = { finish(success: false) }
            plugin.requestRefresh()
        }
    }

    static func finish(success: Bool) {
        DispatchQueue.main.async {
            running?.setTaskCompleted(success: success)
            running = nil
        }
    }
}
