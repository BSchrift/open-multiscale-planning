import Foundation

/// The widgets' files in the App Group, which only this app's own targets can read: the snapshot the app writes, the
/// queue the buttons add to, and the share extension's queue, which Capture counts.
public struct WidgetFiles: Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    /// The App Group named by the target's Info.plist (MultiscaleAppGroup), or nil in a build without one, as a free
    /// personal team's is.
    public static func appGroup(_ bundle: Bundle = .main) -> WidgetFiles? {
        guard let group = bundle.object(forInfoDictionaryKey: "MultiscaleAppGroup") as? String, !group.isEmpty,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return WidgetFiles(root: root)
    }

    public var snapshotURL: URL { root.appendingPathComponent("widgets", isDirectory: true).appendingPathComponent("snapshot.json") }
    public var actions: ActionQueue { ActionQueue(folder: root.appendingPathComponent("widget-actions", isDirectory: true)) }
    var shareQueue: URL { root.appendingPathComponent("share-queue", isDirectory: true) }

    public enum WriteError: Error { case tooBig, notASnapshot }

    /// Saves the app's snapshot, refusing one a widget couldn't read. Only after the first unlock, as the sign-in tokens
    /// are, so Lock Screen widgets and background refresh can read it; never in a backup, since the app can rebuild it.
    public func writeSnapshot(_ data: Data) throws {
        guard data.count <= Snapshot.maxBytes else { throw WriteError.tooBig }
        guard case .ok = LoadedSnapshot.decode(data) else { throw WriteError.notASnapshot }
        try FileManager.default.createDirectory(at: snapshotURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try WidgetFiles.write(data, to: snapshotURL)
        var folder = snapshotURL.deletingLastPathComponent()
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)
    }

    public func readSnapshot() -> LoadedSnapshot {
        LoadedSnapshot.decode(try? Data(contentsOf: snapshotURL))
    }

    /// At sign-out or an erase: the snapshot and anything queued.
    public func clear() {
        try? FileManager.default.removeItem(at: snapshotURL)
        actions.removeAll()
    }

    /// Shares still waiting for the app to import them, which the Inbox count adds, so a share shows at once.
    public func waitingShares() -> Int {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: shareQueue.path)) ?? []
        return names.filter { $0.hasSuffix(".txt") && $0 != ".txt" }.count
    }

    /// What a widget draws from now: the snapshot with the taps not yet applied laid over it, and waiting shares.
    public func load() -> (snapshot: LoadedSnapshot, shares: Int) {
        let loaded = readSnapshot()
        guard let snapshot = loaded.snapshot else { return (loaded, waitingShares()) }
        return (.ok(snapshot.applying(actions.pending())), waitingShares())
    }

    static func write(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: [.atomic])
        #endif
    }
}
