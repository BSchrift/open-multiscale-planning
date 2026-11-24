import SwiftUI
import WidgetKit
import WidgetCore

@available(iOS 17.0, macOS 14.0, *)
/// This week: is the week's plan holding? Each day's planned time with today marked, and each aim's planned time against
/// it with its project's pill. Large adds each practice's sessions so far. When the week isn't planned it says so and
/// opens Plan; otherwise a tap opens Week. No buttons.
public struct WeekView: View {
    public enum Size: String, CaseIterable, Sendable { case medium, large }

    let state: WeekState
    let size: Size
    @Environment(\.palette) private var palette
    @Environment(\.redactionReasons) private var redaction

    public init(state: WeekState, size: Size) {
        self.state = state
        self.size = size
    }

    /// Where a tap anywhere goes: Week, or Plan while the week isn't planned.
    public var link: URL { state.link }

    /// A locked iPad with Lock Screen widget access off hides names, and VoiceOver then reads placeholders.
    private var redacted: Bool { redaction.contains(.privacy) }

    public var body: some View {
        ViewThatFits(in: .vertical) {
            ForEach(layouts, id: \.self) { layout in
                content(layout)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(state.label(large: size == .large, aimsShown: layout.aims, practicesShown: layout.practices, redacted: redacted))
            }
            // Only when even the least won't fit, at the very largest sizes, does the text stop growing.
            content(layouts.last!).dynamicTypeSize(...DynamicTypeSize.accessibility2)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(state.label(large: size == .large, aimsShown: layouts.last!.aims, practicesShown: 0, redacted: redacted))
            content(layouts.last!).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(state.label(large: size == .large, aimsShown: layouts.last!.aims, practicesShown: 0, redacted: redacted))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(palette.ink)
    }

    // MARK: Layouts

    /// What one try draws. At larger text, less rather than smaller: first practices go, then aims, then the bars, and
    /// last the heading line.
    struct Layout: Hashable {
        var header = true
        /// The day bars, or for a message in their place, its icon.
        var bars = true
        var aims = 0
        var practices = 0
        /// The line under each aim's bar: "7h 30m of 8h".
        var lines = false
    }

    private var layouts: [Layout] {
        guard state.mode == .planned else {
            return [Layout(), Layout(header: false), Layout(header: false, bars: false)]
        }
        let a = state.aims.count, p = state.practices.count
        var out: [Layout]
        switch size {
        case .medium:
            out = [Layout(aims: min(a, 3)), Layout(aims: min(a, 2)), Layout(aims: min(a, 1)), Layout(bars: false, aims: min(a, 2)),
                   Layout(bars: false, aims: min(a, 1)), Layout(header: false, bars: false, aims: min(a, 1))]
        case .large:
            out = [(3, 3), (3, 2), (2, 2), (2, 1), (1, 1), (1, 0), (0, 0)].map { Layout(aims: min(a, $0.0), practices: min(p, $0.1), lines: true) }
            out += [Layout(aims: min(a, 2)), Layout(bars: false, aims: min(a, 2)), Layout(bars: false, aims: min(a, 1)),
                    Layout(header: false, bars: false, aims: min(a, 1))]
        }
        // Each only once, in order: a week with few aims makes some the same, and ForEach needs each to be its own.
        return out.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
    }

    @ViewBuilder
    private func content(_ layout: Layout) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            switch state.mode {
            case .planned:
                if layout.header { header }
                switch size {
                case .medium: medium(layout)
                case .large: large(layout)
                }
            case .unplanned:
                if layout.header { header }
                if layout.bars {
                    Message(icon: .week, head: "This week isn't planned yet")
                } else {
                    Text("This week isn't planned yet").font(Type.heading).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                LinkButton(title: "Plan your week", url: WidgetLink.plan, filled: true)
            case .newWeek:
                if layout.header { header }
                message("Open Multiscale to show this week here", layout)
            case .signedOut:
                message("Sign in to see your week", layout, sub: size == .large ? "Your week shows here after you sign in." : nil)
            case .noData:
                message("Open Multiscale once to show your week here", layout)
            case .tooNew:
                message("Open Multiscale to update this widget", layout)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func message(_ head: String, _ layout: Layout, sub: String? = nil) -> some View {
        if layout.bars {
            Message(icon: .week, head: head, sub: layout.header ? sub : nil)
        } else {
            Text(head).font(Type.heading).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// "This week", then the dates, with when it last synced once that's over an hour ago.
    private var header: some View {
        let dates = state.staleSince.map { "\(state.range) · synced \(Format.time($0, in: state.zone))" } ?? state.range
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("This week").font(Type.eyebrow).foregroundStyle(palette.ink).lineLimit(1)
                Spacer(minLength: 0)
                Text(dates).font(Type.caption).foregroundStyle(palette.ink3).lineLimit(1)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text("This week").font(Type.eyebrow).foregroundStyle(palette.ink)
                Text(dates).font(Type.caption).foregroundStyle(palette.ink3).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func medium(_ layout: Layout) -> some View {
        // The bars stand on the bottom edge, and the aims hang from the heading.
        HStack(alignment: .top, spacing: 14) {
            if layout.bars { DayBars(state: state).frame(width: 130).frame(maxHeight: .infinity, alignment: .bottom) }
            aims(layout).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func large(_ layout: Layout) -> some View {
        if layout.bars { DayBars(state: state) }
        aims(layout).padding(.top, layout.bars ? 6 : 0)
        if layout.practices > 0 {
            VStack(alignment: .leading, spacing: 6) {
                Text("Practices").font(Type.eyebrow).foregroundStyle(palette.ink2)
                ForEach(state.practices.prefix(layout.practices).indices, id: \.self) { PracticeLine(practice: state.practices[$0]) }
            }
            .padding(.top, 8)
            .overlay(alignment: .top) { palette.hairline.frame(height: 1) }
            .padding(.top, 4)
        }
        Spacer(minLength: 0)
    }

    @ViewBuilder
    private func aims(_ layout: Layout) -> some View {
        if state.aims.isEmpty {
            Text("No weekly aims this week").font(Type.caption).foregroundStyle(palette.ink2).fixedSize(horizontal: false, vertical: true)
        } else if layout.aims > 0 {
            VStack(alignment: .leading, spacing: layout.lines ? 10 : 6) {
                ForEach(state.aims.prefix(layout.aims).indices, id: \.self) { AimLine(aim: state.aims[$0], withLine: layout.lines) }
            }
        }
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// Each day's planned time as a bar, Monday first, under its letter. Today's is the strong one, its letter underlined,
/// so it survives a tinted Home Screen. A day of 6 hours or more fills its bar, so a light week looks light.
struct DayBars: View {
    let state: WeekState
    @Environment(\.palette) private var palette

    static let height: CGFloat = 52
    /// The tallest bar stands for this much, or for the week's busiest day if that's more.
    static let fullMinutes = 360

    var body: some View {
        let full = CGFloat(max(state.mostMinutes, DayBars.fullMinutes))
        HStack(alignment: .bottom, spacing: 6) {
            ForEach(state.days, id: \.date) { day in
                VStack(spacing: 4) {
                    UnevenRoundedRectangle(topLeadingRadius: 4, bottomLeadingRadius: 2, bottomTrailingRadius: 2, topTrailingRadius: 4)
                        .fill(day.isToday ? palette.ink2 : palette.pressed)
                        .frame(height: max(2, CGFloat(day.minutes) / full * DayBars.height))
                        .frame(height: DayBars.height, alignment: .bottom)
                        .widgetAccentable(day.isToday)
                    Text(day.letter)
                        .font(day.isToday ? Type.eyebrow : Type.caption)
                        .underline(day.isToday)
                        .foregroundStyle(day.isToday ? palette.ink : palette.ink3)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .accessibilityHidden(true)
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// An aim: its name and its project's pill, a bar of planned time against the aim in the kind's colour, and on the large
/// widget the figures under it.
struct AimLine: View {
    let aim: WeekState.AimRow
    let withLine: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Words(text: aim.name)
                    .font(Type.meta.weight(.semibold))
                    .foregroundStyle(aim.name.sensitive || aim.kind == .oneoff ? palette.ink : palette.ink2)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let status = aim.status { StatusPill(status: status) }
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.wash)
                    Capsule().fill(palette.kind(aim.kind == .oneoff ? .oneoff : .project).edge).frame(width: g.size.width * aim.fraction)
                }
            }
            .frame(height: 4)
            if withLine { Text(aim.line).font(Type.caption).foregroundStyle(palette.ink2).lineLimit(1) }
        }
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// A project's status, as the app's pill draws it: its word on its tone's tint.
struct StatusPill: View {
    let status: Snapshot.Aim.Status
    @Environment(\.palette) private var palette

    var body: some View {
        let tone = palette.tone(status.tone)
        Text(status.pill)
            .font(Type.eyebrow)
            .foregroundStyle(tone.ink)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(tone.tint))
            .fixedSize()
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// A practice: its name, a dot for each session it wants this week, filled for each done, and "2 of 3".
struct PracticeLine: View {
    let practice: WeekState.PracticeRow
    @Environment(\.palette) private var palette

    var body: some View {
        let colour = palette.kind(.practice).edge
        HStack(spacing: 8) {
            Words(text: practice.name)
                .font(Type.meta.weight(.semibold))
                .foregroundStyle(practice.name.sensitive ? palette.ink : palette.ink2)
                .lineLimit(1)
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                ForEach(0..<min(practice.of, 7), id: \.self) { i in
                    Circle().strokeBorder(colour, lineWidth: 1.5)
                        .background(Circle().fill(i < practice.done ? colour : .clear))
                        .frame(width: 10, height: 10)
                }
            }
            .accessibilityHidden(true)
            Text(practice.line).font(Type.caption).foregroundStyle(palette.ink2).lineLimit(1).fixedSize()
        }
    }
}
