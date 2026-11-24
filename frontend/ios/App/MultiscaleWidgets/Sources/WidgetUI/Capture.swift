import SwiftUI
import WidgetKit
import WidgetCore

@available(iOS 17.0, macOS 14.0, *)
/// Capture: one tap into Capture, through the link the Control Center button already opens, and how full the Inbox is,
/// which says whether Process is due. Two links and no buttons, since capturing needs a keyboard.
public struct CaptureView: View {
    let state: WidgetState
    @Environment(\.palette) private var palette

    public init(state: WidgetState) {
        self.state = state
    }

    public var body: some View {
        ViewThatFits(in: .vertical) {
            content
            content.dynamicTypeSize(...DynamicTypeSize.accessibility2)
            content.dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(state.captureLabel)
    }

    private var content: some View {
        VStack(spacing: 6) {
            AppLinkView(url: WidgetLink.capture) {
                VStack(spacing: 4) {
                    Icon(name: .plus, size: 24)
                    Text("Capture").font(Type.label).lineLimit(1)
                }
                .foregroundStyle(palette.ink)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 14).strokeBorder(palette.line, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: 14))
            }
            .accessibilityLabel("Capture")
            AppLinkView(url: state.mode == .signedOut ? WidgetLink.today : WidgetLink.inbox) {
                HStack(spacing: 6) {
                    Icon(name: .inbox, size: 20).foregroundStyle(palette.ink2)
                    Text(state.inboxLine).font(Type.meta).foregroundStyle(palette.ink).lineLimit(1).minimumScaleFactor(0.8)
                    Spacer(minLength: 0)
                    if state.mode != .signedOut { Icon(name: .chevron, size: 16).foregroundStyle(palette.ink3) }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel(state.inboxLine)
        }
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// A widget's frame outside WidgetKit, which draws the background and margins itself: the card colour, 16-point margins,
/// and the corner iOS gives a widget. The render tests draw every widget in one.
public struct WidgetFrame<Content: View>: View {
    let look: WidgetLook
    let size: CGSize
    let content: Content

    public init(look: WidgetLook, size: CGSize, @ViewBuilder content: () -> Content) {
        self.look = look
        self.size = size
        self.content = content()
    }

    public var body: some View {
        content
            .padding(16)
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(Palette(look).card)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .environment(\.palette, Palette(look))
    }
}

@available(iOS 17.0, macOS 14.0, *)
extension View {
    /// The look's colours for everything inside, as the extension sets them from the colour scheme and rendering mode.
    public func widgetLook(_ look: WidgetLook) -> some View { environment(\.palette, Palette(look)) }
}

@available(iOS 17.0, macOS 14.0, *)
extension WidgetLook {
    /// The card colour, as the widget's background.
    public var card: Color { Palette(self).card }
}

@available(iOS 17.0, macOS 14.0, *)
public enum WidgetSize {
    /// iPhone sizes from Apple's guidelines, for a 393-point-wide phone.
    public static let small = CGSize(width: 158, height: 158)
    public static let medium = CGSize(width: 338, height: 158)
}
