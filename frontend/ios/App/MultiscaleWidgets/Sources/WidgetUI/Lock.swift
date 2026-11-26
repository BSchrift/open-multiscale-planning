import SwiftUI
import WidgetKit
import WidgetCore

@available(iOS 17.0, macOS 14.0, *)
extension WidgetSize {
    /// The Lock Screen's, from Apple's guidelines, for a 393-point-wide phone.
    public static let inline = CGSize(width: 234, height: 26)
    public static let rectangular = CGSize(width: 160, height: 72)
    public static let circular = CGSize(width: 72, height: 72)
}

@available(iOS 17.0, macOS 14.0, *)
/// The Lock Screen set: the same glance as Now and next, from the Lock Screen and the Always On display, without
/// unlocking. A line beside the date, a rectangular card, a ring of time spent with the countdown inside, and the Inbox
/// count. No buttons: iOS keeps them inactive until unlock, and a widget that can't be used shouldn't look tappable.
public struct LockView: View {
    public enum Family: String, CaseIterable, Sendable { case inline, rectangular, countdown, inbox }

    let state: WidgetState
    let family: Family
    @Environment(\.palette) private var palette
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.drawnStill) private var still

    public init(state: WidgetState, family: Family) {
        self.state = state
        self.family = family
    }

    /// A locked phone with Lock Screen widget access off hides names, and the placeholders show and are read instead.
    private var redacted: Bool { redaction.contains(.privacy) }

    public var body: some View {
        switch family {
        case .inline: inline
        case .rectangular: rectangular
        case .countdown: countdown
        case .inbox: inbox
        }
    }

    /// Where a tap goes, after unlock: Today, or the Inbox for its circle. Signed out, Today asks to sign in.
    public static func link(_ family: Family, _ state: WidgetState) -> URL {
        family == .inbox && state.mode != .signedOut ? WidgetLink.inbox : WidgetLink.today
    }

    // MARK: Inline

    /// iOS draws an inline widget's text in the Lock Screen's own font, beside the date, which doesn't grow with the text
    /// size, and draws only its first text and image; the picture does the same.
    private var inline: some View {
        let line = state.inline(redacted: redacted)
        let icon: IconName = switch line.mark {
        case .live: .live
        case .clock: .clock
        case .today: .today
        }
        return Label {
            Words(text: line.text).lineLimit(1)
        } icon: {
            Icon.image(icon, size: 15)
        }
        .font(.system(.subheadline, weight: .semibold))
        .foregroundStyle(palette.ink2)
        .dynamicTypeSize(...DynamicTypeSize.large)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.inlineLabel(redacted: redacted))
    }

    // MARK: Rectangular

    /// At larger text, less rather than smaller: the eyebrow goes first, then the foot, and the name keeps its line. Only
    /// when the name alone won't fit does its text stop growing.
    private var rectangular: some View {
        let card = state.rectangular(redacted: redacted)
        return ViewThatFits(in: .vertical) {
            self.card(card, eyebrow: true, foot: true)
            self.card(card, eyebrow: false, foot: true)
            self.card(card, eyebrow: true, foot: false)
            self.card(card, eyebrow: false, foot: false)
            self.card(card, eyebrow: false, foot: false).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.rectangularLabel(redacted: redacted))
    }

    private func card(_ card: WidgetState.LockCard, eyebrow: Bool, foot: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if eyebrow { Text(card.eyebrow).font(Type.eyebrow).foregroundStyle(palette.ink2).lineLimit(1) }
            Words(text: card.title).font(Type.font(15, .subheadline, weight: .semibold)).foregroundStyle(palette.ink).lineLimit(1)
            if foot {
                switch card.foot {
                case .countdown:
                    HStack(spacing: 8) {
                        TimerText(state: state, font: Type.font(15, .subheadline, weight: .semibold).monospacedDigit())
                        if let since = state.staleSince {
                            Text("Synced \(Format.time(since, in: state.zone))").font(Type.caption).foregroundStyle(palette.ink2).lineLimit(1)
                        } else {
                            SpentBar(state: state)
                        }
                    }
                case let .words(options):
                    // The longest words that fit the width, rather than cutting them off.
                    ViewThatFits(in: .horizontal) {
                        ForEach(options, id: \.self) { Text($0).lineLimit(1) }
                    }
                    .font(Type.caption)
                    .foregroundStyle(palette.ink2)
                case .none:
                    EmptyView()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Circles

    /// The countdown circle: the ring of time spent, which iOS fills without waking the widget, stopped while paused.
    private var countdown: some View {
        let ring = state.ring
        return Circled {
            ZStack {
                Circle().stroke(palette.hairline, lineWidth: 5)
                if let range = state.spentRange, !still {
                    ProgressView(timerInterval: range, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
                        .progressViewStyle(.circular)
                        .tint(palette.ink)
                        .widgetAccentable()
                } else if ring.fill > 0 {
                    Circle().trim(from: 0, to: ring.fill)
                        .stroke(palette.ink, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .widgetAccentable()
                }
                middle(ring.middle).frame(width: 50, height: 50)
            }
            .padding(3)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.ringLabel)
    }

    /// Inside the ring: the figure and a word, then the figure alone, and only then figures that stop growing.
    @ViewBuilder
    private func middle(_ middle: WidgetState.LockRing.Middle) -> some View {
        let number = Type.font(15, .subheadline, weight: .semibold).monospacedDigit()
        let small = Type.eyebrow.monospacedDigit()
        switch middle {
        case .countdown:
            ViewThatFits {
                Stacked(TimerText(state: state, font: number), "left")
                Stacked(TimerText(state: state, font: small), "left")
                TimerText(state: state, font: small)
                TimerText(state: state, font: small).dynamicTypeSize(...DynamicTypeSize.large)
            }
        case .paused:
            ViewThatFits {
                Stacked(Icon(name: .pause, size: 14), "Paused")
                Icon(name: .pause, size: 18)
            }
        case .notStarted:
            ViewThatFits {
                Stacked(Icon(name: .clock, size: 18), "Start")
                Icon(name: .clock, size: 22)
            }
        case let .minutes(n):
            ViewThatFits {
                Stacked(Text("\(n)m").font(number), "to next")
                Text("\(n)m").font(number)
                Text("\(n)m").font(number).dynamicTypeSize(...DynamicTypeSize.large)
            }
        case let .at(time):
            ViewThatFits {
                Stacked(Text(time).font(number), "next")
                Text(time).font(number)
                Text(time).font(small).dynamicTypeSize(...DynamicTypeSize.large)
            }
        case .today:
            Icon(name: .today, size: 22)
        }
    }

    private var inbox: some View {
        let circle = state.inboxCircle
        return Circled {
            Group {
                if let count = circle.count {
                    let number = Type.font(15, .subheadline, weight: .semibold)
                    ViewThatFits {
                        VStack(spacing: 0) {
                            Icon(name: .inbox, size: 20)
                            Text(count).font(number).lineLimit(1)
                        }
                        Text(count).font(number).lineLimit(1)
                        Text(count).font(number).lineLimit(1).dynamicTypeSize(...DynamicTypeSize.large)
                    }
                } else {
                    Icon(name: .inbox, size: 22)
                }
            }
            .frame(width: 56, height: 56)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(circle.said)
    }

    /// A circle on the Lock Screen's own backing, which iOS draws behind it: a soft wash in a picture. Its text grows only
    /// a little with the text size, as the system's circles do, since a circle can't grow.
    private struct Circled<Content: View>: View {
        @ViewBuilder let content: Content
        @Environment(\.palette) private var palette
        @Environment(\.drawnStill) private var still

        var body: some View {
            ZStack {
                if still { Circle().fill(palette.wash) } else { AccessoryWidgetBackground() }
                content.foregroundStyle(palette.ink)
            }
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// A figure or icon over a word in a circle.
    private struct Stacked<Top: View>: View {
        let top: Top
        let word: String
        @Environment(\.palette) private var palette

        init(_ top: Top, _ word: String) {
            self.top = top
            self.word = word
        }

        var body: some View {
            VStack(spacing: 0) {
                top.lineLimit(1)
                Text(word).font(Type.caption).foregroundStyle(palette.ink2).lineLimit(1)
            }
        }
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// The countdown's figures alone, live in WidgetKit and stopped where a pause stopped it, at the entry's moment in a
/// picture.
struct TimerText: View {
    let state: WidgetState
    let font: Font
    @Environment(\.drawnStill) private var still

    var body: some View {
        Group {
            if let countdown = state.countdown, !still {
                Text(timerInterval: countdown.range, pauseTime: countdown.pauseTime, countsDown: true, showsHours: true)
            } else {
                Text(Countdown.clock(state.timeLeft))
            }
        }
        .font(font)
        .lineLimit(1)
        .widgetAccentable()
    }
}

@available(iOS 17.0, macOS 14.0, *)
extension Icon {
    /// An icon as an image, for the Lock Screen's inline widget, where iOS draws text and images only. Drawn as a
    /// template, so it takes the colour around it.
    static func image(_ name: IconName, size: CGFloat) -> Image {
        Image(size: CGSize(width: size, height: size)) { context in
            let rect = CGRect(x: 0, y: 0, width: size, height: size)
            context.stroke(IconShape(name: name).path(in: rect), with: .color(.black),
                           style: StrokeStyle(lineWidth: 1.75 * size / 24, lineCap: .round, lineJoin: .round))
            context.fill(IconFill(name: name).path(in: rect), with: .color(.black))
        }
        .renderingMode(.template)
    }
}
