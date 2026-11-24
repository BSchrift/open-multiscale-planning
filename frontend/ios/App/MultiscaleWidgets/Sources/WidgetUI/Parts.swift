import SwiftUI
import WidgetKit
import WidgetCore

@available(iOS 17.0, macOS 14.0, *)
/// What a widget's button becomes. The extension makes each an App Intent button (iOS 17), whose tap runs in place; the
/// render tests, and anything else outside WidgetKit, draw the label alone.
public struct WidgetButtonMaker: Sendable {
    let make: @Sendable (WidgetButton, AnyView) -> AnyView
    public init(_ make: @escaping @Sendable (WidgetButton, AnyView) -> AnyView) { self.make = make }
    static let drawn = WidgetButtonMaker { _, label in label }
}

@available(iOS 17.0, macOS 14.0, *)
struct WidgetButtonMakerKey: EnvironmentKey {
    static let defaultValue = WidgetButtonMaker.drawn
}

@available(iOS 17.0, macOS 14.0, *)
extension EnvironmentValues {
    var widgetButtonMaker: WidgetButtonMaker {
        get { self[WidgetButtonMakerKey.self] }
        set { self[WidgetButtonMakerKey.self] = newValue }
    }
}

@available(iOS 17.0, macOS 14.0, *)
extension View {
    /// How the widget's buttons are made: in the extension, as App Intent buttons.
    public func widgetButtons(_ maker: WidgetButtonMaker) -> some View { environment(\.widgetButtonMaker, maker) }
}

@available(iOS 17.0, macOS 14.0, *)
struct StillKey: EnvironmentKey {
    static let defaultValue = false
}

@available(iOS 17.0, macOS 14.0, *)
extension EnvironmentValues {
    /// Drawn once, as a picture, rather than by WidgetKit: the countdown and the bar show their value at the entry's
    /// moment, since only WidgetKit keeps them live, and a picture would show them at the time it was taken.
    var drawnStill: Bool {
        get { self[StillKey.self] }
        set { self[StillKey.self] = newValue }
    }
}

@available(iOS 17.0, macOS 14.0, *)
extension View {
    /// For pictures of a widget, such as the render tests' and the reviews they make.
    public func drawnStill() -> some View { environment(\.drawnStill, true) }
}

@available(iOS 17.0, macOS 14.0, *)
/// A line of text a widget shows, hidden by iOS on a locked phone with Lock Screen widget access off when it's a name.
struct Words: View {
    let text: WidgetText
    var body: some View { Text(text.text).privacySensitive(text.sensitive) }
}

@available(iOS 17.0, macOS 14.0, *)
/// The small line above a widget's title: an icon or the live dot, then a few words.
struct Eyebrow<Mark: View>: View {
    let text: String
    @ViewBuilder let mark: Mark
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            mark
            Text(text).lineLimit(1)
        }
        .font(Type.eyebrow)
        .foregroundStyle(palette.ink2)
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// The live dot of a block in progress, which a tinted Home Screen draws in its accent.
struct LiveDot: View {
    @Environment(\.palette) private var palette
    var body: some View {
        Circle().fill(palette.ink).frame(width: 8, height: 8)
            .overlay(Circle().stroke(palette.hairline, lineWidth: 3).frame(width: 14, height: 14))
            .frame(width: 12, height: 12)
            .widgetAccentable()
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// A block as the calendars draw it, small: the kind's tint, and its edge solid for a project, double for a practice,
/// dotted for a one off, so the kind survives a tinted Home Screen, which takes the colour away.
struct MiniBlock: View {
    let block: Snapshot.Block
    let name: BlockName
    @Environment(\.palette) private var palette

    var body: some View {
        let kind = palette.kind(block.kind)
        Words(text: name.shown)
            .font(Type.meta)
            .foregroundStyle(kind.ink)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
            .padding(.leading, 12)
            .padding(.trailing, 8)
            .background(kind.tint)
            .overlay(alignment: .leading) { Edge(kind: block.kind, color: kind.edge) }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(kind.edge, lineWidth: 1))
    }

    struct Edge: View {
        let kind: Snapshot.Kind
        let color: Color
        var body: some View {
            switch kind {
            case .practice:
                HStack(spacing: 1) { color.frame(width: 1.5); color.frame(width: 1.5) }
            case .oneoff:
                Rectangle().fill(.clear).frame(width: 4)
                    .overlay(Line().stroke(color, style: StrokeStyle(lineWidth: 4, dash: [2, 2])))
            case .planning, .inbox:
                Rectangle().fill(.clear).frame(width: 4)
                    .overlay(Line().stroke(color, style: StrokeStyle(lineWidth: 4, dash: [4, 3])))
            case .project:
                color.frame(width: 4)
            }
        }
    }

    struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            p.move(to: CGPoint(x: rect.midX, y: rect.minY))
            p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
            return p
        }
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// The bar of time spent: live while the block runs, still while it's paused.
struct SpentBar: View {
    let state: WidgetState
    @Environment(\.palette) private var palette
    @Environment(\.drawnStill) private var still

    var body: some View {
        Group {
            if let range = state.spentRange, !still {
                ProgressView(timerInterval: range, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
                    .progressViewStyle(.linear)
                    .tint(palette.ink2)
            } else {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(palette.wash)
                        Capsule().fill(palette.ink2).frame(width: g.size.width * state.spentFraction)
                    }
                }
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// The countdown to the block's end, which iOS keeps ticking without waking the widget, and stops where a pause did.
struct Countdown: View {
    let state: WidgetState
    /// At the accessibility sizes: no "left", and the number narrows rather than be cut short.
    var compact = false
    @Environment(\.palette) private var palette
    @Environment(\.drawnStill) private var still

    var body: some View {
        if let countdown = state.countdown {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Group {
                    if still {
                        Text(Countdown.clock(state.timeLeft))
                    } else {
                        Text(timerInterval: countdown.range, pauseTime: countdown.pauseTime, countsDown: true, showsHours: true)
                    }
                }
                .font(Type.countdown)
                .foregroundStyle(state.mode == .paused ? palette.ink3 : palette.ink)
                .lineLimit(1)
                .minimumScaleFactor(compact ? 0.5 : 1)
                .widgetAccentable()
                if !compact { Text("left").font(Type.caption).foregroundStyle(palette.ink2).lineLimit(1) }
            }
        }
    }

    /// As the live countdown writes it: "26:00", or "1:05:00" past an hour.
    static func clock(_ seconds: TimeInterval) -> String {
        let s = Int(seconds.rounded(.down)), h = s / 3600, m = s / 60 % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s % 60) : String(format: "%d:%02d", m, s % 60)
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// "Synced at 7:58am", in place of the bar, when the last sync is over an hour old.
struct SyncedLine: View {
    let since: Date
    let state: WidgetState
    @Environment(\.palette) private var palette
    var body: some View {
        HStack(spacing: 4) {
            Icon(name: .clock, size: 12)
            Text("Synced at \(Format.time(since, in: state.zone))").lineLimit(1)
        }
        .font(Type.caption)
        .foregroundStyle(palette.ink3)
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// The medium widget's one button, 44 points tall: filled for the one thing to do, outlined for a step back.
struct ActionButton: View {
    let button: WidgetButton
    let name: String
    @Environment(\.palette) private var palette
    @Environment(\.widgetButtonMaker) private var maker

    private var filled: Bool {
        switch button {
        case .start, .startEarly, .resume: true
        case .pause, .undo: false
        }
    }

    var body: some View {
        let label = HStack(spacing: 6) {
            switch button {
            case .pause: Icon(name: .pause, size: 14)
            case .resume: Icon(name: .play, size: 14)
            case .undo: Icon(name: .undo, size: 16)
            default: EmptyView()
            }
            Text(button.title).lineLimit(1).minimumScaleFactor(0.8)
        }
        .font(Type.label)
        .foregroundStyle(filled ? palette.onAccent : palette.ink)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(RoundedRectangle(cornerRadius: 8).fill(filled ? palette.accent : .clear))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(filled ? .clear : palette.line, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(button.label(name))
        .accessibilityAddTraits(.isButton)
        maker.make(button, AnyView(label))
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// A link to the app in a widget. Drawn as a picture, only its label: a Link draws only inside WidgetKit.
struct AppLinkView<Label: View>: View {
    let url: URL
    @ViewBuilder let label: Label
    @Environment(\.drawnStill) private var still

    var body: some View {
        if still { label } else { Link(destination: url) { label } }
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// A link styled as a button, for the medium widget's Plan your week, Open Today and Sign in.
struct LinkButton: View {
    let title: String
    let url: URL
    let filled: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        AppLinkView(url: url) {
            Text(title).font(Type.label).lineLimit(1).minimumScaleFactor(0.8)
                .foregroundStyle(filled ? palette.onAccent : palette.ink)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(RoundedRectangle(cornerRadius: 8).fill(filled ? palette.accent : .clear))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(filled ? .clear : palette.line, lineWidth: 1))
        }
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// Items in rows, as many to a row as fit, as the app's counts row wraps.
struct Flow: Layout {
    var spacing: CGFloat = 10
    var lineSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for i in row.items {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
        for (i, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if let last = rows.last, last.width + spacing + size.width <= width {
                rows[rows.count - 1] = (last.items + [i], last.width + spacing + size.width, max(last.height, size.height))
            } else {
                rows.append(([i], size.width, size.height))
            }
        }
        return rows
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// A round answer badge, in ink rather than a kind's colour.
struct AnswerBadge: View {
    enum Answer { case done, partly, notDone, toAnswer }
    let answer: Answer
    @Environment(\.palette) private var palette

    var body: some View {
        switch answer {
        case .done:
            Circle().fill(palette.ink2).frame(width: 12, height: 12)
                .overlay(IconShape(name: .done).stroke(palette.card, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)).frame(width: 8, height: 8))
        case .partly:
            Icon(name: .partly, size: 12).foregroundStyle(palette.ink2)
        case .notDone:
            Circle().strokeBorder(palette.ink3, lineWidth: 1.2).frame(width: 12, height: 12)
                .overlay(IconShape(name: .notDone).stroke(palette.ink2, style: StrokeStyle(lineWidth: 1.6, lineCap: .round)).frame(width: 8, height: 8))
        case .toAnswer:
            Icon(name: .noAnswer, size: 12).foregroundStyle(palette.ink2)
        }
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// A message in place of the day: an icon, what's the matter, and what to do.
struct Message: View {
    /// None at the accessibility sizes, where the words need the room.
    let icon: IconName?
    let head: String
    var sub: String? = nil
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let icon { Icon(name: icon, size: 20).foregroundStyle(palette.ink3) }
            Text(head).font(Type.heading).foregroundStyle(palette.ink).lineLimit(icon == nil ? 4 : nil).minimumScaleFactor(icon == nil ? 0.7 : 1)
                .fixedSize(horizontal: false, vertical: icon != nil)
            if let sub { Text(sub).font(Type.caption).foregroundStyle(palette.ink2).fixedSize(horizontal: false, vertical: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
