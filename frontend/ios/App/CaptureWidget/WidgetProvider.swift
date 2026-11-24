import AppIntents
import WidgetCore
import WidgetKit

/// One entry of a widget's timeline: what it shows at that moment, worked out from the snapshot (WidgetState).
struct DayEntry: TimelineEntry {
    let date: Date
    let state: WidgetState
    let relevance: TimelineEntryRelevance?
}

/// The timeline every widget shares: entries only where what's drawn changes, at block starts and ends, midnight and
/// the like (WidgetTimeline), read from the App Group's snapshot with any taps not yet applied laid over it. iOS asks
/// for the next once this one ends; the app reloads it whenever it writes a snapshot.
struct DayProvider: TimelineProvider {
    func placeholder(in context: Context) -> DayEntry {
        DayEntry.sample(at: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (DayEntry) -> Void) {
        completion(context.isPreview ? DayEntry.sample(at: Date()) : DayProvider.entries(from: Date()).first!)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DayEntry>) -> Void) {
        completion(Timeline(entries: DayProvider.entries(from: Date()), policy: .atEnd))
    }

    static func entries(from now: Date) -> [DayEntry] {
        let (loaded, shares) = WidgetFiles.appGroup()?.load() ?? (.missing, 0)
        return WidgetTimeline.entryDates(loaded, from: now).map { date in
            let state = WidgetState(loaded, shares: shares, at: date)
            let relevance = WidgetTimeline.relevance(state)
            return DayEntry(date: date, state: state, relevance: TimelineEntryRelevance(score: relevance.score, duration: relevance.duration))
        }
    }
}

extension DayEntry {
    /// The gallery's and the placeholder's: the spec's example day, never anyone's own.
    static func sample(at now: Date) -> DayEntry {
        DayEntry(date: now, state: WidgetState(.ok(.sample(at: now)), at: now), relevance: nil)
    }
}

/// The medium Now and next widget's one button: Start, Start early, Pause, Resume, or Undo for five minutes after a
/// start. It runs in the widget's process and adds the tap to the App Group's queue, which the app applies with the same
/// writes as the Now card's buttons when it next opens (WidgetTap). iOS redraws the widget straight after, from the
/// queue, and keeps it inactive on a locked phone until Face ID unlocks it.
struct WidgetButtonIntent: AppIntent {
    static let title: LocalizedStringResource = "Change the block in progress"
    static let isDiscoverable = false

    @Parameter(title: "Action") var action: String
    @Parameter(title: "Block") var blockId: String
    @Parameter(title: "Start to undo") var actionId: String

    init() {}

    init(_ button: WidgetButton) {
        switch button {
        case let .start(id): (action, blockId, actionId) = ("start", id, "")
        case let .startEarly(id): (action, blockId, actionId) = ("startEarly", id, "")
        case let .pause(id): (action, blockId, actionId) = ("pause", id, "")
        case let .resume(id): (action, blockId, actionId) = ("resume", id, "")
        case let .undo(target, id, early): (action, blockId, actionId) = (early ? "undoEarly" : "undo", id, target)
        }
    }

    var button: WidgetButton? {
        switch action {
        case "start": .start(blockId: blockId)
        case "startEarly": .startEarly(blockId: blockId)
        case "pause": .pause(blockId: blockId)
        case "resume": .resume(blockId: blockId)
        case "undo", "undoEarly": .undo(actionId: actionId, blockId: blockId, early: action == "undoEarly")
        default: nil
        }
    }

    func perform() async throws -> some IntentResult {
        if let button, let files = WidgetFiles.appGroup() { try WidgetTap.perform(button, files: files) }
        return .result()
    }
}
