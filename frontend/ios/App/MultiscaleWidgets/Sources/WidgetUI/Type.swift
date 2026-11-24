import CoreText
import SwiftUI
import WidgetKit

@available(iOS 17.0, macOS 14.0, *)
/// The app's one family, Instrument Sans, the same files the web app loads (an app test checks they're identical), and
/// its text styles as docs/design.md maps them to Apple's: each scales with the phone's text size from Large to AX5, and
/// nothing is smaller than Caption's 12pt.
enum Type {
    private static let registered: Void = {
        for name in ["instrument-sans-latin-wght-normal", "instrument-sans-latin-ext-wght-normal"] {
            guard let url = Bundle.module.url(forResource: name, withExtension: "woff2", subdirectory: "Fonts") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }()

    static func font(_ size: CGFloat, _ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        _ = registered
        return Font.custom("Instrument Sans", size: size, relativeTo: style).weight(weight)
    }

    /// Heading 17/24, as Headline: a block's title.
    static var heading: Font { font(17, .headline, weight: .semibold) }
    /// Meta 15/20, as Subheadline: times and lines under a title.
    static var meta: Font { font(15, .subheadline) }
    /// Label 16/22, as Callout: buttons.
    static var label: Font { font(16, .callout, weight: .semibold) }
    /// Caption 12/16, as Caption 1: eyebrows. Nothing is smaller.
    static var caption: Font { font(12, .caption, weight: .regular) }
    static var eyebrow: Font { font(12, .caption, weight: .semibold) }
    /// The countdown, as Title 1, with figures that don't jump as they tick.
    static var countdown: Font { font(28, .title, weight: .semibold).monospacedDigit() }
}
