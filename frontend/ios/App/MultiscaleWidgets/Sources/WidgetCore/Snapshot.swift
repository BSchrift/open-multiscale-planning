import Foundation

/// The snapshot of today and tomorrow the app writes to the App Group (frontend/src/core/widgetSnapshot.ts), which is
/// all a widget draws from. Its JSON is a contract: the app's tests write fixtures of it that FixtureTests decodes.
public struct Snapshot: Codable, Equatable, Sendable {
    /// The newest version these widgets understand. A newer one is from a later app, and says "Open Multiscale".
    public static let version = 1
    /// The app keeps it well under this, and a widget refuses anything bigger rather than read it.
    public static let maxBytes = 64 * 1024

    public var v: Int
    public var writtenAt: Date
    public var syncedAt: Date?
    public var zone: String
    public var signedIn: Bool
    /// Today, then tomorrow.
    public var days: [Day]
    /// Today's and tomorrow's blocks, by start.
    public var blocks: [Block]
    public var events: [Event]
    public var inbox: Inbox?
    /// Starts made from the widget that it still offers to undo.
    public var fromWidget: [Recent]
    /// What This week draws. Added after the first widgets, so a snapshot from an older app has none.
    public var week: Week?

    public struct Day: Codable, Equatable, Sendable {
        public var date: String
        public var weekPlanned: Bool
    }

    public struct Space: Codable, Equatable, Sendable {
        public var name: String
        public var encrypted: Bool

        public init(name: String, encrypted: Bool) {
            (self.name, self.encrypted) = (name, encrypted)
        }
    }

    public enum Kind: String, Codable, Equatable, Sendable {
        case project, practice, oneoff, planning, inbox

        /// A kind from a later app draws as a project, the plainest block.
        public init(from decoder: Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .project
        }
    }

    public enum Answer: String, Codable, Equatable, Sendable {
        case done, partly, not
    }

    public struct Block: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var rev: String
        public var start: Date
        public var end: Date
        public var kind: Kind
        /// Nil for a block in an encrypted space, whose task's name never leaves the app.
        public var title: String?
        public var space: Space?
        public var startedAt: Date?
        public var pausedAt: Date?
        public var pausedMin: Int?
        public var endedAt: Date?
        public var answer: Answer?

        /// Neither answered nor ended early: still the app's to ask about.
        public var unanswered: Bool { answer == nil && endedAt == nil }
    }

    public struct Event: Codable, Equatable, Sendable {
        public var start: Date
        public var end: Date
        public var title: String?
    }

    public struct Inbox: Codable, Equatable, Sendable {
        public var count: Int
    }

    public struct Recent: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Sendable { case start, startEarly }
        public struct Times: Codable, Equatable, Sendable {
            public var start: Date
            public var end: Date
        }
        public var id: String
        public var kind: Kind
        public var blockId: String
        public var at: Date
        /// Where Start early moved the block from.
        public var before: Times?
    }

    /// The week today is in, as Week counts it (widgetSnapshot.ts loadWeek). Whether it's planned is in `days`.
    public struct Week: Codable, Equatable, Sendable {
        /// Its Monday, "2026-11-16".
        public var start: String
        /// Each day's planned minutes, Monday first.
        public var plannedMinutes: [Int]
        public var aims: [Aim]
        public var practices: [Practice]

        public init(start: String, plannedMinutes: [Int], aims: [Aim], practices: [Practice]) {
            (self.start, self.plannedMinutes, self.aims, self.practices) = (start, plannedMinutes, aims, practices)
        }
    }

    /// A weekly aim: a project's, or One offs'.
    public struct Aim: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Equatable, Sendable {
            case project, oneoff

            /// A kind from a later app draws as a project.
            public init(from decoder: Decoder) throws {
                self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .project
            }
        }

        /// A project's status pill, with the app's tone for it.
        public struct Status: Codable, Equatable, Sendable {
            public enum Tone: String, Codable, Equatable, Sendable {
                case red, amber, green, grey

                /// A tone from a later app draws grey, the quietest.
                public init(from decoder: Decoder) throws {
                    self = Tone(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .grey
                }
            }
            public var pill: String
            public var tone: Tone

            public init(pill: String, tone: Tone) {
                (self.pill, self.tone) = (pill, tone)
            }
        }

        /// Nil for a project in an encrypted space, whose name never leaves the app.
        public var name: String?
        public var space: Space?
        public var kind: Kind
        public var plannedMinutes: Int
        public var aimMinutes: Int
        /// One offs have none.
        public var status: Status?

        public init(name: String?, space: Space? = nil, kind: Kind, plannedMinutes: Int, aimMinutes: Int, status: Status?) {
            (self.name, self.space, self.kind, self.plannedMinutes, self.aimMinutes, self.status) = (name, space, kind, plannedMinutes, aimMinutes, status)
        }
    }

    /// A practice's sessions this week: answered Done or Partly, of those it wants.
    public struct Practice: Codable, Equatable, Sendable {
        public var name: String?
        public var space: Space?
        public var done: Int
        public var of: Int

        public init(name: String?, space: Space? = nil, done: Int, of: Int) {
            (self.name, self.space, self.done, self.of) = (name, space, done, of)
        }
    }

    public var timeZone: TimeZone { TimeZone(identifier: zone) ?? .current }
    public func block(_ id: String) -> Block? { blocks.first { $0.id == id } }
}

/// What a widget found in the App Group.
public enum LoadedSnapshot: Equatable, Sendable {
    /// None yet: the app hasn't written one since it was installed or since an erase.
    case missing
    /// From a later app than this widget.
    case tooNew
    case unreadable
    case ok(Snapshot)

    public var snapshot: Snapshot? {
        if case let .ok(snapshot) = self { return snapshot }
        return nil
    }

    public static func decode(_ data: Data?) -> LoadedSnapshot {
        guard let data else { return .missing }
        guard data.count <= Snapshot.maxBytes else { return .unreadable }
        struct Version: Decodable { let v: Int }
        guard let version = try? WidgetJSON.decoder.decode(Version.self, from: data) else { return .unreadable }
        if version.v > Snapshot.version { return .tooNew }
        guard version.v >= 1, let snapshot = try? WidgetJSON.decoder.decode(Snapshot.self, from: data) else { return .unreadable }
        return .ok(snapshot)
    }
}

/// The app's one instant format, UTC to the second (dates.ts toInstant), both ways.
public enum WidgetJSON {
    public static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
}
