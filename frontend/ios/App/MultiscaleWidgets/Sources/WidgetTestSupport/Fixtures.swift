import Foundation
import WidgetCore

/// The contract fixtures the app's tests write (frontend/src/core/widgetFixtures.test.ts). Rewrite them there with
/// UPDATE_WIDGET_FIXTURES=1, never by hand.
public enum Fixtures {
    public static func data(_ path: String) -> Data {
        let url = Bundle.module.resourceURL!.appendingPathComponent("Fixtures").appendingPathComponent(path)
        guard let data = try? Data(contentsOf: url) else { fatalError("No fixture \(path)") }
        return data
    }

    public static func decode<T: Decodable>(_ type: T.Type, _ path: String) -> T {
        do {
            return try WidgetJSON.decoder.decode(type, from: data(path))
        } catch {
            fatalError("\(path) didn't decode: \(error)")
        }
    }

    /// The states the spec draws, by fixture name.
    public static let scenarios = ["now", "start", "paused", "next", "empty", "finished", "signedout", "stale", "encrypted", "inbox"]

    public static func loaded(_ name: String) -> LoadedSnapshot { LoadedSnapshot.decode(data("snapshots/\(name).json")) }
    public static func snapshot(_ name: String) -> Snapshot { loaded(name).snapshot! }

    /// When each scenario is drawn, as the spec's notes have it.
    public static func moment(_ name: String) -> Date {
        let at: [String: String] = [
            "now": "2026-11-18T18:04:00Z", "start": "2026-11-18T17:06:00Z", "paused": "2026-11-18T18:04:00Z",
            "next": "2026-11-18T18:48:00Z", "empty": "2026-11-18T17:30:00Z", "finished": "2026-11-19T02:20:00Z",
            "signedout": "2026-11-18T18:04:00Z", "stale": "2026-11-18T18:04:00Z", "encrypted": "2026-11-18T18:04:00Z",
            "inbox": "2026-11-18T18:04:00Z",
        ]
        return instant(at[name]!)
    }

    public static func instant(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }

    public struct State: Decodable {
        public let at: Date
        public let mode: String
        public let current: String?
        public let next: String?
    }

    public struct Overlay: Decodable {
        public struct Fields: Decodable, Equatable {
            public let id: String
            public let start: Date
            public let end: Date
            public let startedAt: Date?
            public let pausedAt: Date?
            public let pausedMin: Int?

            public init(id: String, start: Date, end: Date, startedAt: Date?, pausedAt: Date?, pausedMin: Int?) {
                (self.id, self.start, self.end, self.startedAt, self.pausedAt, self.pausedMin) = (id, start, end, startedAt, pausedAt, pausedMin)
            }
        }
        public struct Recent: Decodable, Equatable {
            public let kind: String
            public let blockId: String
            public let at: Date
            public let before: Snapshot.Recent.Times?

            public init(kind: String, blockId: String, at: Date, before: Snapshot.Recent.Times?) {
                (self.kind, self.blockId, self.at, self.before) = (kind, blockId, at, before)
            }
        }
        public let name: String
        public let snapshot: String
        public let actions: [WidgetAction]
        public let blocks: [Fields]
        public let fromWidget: [Recent]
    }

    public struct Time: Decodable {
        public let instant: Date
        public let zone: String
        public let text: String
    }

    public static var states: [String: [State]] { decode([String: [State]].self, "states.json") }
    public static var overlays: [Overlay] { decode([Overlay].self, "overlays.json") }
    public static var times: [Time] { decode([Time].self, "times.json") }
}
