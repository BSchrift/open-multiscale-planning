import Foundation

/// A piece of text a widget shows, and whether iOS should hide it on a locked phone whose Lock Screen widget access is
/// off (privacySensitive). Task names are; an encrypted space's name, times, states and counts aren't.
public struct WidgetText: Equatable, Sendable {
    public var text: String
    public var sensitive: Bool

    public init(_ text: String, sensitive: Bool = false) {
        self.text = text
        self.sensitive = sensitive
    }
}

/// What a block is called on a widget: its task's name, or for a block in an encrypted space, only the space's.
public struct BlockName: Equatable, Sendable {
    public let shown: WidgetText
    /// For VoiceOver.
    public let said: String

    public init(_ block: Snapshot.Block) {
        if let title = block.title {
            shown = WidgetText(title, sensitive: true)
            said = title
        } else if let space = block.space {
            shown = WidgetText(space.name)
            said = "a block in \(space.name)"
        } else {
            shown = WidgetText("Block")
            said = "a block"
        }
    }

    /// As iOS shows it on a locked phone with Lock Screen widget access off: a placeholder in place of the name.
    public func redacted(current: Bool) -> BlockName {
        guard shown.sensitive else { return self }
        return BlockName(shown: WidgetText(current ? "Block in progress" : "Next block"), said: current ? "block in progress" : "next block")
    }

    private init(shown: WidgetText, said: String) {
        self.shown = shown
        self.said = said
    }
}

/// The one button the medium Now and next widget offers, which changes with the block. iOS 17 runs it in place; there's
/// never a Done, which stays in the app, as the reminders leave it out.
public enum WidgetButton: Equatable, Sendable {
    case start(blockId: String)
    case startEarly(blockId: String)
    case pause(blockId: String)
    case resume(blockId: String)
    /// For five minutes after a start from the widget.
    case undo(actionId: String, blockId: String, early: Bool)

    public var title: String {
        switch self {
        case .start: "Start"
        case .startEarly: "Start early"
        case .pause: "Pause"
        case .resume: "Resume"
        case .undo: "Undo"
        }
    }

    /// Named in full for VoiceOver: "Start Write widget spec", "Undo start, Write widget spec".
    public func label(_ name: String) -> String {
        switch self {
        case .start: "Start \(name)"
        case .startEarly: "Start early, \(name)"
        case .pause: "Pause \(name)"
        case .resume: "Resume \(name)"
        case let .undo(_, _, early): "Undo \(early ? "start early" : "start"), \(name)"
        }
    }
}

extension WidgetState {
    /// The medium widget's button, if it has one now.
    public var button: WidgetButton? {
        switch mode {
        case .now:
            guard let c = current else { return nil }
            if let r = justStarted { return .undo(actionId: r.id, blockId: c.id, early: r.kind == .startEarly) }
            return .pause(blockId: c.id)
        case .start: return current.map { .start(blockId: $0.id) }
        case .paused: return current.map { .resume(blockId: $0.id) }
        case .free: return nextToday.map { .startEarly(blockId: $0.id) }
        default: return nil
        }
    }

    /// What a button would do now, checked at the tap, since a widget can be drawn a while before it's tapped: nil when
    /// the button no longer fits the block, and the intent then changes nothing.
    public func accepts(_ button: WidgetButton) -> Bool {
        if case let .undo(actionId, blockId, _) = button {
            return justStarted?.id == actionId && current?.id == blockId
        }
        return self.button == button
    }

    func time(_ date: Date) -> String { Format.time(date, in: zone) }

    /// The words of the counts row on a finished day: "2 done, 1 partly, 1 not done, 1 to answer".
    public var countsSaid: String {
        "\(counts.done) done, \(counts.partly) partly, \(counts.notDone) not done, \(counts.toAnswer) to answer"
    }

    /// One VoiceOver element per widget, read in order of importance, with end times rather than minutes left, since a
    /// label can't tick. `redacted` is a locked phone hiding names, when the placeholders are read instead.
    public func nowNextLabel(medium: Bool, redacted: Bool = false) -> String {
        func name(_ b: Snapshot.Block, current: Bool) -> String {
            let n = BlockName(b)
            return (redacted ? n.redacted(current: current) : n).said
        }
        let nextSaid: String = {
            guard medium else { return "" }
            if let n = nextToday, mode != .free { return " Next at \(time(n.start)): \(name(n, current: false))." }
            if mode != .free, let t = tomorrow { return " Tomorrow at \(time(t.start)): \(name(t, current: false))." }
            return ""
        }()
        let synced = staleSince.map { " Synced at \(time($0))." } ?? ""
        switch mode {
        case .now:
            let c = current!
            return "Now and next. Now: \(name(c, current: true)), \(time(c.start)) to \(time(c.end)), ends at \(time(c.end)).\(nextSaid)\(synced)"
        case .start:
            let c = current!
            return "Now and next. \(name(c, current: true)), \(time(c.start)) to \(time(c.end)), not started.\(nextSaid)\(synced)"
        case .paused:
            let c = current!
            return "Now and next. Paused for \(Format.pause(pausedMinutes)): \(name(c, current: true)). Ends at \(time(endsIfResumed ?? c.end)) unless you resume.\(nextSaid)\(synced)"
        case .free:
            let n = nextToday!
            let afterSaid = medium ? after.map { " After that at \(time($0.start)): \(name($0, current: false))." } ?? "" : ""
            return "Now and next. Free until \(time(n.start)). Next: \(name(n, current: false)), starts at \(time(n.start)).\(afterSaid)\(synced)"
        case .empty:
            return "Now and next. Nothing planned today.\(weekPlanned ? "" : " This week isn't planned yet.")\(nextSaid)"
        case .finished:
            let t = tomorrow.map { " Tomorrow at \(time($0.start)): \(name($0, current: false))." } ?? ""
            return "Now and next. Nothing else planned today. \(countsSaid).\(t)"
        case .signedOut:
            return "Now and next. Sign in to see your day."
        case .noData:
            return "Now and next. Open Multiscale once to show your day here."
        case .tooNew:
            return "Now and next. Open Multiscale to update this widget."
        }
    }

    public var captureLabel: String {
        switch mode {
        case .signedOut: "Capture. Sign in to Multiscale first."
        default: inbox.map { $0 == 0 ? "Capture. Inbox is empty." : "Capture. \($0) in Inbox." } ?? "Capture. Inbox."
        }
    }

    /// Capture's second line.
    public var inboxLine: String {
        if mode == .signedOut { return "Sign in first" }
        guard let inbox else { return "Inbox" }
        return inbox == 0 ? "Inbox is empty" : "\(inbox) in Inbox"
    }
}
