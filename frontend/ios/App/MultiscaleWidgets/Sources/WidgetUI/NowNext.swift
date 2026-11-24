import SwiftUI
import WidgetKit
import WidgetCore

@available(iOS 17.0, macOS 14.0, *)
/// Now and next: the block in progress with a live countdown and a bar of time spent, or what's next and when. Small on
/// the Home Screen and in StandBy, which shows the small one larger; medium adds the next block and one button.
public struct NowNextView: View {
    public enum Size: String, CaseIterable, Sendable { case small, medium }

    let state: WidgetState
    let size: Size
    @Environment(\.palette) private var palette
    @Environment(\.redactionReasons) private var redaction

    public init(state: WidgetState, size: Size) {
        self.state = state
        self.size = size
    }

    /// A locked phone with Lock Screen widget access off hides names, and VoiceOver then reads the placeholders.
    private var redacted: Bool { redaction.contains(.privacy) }

    private func name(_ block: Snapshot.Block, current: Bool) -> BlockName {
        let name = BlockName(block)
        return redacted ? name.redacted(current: current) : name
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ViewThatFits(in: .vertical) {
                main(detail: .full)
                main(detail: .noBar)
                main(detail: .least)
                // Only when even the least won't fit, at the very largest sizes, does the text stop growing.
                main(detail: .least).dynamicTypeSize(...DynamicTypeSize.accessibility2)
                main(detail: .least).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(state.nowNextLabel(medium: size == .medium, redacted: redacted))
            if size == .medium, let side = sideKind {
                ViewThatFits(in: .vertical) {
                    self.side(side, withNext: true)
                    self.side(side, withNext: false)
                    self.side(side, withNext: false).dynamicTypeSize(...DynamicTypeSize.accessibility2)
                    self.side(side, withNext: false).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                }
                .frame(width: side == .wide ? 150 : 128)
                .frame(maxHeight: .infinity, alignment: .top)
                .padding(.leading, 14)
                .overlay(alignment: .leading) { palette.hairline.frame(width: 1) }
            }
        }
        .foregroundStyle(palette.ink)
    }

    // MARK: The main column

    /// At larger text, less rather than smaller: first the bar goes, then the eyebrow, and the title keeps one line.
    enum Detail { case full, noBar, least }

    @ViewBuilder
    private func main(detail: Detail) -> some View {
        let eyebrow = detail != .least
        VStack(alignment: .leading, spacing: 6) {
            switch state.mode {
            case .now:
                let c = state.current!
                if eyebrow { Eyebrow(text: "Now, until \(time(c.end))") { LiveDot() } }
                title(c, lines: detail == .least ? 1 : 2)
                Spacer(minLength: 0)
                Countdown(state: state)
                if let since = state.staleSince { SyncedLine(since: since, state: state) } else if detail == .full { SpentBar(state: state) }
            case .start:
                let c = state.current!
                if eyebrow { Eyebrow(text: size == .small ? "\(time(c.start)) to \(time(c.end))" : "Now, \(time(c.start)) to \(time(c.end))") { Icon(name: .clock, size: 12) } }
                title(c, lines: detail == .least ? 1 : 2)
                Spacer(minLength: 0)
                Text("Not started").font(Type.meta).foregroundStyle(palette.ink2).lineLimit(1)
                if let since = state.staleSince, detail == .full { SyncedLine(since: since, state: state) }
            case .paused:
                let c = state.current!
                if eyebrow { Eyebrow(text: "Paused for \(Format.pause(state.pausedMinutes, short: size == .small))") { Icon(name: .pause, size: 12) } }
                title(c, lines: size == .small || detail == .least ? 1 : 2)
                Spacer(minLength: 0)
                Countdown(state: state)
                if detail != .least, let ends = state.endsIfResumed {
                    Text("Ends at \(time(ends)) unless you resume").font(Type.caption).foregroundStyle(palette.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            case .free:
                let n = state.nextToday!
                if eyebrow { Eyebrow(text: size == .small ? "Free until \(time(n.start))" : "Free until \(time(n.start)). Next:") { Icon(name: .clock, size: 12) } }
                title(n, current: false, lines: detail == .least ? 1 : 2)
                Spacer(minLength: 0)
                Text(state.minutesToNext.map { "Starts in \($0) min" } ?? "Starts at \(time(n.start))")
                    .font(Type.meta).foregroundStyle(palette.ink2).lineLimit(1)
            case .empty:
                Message(icon: .today, head: "Nothing planned today", sub: state.weekPlanned || detail == .least ? nil : "This week isn't planned yet")
            case .finished:
                // At larger text the eyebrow goes first, then the tallies.
                if detail == .full { Eyebrow(text: "Today") { Icon(name: .today, size: 12) } }
                Text("Nothing else planned today").font(Type.heading).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if detail != .least { counts }
            case .signedOut:
                Message(icon: .today, head: "Sign in to see your day", sub: size == .medium && detail == .full ? "Your blocks show here after you sign in." : nil)
            case .noData:
                Message(icon: .today, head: "Open Multiscale once to show your day here")
            case .tooNew:
                Message(icon: .today, head: "Open Multiscale to update this widget")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func title(_ block: Snapshot.Block, current: Bool = true, lines: Int) -> some View {
        Words(text: name(block, current: current).shown)
            .font(Type.heading)
            .foregroundStyle(block.title == nil ? palette.ink2 : palette.ink)
            .lineLimit(lines)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var counts: some View {
        let c = state.counts
        let items: [(AnswerBadge.Answer, String)] = [(.done, "\(c.done) done"), (.partly, "\(c.partly) partly"), (.notDone, "\(c.notDone) not done"), (.toAnswer, "\(c.toAnswer) to answer")]
        return Flow {
            ForEach(items.indices, id: \.self) { item(items[$0]) }
        }
        .font(Type.caption)
        .foregroundStyle(palette.ink2)
    }

    private func item(_ i: (AnswerBadge.Answer, String)) -> some View {
        HStack(spacing: 4) {
            AnswerBadge(answer: i.0)
            Text(i.1).lineLimit(1)
        }
    }

    // MARK: The medium widget's side column

    enum Side { case button, tomorrow, wide, signIn }

    private var sideKind: Side? {
        switch state.mode {
        case .now, .start, .paused, .free: .button
        case .finished: state.tomorrow == nil ? nil : .tomorrow
        case .empty: state.weekPlanned ? (state.tomorrow == nil ? nil : .tomorrow) : .wide
        case .signedOut: .signIn
        case .noData, .tooNew: nil
        }
    }

    @ViewBuilder
    private func side(_ side: Side, withNext: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            switch side {
            case .button:
                if let r = state.justStarted {
                    Eyebrow(text: "Started at \(time(r.at))") { EmptyView() }
                    if withNext {
                        Text("You can undo this for 5 minutes.").font(Type.caption).foregroundStyle(palette.ink2).fixedSize(horizontal: false, vertical: true)
                    }
                } else if withNext, let up = upcoming {
                    Eyebrow(text: up.0) { EmptyView() }
                    MiniBlock(block: up.1, name: name(up.1, current: false))
                }
                Spacer(minLength: 0)
                if let button = state.button { ActionButton(button: button, name: buttonName(button)) }
            case .tomorrow:
                if let t = state.tomorrow {
                    Eyebrow(text: "Tomorrow, \(time(t.start))") { EmptyView() }
                    if withNext { MiniBlock(block: t, name: name(t, current: false)) }
                }
                Spacer(minLength: 0)
                LinkButton(title: "Open Today", url: WidgetLink.today, filled: false)
            case .wide:
                if withNext { Text("Plan the week, and today fills in.").font(Type.caption).foregroundStyle(palette.ink2).fixedSize(horizontal: false, vertical: true) }
                Spacer(minLength: 0)
                LinkButton(title: "Plan your week", url: WidgetLink.plan, filled: true)
            case .signIn:
                Spacer(minLength: 0)
                LinkButton(title: "Sign in", url: WidgetLink.today, filled: true)
            }
        }
    }

    /// What the side column shows above its button: the next block, or for free time, the one after it.
    private var upcoming: (String, Snapshot.Block)? {
        if state.mode == .free { return state.after.map { ("After that, \(time($0.start))", $0) } }
        if let n = state.nextToday { return ("Next, \(time(n.start))", n) }
        return state.tomorrow.map { ("Tomorrow, \(time($0.start))", $0) }
    }

    private func buttonName(_ button: WidgetButton) -> String {
        let block = state.mode == .free ? state.nextToday : state.current
        return block.map { name($0, current: state.mode != .free).said } ?? "the block"
    }

    private func time(_ date: Date) -> String { Format.time(date, in: state.zone) }
}

@available(iOS 17.0, macOS 14.0, *)
extension NowNextView {
    /// Where a tap anywhere but the button goes: Today, with the Now card in view.
    public static var link: URL { WidgetLink.today }
}
