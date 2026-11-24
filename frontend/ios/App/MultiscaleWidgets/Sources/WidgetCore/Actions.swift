import Foundation

/// What a widget button asks for. Its App Intent can't write to the app's database, so it adds one of these to the App
/// Group's widget-actions folder, and the app applies it when it next opens (frontend/src/core/widgetActions.ts).
public struct WidgetAction: Codable, Equatable, Sendable {
    public static let version = 1
    public enum Kind: String, Codable, Sendable { case start, startEarly, pause, resume, undo }

    public var v: Int
    /// The file's name: the tap's epoch milliseconds, then a UUID, so the queue sorts in the order of the taps.
    public var id: String
    public var kind: Kind
    public var blockId: String
    /// The block's rev in the snapshot the widget drew from, so the app can tell when it has changed since.
    public var rev: String
    /// The tap, to the second, which the app times the change at however much later it applies it.
    public var at: Date
    /// For undo, the start it takes back.
    public var target: String?

    public init(v: Int, id: String, kind: Kind, blockId: String, rev: String, at: Date, target: String?) {
        (self.v, self.id, self.kind, self.blockId, self.rev, self.at, self.target) = (v, id, kind, blockId, rev, at, target)
    }

    enum CodingKeys: String, CodingKey { case v, id, kind, blockId, rev, at, target }

    // Written out in full, target's null included, exactly as the app's fixtures have it.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encode(blockId, forKey: .blockId)
        try c.encode(rev, forKey: .rev)
        try c.encode(at, forKey: .at)
        try c.encode(target, forKey: .target)
    }

    /// A file name the queue made, and never a path elsewhere.
    public static func isFileName(_ name: String) -> Bool {
        name.range(of: #"^\d{13}-[0-9A-Fa-f-]{36}\.json$"#, options: .regularExpression) != nil
    }
}

/// The folder of queued actions in the App Group, as ShareQueue is for shares.
public struct ActionQueue: Sendable {
    public let folder: URL

    public init(folder: URL) {
        self.folder = folder
    }

    /// Adds an action, written atomically so the app never reads half a file. The tap is kept to the whole second, the
    /// one instant format the app stores.
    @discardableResult
    public func enqueue(_ kind: WidgetAction.Kind, blockId: String, rev: String, at tap: Date, target: String? = nil) throws -> WidgetAction {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let id = "\(Int64((tap.timeIntervalSince1970 * 1000).rounded(.down)))-\(UUID().uuidString).json"
        let at = Date(timeIntervalSince1970: tap.timeIntervalSince1970.rounded(.down))
        let action = WidgetAction(v: WidgetAction.version, id: id, kind: kind, blockId: blockId, rev: rev, at: at, target: target)
        try WidgetFiles.write(try WidgetJSON.encoder.encode(action), to: folder.appendingPathComponent(id))
        return action
    }

    /// The queue's files, oldest first, as the app reads them.
    public func items() -> [(id: String, text: String)] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return [] }
        return names.filter(WidgetAction.isFileName).sorted().compactMap { name in
            guard let text = try? String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8) else { return nil }
            return (id: name, text: text)
        }
    }

    /// The actions not yet applied, oldest first. One that can't be read is left for the app, which drops it.
    public func pending() -> [WidgetAction] {
        items().compactMap { item in
            guard let action = try? WidgetJSON.decoder.decode(WidgetAction.self, from: Data(item.text.utf8)), action.id == item.id else { return nil }
            return action
        }
    }

    /// Takes actions off the queue by name. Returns whether one was there to take.
    @discardableResult
    public func remove(_ id: String) -> Bool {
        guard WidgetAction.isFileName(id) else { return false }
        return (try? FileManager.default.removeItem(at: folder.appendingPathComponent(id))) != nil
    }

    public func removeAll() {
        for item in items() { remove(item.id) }
    }
}

extension Snapshot {
    /// The snapshot as it will be once the app applies these queued taps, so the widget shows a tap's result at once. The
    /// same changes the app makes (core/blocks.ts), without its checks against other devices: the app has the last word,
    /// and rewrites the snapshot when it does.
    public func applying(_ actions: [WidgetAction]) -> Snapshot {
        var s = self
        for action in actions.sorted(by: { $0.id < $1.id }) {
            guard let i = s.blocks.firstIndex(where: { $0.id == action.blockId }) else { continue }
            var b = s.blocks[i]
            let at = action.at
            switch action.kind {
            case .start:
                guard b.unanswered, b.startedAt == nil, at < b.end else { continue }
                b.startedAt = at
                s.fromWidget.append(Recent(id: action.id, kind: .start, blockId: b.id, at: at, before: nil))
            case .startEarly:
                guard b.unanswered, b.startedAt == nil else { continue }
                let before = Recent.Times(start: b.start, end: b.end)
                let start = Date(timeIntervalSince1970: (at.timeIntervalSince1970 / 60).rounded(.down) * 60)
                b.end = start.addingTimeInterval(b.end.timeIntervalSince(b.start))
                b.start = start
                b.startedAt = at
                s.fromWidget.append(Recent(id: action.id, kind: .startEarly, blockId: b.id, at: at, before: before))
            case .pause:
                guard b.unanswered, b.startedAt != nil, b.pausedAt == nil, at < b.end else { continue }
                b.pausedAt = at
            case .resume:
                guard b.unanswered, let paused = b.pausedAt else { continue }
                // As resumeBlock: whole minutes, rounded, and none for a pause under 30 seconds.
                let minutes = Int((at.timeIntervalSince(paused) / 60).rounded(.toNearestOrAwayFromZero))
                if minutes > 0 {
                    b.end = b.end.addingTimeInterval(TimeInterval(minutes * 60))
                    b.pausedMin = (b.pausedMin ?? 0) + minutes
                }
                b.pausedAt = nil
            case .undo:
                guard let r = s.fromWidget.firstIndex(where: { $0.id == action.target && $0.blockId == b.id }) else { continue }
                b.startedAt = nil
                if let before = s.fromWidget[r].before {
                    b.start = before.start
                    b.end = before.end
                }
                s.fromWidget.remove(at: r)
            }
            s.blocks[i] = b
        }
        s.blocks.sort { $0.start < $1.start }
        return s
    }
}
