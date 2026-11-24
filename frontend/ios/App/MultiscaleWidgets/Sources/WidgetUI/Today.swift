import SwiftUI
import WidgetKit
import WidgetCore

@available(iOS 17.0, macOS 14.0, *)
extension WidgetSize {
    public static let large = CGSize(width: 338, height: 354)
}

@available(iOS 17.0, macOS 14.0, *)
/// Today: the rest of the day on the Home Screen, as Today's timeline draws it. The block in progress framed, what's
/// after it, and the blocks behind folded into one line with their answers. Large makes each row a link to Today at
/// that block; medium is one link, since its rows are too small to tap one by one. No buttons: answering stays in the app.
public struct TodayView: View {
    public enum Size: String, CaseIterable, Sendable { case medium, large }

    let state: WidgetState
    let size: Size
    @Environment(\.palette) private var palette

    public init(state: WidgetState, size: Size) {
        self.state = state
        self.size = size
    }

    public var body: some View {
        Group {
            switch state.mode {
            case .signedOut:
                fitted {
                    Message(icon: .today, head: "Sign in to see your day", sub: "Your blocks show here after you sign in.")
                } least: {
                    Message(icon: .today, head: "Sign in to see your day")
                }
                .oneElement(state.todayLabel(limit: 0))
            case .noData:
                clamped(Message(icon: .today, head: "Open Multiscale once to show your day here"))
                    .oneElement(state.todayLabel(limit: 0))
            case .tooNew:
                clamped(Message(icon: .today, head: "Open Multiscale to update this widget"))
                    .oneElement(state.todayLabel(limit: 0))
            case .empty:
                empty
            case .finished where size == .medium:
                finishedMedium
            default:
                if size == .medium { medium } else { large }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(palette.ink)
    }

    /// Where a tap anywhere but a large widget's rows goes.
    public static var link: URL { WidgetLink.today }

    /// The first of `more` and `least` that fits; at the very largest sizes, when even the least won't, its text stops
    /// growing, as Now and next's does.
    private func fitted<More: View, Least: View>(@ViewBuilder _ more: () -> More, @ViewBuilder least: () -> Least) -> some View {
        let least = least()
        return ViewThatFits(in: .vertical) {
            more()
            least
            least.dynamicTypeSize(...DynamicTypeSize.accessibility2)
            least.dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        }
    }

    private func clamped<Least: View>(_ least: Least) -> some View {
        ViewThatFits(in: .vertical) {
            least
            least.dynamicTypeSize(...DynamicTypeSize.accessibility2)
            least.dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        }
    }

    // MARK: Medium

    /// At larger text, fewer rows rather than smaller ones, and at the largest the next row alone.
    private var medium: some View {
        fitted {
            mediumRows(3)
            mediumRows(2)
            mediumRows(1)
        } least: {
            rows(1, times: false).oneElement(state.todayLabel(limit: 1))
        }
    }

    private func mediumRows(_ n: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            head
            rows(n)
        }
        .oneElement(state.todayLabel(limit: n))
    }

    private var finishedMedium: some View {
        fitted {
            finishedLayout(side: true, head: true, counts: true)
            finishedLayout(side: true, head: false, counts: true)
            finishedLayout(side: true, head: false, counts: false)
        } least: {
            finishedLayout(side: false, head: false, counts: false)
        }
        .oneElement(state.todayLabel(limit: 0))
    }

    private func finishedLayout(side: Bool, head: Bool, counts: Bool) -> some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                if head { Eyebrow(text: "Today") { Icon(name: .today, size: 12) } }
                Text("Nothing else planned today").font(Type.heading).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if counts { CountsRow(counts: state.counts, all: true) }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            if side, let t = state.tomorrow {
                VStack(alignment: .leading, spacing: 6) {
                    Eyebrow(text: "Tomorrow, \(time(t.start))") { EmptyView() }
                    MiniBlock(block: t, name: BlockName(t))
                }
                .frame(width: 128, alignment: .topLeading)
                .padding(.leading, 14)
                .overlay(alignment: .leading) { palette.hairline.frame(width: 1) }
            }
        }
    }

    // MARK: Large

    private var large: some View {
        fitted {
            largeBody(6)
            largeBody(5)
            largeBody(4)
            largeBody(3)
            largeBody(2)
            largeBody(1)
        } least: {
            rows(1, linked: true, times: false)
        }
        .accessibilityElement(children: .contain)
    }

    private func largeBody(_ n: Int) -> some View {
        let day = state.day(limit: n)
        return VStack(alignment: .leading, spacing: 0) {
            head.padding(.bottom, 4).accessibilityElement(children: .ignore).accessibilityLabel(state.todayHeadSaid)
            if let earlier = day.earlier {
                AppLinkView(url: WidgetLink.today) {
                    HStack(spacing: 8) {
                        TimeColumn(text: "Earlier")
                        CountsRow(counts: earlier, all: false)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 32)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Earlier: \(earlier.earlierSaid)")
            }
            ForEach(day.rows) { row in
                AppLinkView(url: row.link) { DayRowView(row: row, compact: false) }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(row.said)
            }
            Spacer(minLength: 0)
            footer
        }
    }

    // MARK: Nothing planned

    private var empty: some View {
        fitted {
            emptyLayout(head: true, sub: !state.weekPlanned)
            emptyLayout(head: true, sub: false)
        } least: {
            emptyLayout(head: false, sub: false)
        }
        .oneElement(state.todayLabel(limit: 0))
    }

    private func emptyLayout(head: Bool, sub: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if head { self.head }
            Message(icon: .today, head: "Nothing planned today", sub: sub ? "This week isn't planned yet" : nil)
            Spacer(minLength: 0)
            inboxRow
        }
    }

    // MARK: Parts

    private var head: some View {
        let head = state.todayHead
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(head.left).font(Type.eyebrow).foregroundStyle(palette.ink).lineLimit(1)
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                if state.staleSince != nil { Icon(name: .clock, size: 12) }
                Text(head.right).lineLimit(1)
            }
            .font(Type.caption)
            .foregroundStyle(palette.ink3)
        }
    }

    private func rows(_ n: Int, linked: Bool = false, times: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(state.day(limit: n).rows) { row in
                if linked {
                    AppLinkView(url: row.link) { DayRowView(row: row, compact: size == .medium, time: times) }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(row.said)
                } else {
                    DayRowView(row: row, compact: size == .medium, time: times)
                }
            }
        }
    }

    /// The last line: tomorrow's first block once the day's done, or how full the Inbox is.
    @ViewBuilder
    private var footer: some View {
        if state.mode == .finished, let t = state.tomorrow, let said = state.tomorrowSaid {
            let name = BlockName(t).shown
            AppLinkView(url: WidgetLink.today) {
                LinkRow(icon: .today) {
                    (Text("Tomorrow, \(time(t.start)): ") + Text(name.text)).privacySensitive(name.sensitive)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(said)
        } else {
            inboxRow
        }
    }

    /// Linked on the large widget; on the medium, the whole widget is one link.
    @ViewBuilder
    private var inboxRow: some View {
        let row = LinkRow(icon: .inbox) { Text(state.inboxLine) }
        if size == .large {
            AppLinkView(url: WidgetLink.inbox) { row }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(state.inboxLine)
        } else {
            row
        }
    }

    private func time(_ date: Date) -> String { Format.time(date, in: state.zone) }
}

@available(iOS 17.0, macOS 14.0, *)
private extension View {
    /// One VoiceOver element for the whole widget, read in order.
    func oneElement(_ label: String) -> some View {
        accessibilityElement(children: .ignore).accessibilityLabel(label)
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// The time column beside each row, as on Today's timeline.
private struct TimeColumn: View {
    let text: String
    @Environment(\.palette) private var palette
    @ScaledMetric(relativeTo: .caption) private var width: CGFloat = 56

    var body: some View {
        Text(text).font(Type.caption).monospacedDigit().foregroundStyle(palette.ink3).lineLimit(1)
            .frame(width: width, alignment: .trailing)
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// A row of the day: its start, then the block as Today draws it. The kind keeps its edge, solid, double or dotted, and
/// the state its frame, live dot, strike, badge and word, so both survive a tinted Home Screen that takes colour away.
struct DayRowView: View {
    let row: DayRow
    let compact: Bool
    /// Without the time column only at the very largest text, where the row is all there's room for.
    var time = true
    @Environment(\.palette) private var palette
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if !time {
                block
            } else if typeSize.isAccessibilitySize {
                // At the accessibility sizes the time goes above, so the name keeps the row's width.
                VStack(alignment: .leading, spacing: 0) {
                    Text(row.time).font(Type.caption).monospacedDigit().foregroundStyle(palette.ink3).lineLimit(1)
                    block
                }
            } else {
                HStack(spacing: 8) {
                    TimeColumn(text: row.time)
                    block
                }
            }
        }
        .padding(.vertical, compact ? 1 : 2)
    }

    private var colors: (edge: Color, tint: Color, ink: Color) {
        row.kind.map { palette.kind($0) } ?? (palette.line, palette.wash, palette.ink2)
    }

    private var block: some View {
        let c = colors
        let done = row.status == .done || row.status == .notDone
        let ink: Color = switch row.status {
        case .now, .paused: palette.ink
        case .done: palette.ink2
        case .notDone: palette.ink3
        case .event: palette.ink2
        default: c.ink
        }
        return HStack(spacing: 4) {
            mark
            Words(text: row.shown)
                .strikethrough(row.status == .done)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let trail { Text(trail).font(Type.eyebrow).lineLimit(1).layoutPriority(1) }
        }
        .font(row.status == .now || row.status == .paused ? Type.font(15, .subheadline, weight: .semibold) : Type.meta)
        .foregroundStyle(ink)
        .padding(.leading, row.kind == nil ? 9 : 10)
        .padding(.trailing, 8)
        .frame(minHeight: compact ? 28 : 36)
        .background { background(c, done: done) }
        .overlay(alignment: .leading) {
            if let kind = row.kind { MiniBlock.Edge(kind: kind, color: c.edge) } else { palette.line.frame(width: 3) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay { border(c) }
    }

    @ViewBuilder
    private var mark: some View {
        switch row.status {
        case .now:
            HStack(spacing: 4) { LiveDot(); Text("Now") }.layoutPriority(1)
        case .paused:
            HStack(spacing: 4) { Icon(name: .pause, size: 12); Text("Paused") }.layoutPriority(1)
        case .done: AnswerBadge(answer: .done)
        case .partly: AnswerBadge(answer: .partly)
        case .notDone: AnswerBadge(answer: .notDone)
        case .toAnswer: AnswerBadge(answer: .toAnswer)
        case .planned, .notStarted, .event: EmptyView()
        }
    }

    private var trail: String? {
        switch row.status {
        case .partly: "Partly"
        case .notDone: "Not done"
        case .toAnswer: "To answer"
        case .notStarted: "Not started"
        default: nil
        }
    }

    @ViewBuilder
    private func background(_ c: (edge: Color, tint: Color, ink: Color), done: Bool) -> some View {
        switch row.status {
        case .event: Stripes().fill(palette.pressed).background(palette.wash)
        case .done, .notDone: palette.card
        case .partly: HStack(spacing: 0) { c.tint; palette.card }
        default: c.tint
        }
    }

    @ViewBuilder
    private func border(_ c: (edge: Color, tint: Color, ink: Color)) -> some View {
        let shape = RoundedRectangle(cornerRadius: 6)
        switch row.status {
        case .event: EmptyView()
        case .now, .paused: shape.strokeBorder(c.edge, lineWidth: 1).overlay(shape.inset(by: 1).strokeBorder(palette.ink, lineWidth: 2))
        case .done, .notDone, .partly: shape.strokeBorder(palette.hairline, lineWidth: 1)
        case .toAnswer: shape.strokeBorder(palette.ink3, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
        case .planned, .notStarted: shape.strokeBorder(c.edge, lineWidth: 1)
        }
    }

    /// The grey diagonal stripes of an event from another calendar.
    struct Stripes: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            var x = rect.minX - rect.height
            while x < rect.maxX {
                p.move(to: CGPoint(x: x, y: rect.maxY))
                p.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
                p.addLine(to: CGPoint(x: x + rect.height + 6, y: rect.minY))
                p.addLine(to: CGPoint(x: x + 6, y: rect.maxY))
                p.closeSubpath()
                x += 12
            }
            return p
        }
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// A full-width link line at a widget's foot, 44 points tall: an icon, the words, and a chevron.
private struct LinkRow<Words: View>: View {
    let icon: IconName
    @ViewBuilder let words: Words
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Icon(name: icon, size: 20).foregroundStyle(palette.ink2)
            words.font(Type.meta).foregroundStyle(palette.ink).lineLimit(1)
            Spacer(minLength: 0)
            Icon(name: .chevron, size: 16).foregroundStyle(palette.ink3)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .overlay(alignment: .top) { palette.hairline.frame(height: 1) }
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// How the day's blocks were answered, each with its badge: every count on a finished day, only what happened when
/// folded.
struct CountsRow: View {
    let counts: WidgetState.Counts
    let all: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        let items: [(AnswerBadge.Answer, Int, String)] = [(.done, counts.done, "done"), (.partly, counts.partly, "partly"),
                                                          (.notDone, counts.notDone, "not done"), (.toAnswer, counts.toAnswer, "to answer")]
        Flow {
            ForEach(items.filter { all || $0.1 > 0 }, id: \.2) { item in
                HStack(spacing: 4) {
                    AnswerBadge(answer: item.0)
                    Text("\(item.1) \(item.2)").lineLimit(1)
                }
            }
        }
        .font(Type.caption)
        .foregroundStyle(palette.ink2)
        .accessibilityHidden(true)
    }
}
