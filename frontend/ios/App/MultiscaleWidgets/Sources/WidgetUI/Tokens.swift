import SwiftUI
import WidgetKit
import WidgetCore

@available(iOS 17.0, macOS 14.0, *)
/// The app's design tokens the widgets use, light and dark, with the same names and values as tokens.css. A test in the
/// app (frontend/src/ui/styles/widgetTokens.test.ts) reads this file and tokens.css and fails on any difference, so the
/// widgets never drift from the app. Only the roles a widget draws with are here.
enum Token {
    static let light: [String: UInt32] = [
        "card": 0xFFFFFFFF, "ink": 0x1E2126FF, "ink-2": 0x3D424AFF, "ink-3": 0x5E646EFF, "line": 0x85877FFF,
        "accent": 0x1F5F8BFF, "on-accent": 0xFFFFFFFF,
        "project": 0x1F5F8BFF, "project-tint": 0xD5E5F0FF, "project-ink": 0x123B58FF,
        "practice": 0x0F6E6EFF, "practice-tint": 0xDDF1F0FF, "practice-ink": 0x0B4F4FFF,
        "oneoff": 0x5B4A9EFF, "oneoff-tint": 0xECE8F6FF, "oneoff-ink": 0x3E3178FF,
        "hairline": 0x1E21261C, "wash": 0x1E212612, "pressed": 0x1E212621,
        "ok": 0x1E6B3EFF, "ok-tint": 0x1E6B3E24, "warn": 0x8A5300FF, "warn-tint": 0x8A530024, "danger": 0xB3261EFF, "danger-tint": 0xB3261E24,
    ]
    static let dark: [String: UInt32] = [
        "card": 0x1D1F22FF, "ink": 0xE4E5E1FF, "ink-2": 0xC3C6C9FF, "ink-3": 0x9A9FA6FF, "line": 0x787D84FF,
        "accent": 0x72B3E3FF, "on-accent": 0x1D1F22FF,
        "project": 0x72B3E3FF, "project-tint": 0x213A4EFF, "project-ink": 0xB5D7F2FF,
        "practice": 0x5CC4BEFF, "practice-tint": 0x163331FF, "practice-ink": 0x98DDD8FF,
        "oneoff": 0xB1A3ECFF, "oneoff-tint": 0x2C2645FF, "oneoff-ink": 0xD2C9F7FF,
        "hairline": 0xE4E5E11C, "wash": 0xE4E5E112, "pressed": 0xE4E5E121,
        "ok": 0x6FCF97FF, "ok-tint": 0x6FCF9724, "warn": 0xE0A040FF, "warn-tint": 0xE0A04024, "danger": 0xF08A80FF, "danger-tint": 0xF08A8024,
    ]
}

@available(iOS 17.0, macOS 14.0, *)
extension Color {
    init(rgba: UInt32) {
        self.init(.sRGB, red: Double(rgba >> 24 & 0xFF) / 255, green: Double(rgba >> 16 & 0xFF) / 255,
                  blue: Double(rgba >> 8 & 0xFF) / 255, opacity: Double(rgba & 0xFF) / 255)
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// How a widget is drawn: the app's light or dark, iOS's tinted Home Screen (accented: everything one colour on glass,
/// the kinds' colours gone), or StandBy at night (everything red). State is carried by shape and words in all four.
public enum WidgetLook: String, CaseIterable, Sendable {
    case light, dark, tinted, night
}

@available(iOS 17.0, macOS 14.0, *)
/// The colours for one look, by role.
struct Palette {
    let look: WidgetLook
    let card, ink, ink2, ink3, line, accent, onAccent, hairline, wash, pressed: Color
    private let kinds: [Snapshot.Kind: (edge: Color, tint: Color, ink: Color)]
    private let tones: [Snapshot.Aim.Status.Tone: (ink: Color, tint: Color)]

    init(_ look: WidgetLook) {
        self.look = look
        switch look {
        case .light, .dark:
            let t = look == .light ? Token.light : Token.dark
            func c(_ name: String) -> Color { Color(rgba: t[name]!) }
            card = c("card"); ink = c("ink"); ink2 = c("ink-2"); ink3 = c("ink-3"); line = c("line")
            accent = c("accent"); onAccent = c("on-accent"); hairline = c("hairline"); wash = c("wash"); pressed = c("pressed")
            let project = (c("project"), c("project-tint"), c("project-ink"))
            // A planning block or an Inbox item has no kind colour of its own: the wash, with an ink-3 edge.
            let plain = (c("ink-3"), c("wash"), c("ink-2"))
            kinds = [.project: project, .practice: (c("practice"), c("practice-tint"), c("practice-ink")),
                     .oneoff: (c("oneoff"), c("oneoff-tint"), c("oneoff-ink")), .planning: plain, .inbox: plain]
            // A status pill's word on its tint, as the app's Pill draws it.
            tones = [.green: (c("ok"), c("ok-tint")), .amber: (c("warn"), c("warn-tint")), .red: (c("danger"), c("danger-tint")), .grey: (c("ink-2"), c("wash"))]
        case .tinted, .night:
            // One colour at three strengths, as iOS draws accented widgets and StandBy's night mode.
            let base: Color = look == .tinted ? .white : Color(red: 1, green: 0.23, blue: 0.19)
            card = look == .tinted ? Color(red: 0.13, green: 0.2, blue: 0.3) : .black
            ink = base; ink2 = base.opacity(0.78); ink3 = base.opacity(0.56); line = base.opacity(0.5)
            accent = base; onAccent = card; hairline = base.opacity(0.18); wash = base.opacity(0.12); pressed = base.opacity(0.2)
            let one = (base, base.opacity(0.12), base)
            kinds = [.project: one, .practice: one, .oneoff: one, .planning: one, .inbox: one]
            let pill = (base, base.opacity(0.18))
            tones = [.green: pill, .amber: pill, .red: pill, .grey: pill]
        }
    }

    func kind(_ k: Snapshot.Kind) -> (edge: Color, tint: Color, ink: Color) { kinds[k]! }
    func tone(_ t: Snapshot.Aim.Status.Tone) -> (ink: Color, tint: Color) { tones[t]! }
}

@available(iOS 17.0, macOS 14.0, *)
struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette(.light)
}

@available(iOS 17.0, macOS 14.0, *)
extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}
