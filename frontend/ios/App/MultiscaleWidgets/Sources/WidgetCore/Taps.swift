import Foundation

/// The app's own links, which the widgets open (frontend/src/core/appLinks.ts). Ids only, never titles.
public enum WidgetLink {
    public static let today = URL(string: "multiscale://today")!
    public static let inbox = URL(string: "multiscale://inbox")!
    public static let week = URL(string: "multiscale://week")!
    public static let plan = URL(string: "multiscale://plan")!
    /// The link the Capture control already opens.
    public static let capture = URL(string: "multiscale://capture")!

    public static func today(block: String) -> URL {
        var parts = URLComponents(string: "multiscale://today")!
        parts.queryItems = [URLQueryItem(name: "block", value: block)]
        return parts.url!
    }
}

/// What a widget button's App Intent does when tapped, kept here so it's tested without WidgetKit: check the button
/// still fits the plan as the widget now sees it, then add the action to the queue. The widget redraws from the queue at
/// once (Snapshot.applying), and the app applies it when it next opens. Undo of a start the app hasn't applied yet just
/// takes it off the queue.
public enum WidgetTap {
    /// Whether the tap changed anything. A button drawn for a moment that has passed changes nothing, and iOS redraws
    /// the widget as it now is.
    @discardableResult
    public static func perform(_ button: WidgetButton, files: WidgetFiles, at now: Date = Date()) throws -> Bool {
        let (loaded, shares) = files.load()
        let state = WidgetState(loaded, shares: shares, at: now)
        guard state.accepts(button), let snapshot = files.readSnapshot().snapshot else { return false }
        let queue = files.actions
        func rev(_ id: String) -> String { snapshot.block(id)?.rev ?? "" }
        switch button {
        case let .start(id): try queue.enqueue(.start, blockId: id, rev: rev(id), at: now)
        case let .startEarly(id): try queue.enqueue(.startEarly, blockId: id, rev: rev(id), at: now)
        case let .pause(id): try queue.enqueue(.pause, blockId: id, rev: rev(id), at: now)
        case let .resume(id): try queue.enqueue(.resume, blockId: id, rev: rev(id), at: now)
        case let .undo(actionId, id, _):
            if queue.remove(actionId) { return true }
            try queue.enqueue(.undo, blockId: id, rev: rev(id), at: now, target: actionId)
        }
        return true
    }
}
