import SwiftUI
import WidgetKit

@available(iOS 17.0, macOS 14.0, *)
/// The app's icons (Icon.tsx), drawn from the same 24-point paths: stroked at 1.75 with round caps and joins, filled only
/// where a state needs it. Hidden from VoiceOver: the widget's label says it all.
enum IconName {
    case clock, today, inbox, plus, chevron, undo, live, done, notDone, partly, noAnswer, pause, play
}

@available(iOS 17.0, macOS 14.0, *)
struct Icon: View {
    let name: IconName
    var size: CGFloat = 16
    @Environment(\.palette) private var palette

    var body: some View {
        IconShape(name: name)
            .stroke(style: StrokeStyle(lineWidth: 1.75 * size / 24, lineCap: .round, lineJoin: .round))
            .overlay(IconFill(name: name).fill())
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// The stroked part of an icon, on a 24-point grid scaled to its frame.
struct IconShape: Shape {
    let name: IconName

    func path(in rect: CGRect) -> Path {
        let s = rect.width / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        func line(_ points: (CGFloat, CGFloat)...) {
            path.move(to: p(points[0].0, points[0].1))
            for pt in points.dropFirst() { path.addLine(to: p(pt.0, pt.1)) }
        }
        func circle(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) {
            path.addEllipse(in: CGRect(x: rect.minX + (x - r) * s, y: rect.minY + (y - r) * s, width: 2 * r * s, height: 2 * r * s))
        }
        switch name {
        case .clock:
            circle(12, 12, 8)
            line((12, 7.5), (12, 12), (15, 14))
        case .today:
            circle(12, 12, 3.6)
            for (a, b) in [((12, 3.5), (12, 5.5)), ((12, 18.5), (12, 20.5)), ((3.5, 12), (5.5, 12)), ((18.5, 12), (20.5, 12)),
                           ((6, 6), (7.4, 7.4)), ((16.6, 16.6), (18, 18)), ((6, 18), (7.4, 16.6)), ((16.6, 7.4), (18, 6))] as [((CGFloat, CGFloat), (CGFloat, CGFloat))] {
                line(a, b)
            }
        case .inbox:
            path.move(to: p(4, 13.5))
            path.addLine(to: p(6.5, 6))
            path.addLine(to: p(17.5, 6))
            path.addLine(to: p(20, 13.5))
            path.addLine(to: p(20, 18))
            path.addQuadCurve(to: p(18.5, 19.5), control: p(20, 19.5))
            path.addLine(to: p(5.5, 19.5))
            path.addQuadCurve(to: p(4, 18), control: p(4, 19.5))
            path.closeSubpath()
            line((4, 13.5), (8.5, 13.5), (9.7, 15.5), (14.3, 15.5), (15.5, 13.5), (20, 13.5))
        case .plus:
            line((12, 5), (12, 19))
            line((5, 12), (19, 12))
        case .chevron:
            line((10, 6), (16, 12), (10, 18))
        case .undo:
            line((9, 14.5), (4.5, 10), (9, 5.5))
            path.move(to: p(4.5, 10))
            path.addLine(to: p(14, 10))
            path.addArc(center: p(14, 15), radius: 5 * s, startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: false)
            path.addLine(to: p(11.5, 20))
        case .done:
            line((5, 12.5), (9.5, 17), (19, 7.5))
        case .notDone:
            line((7, 7), (17, 17))
            line((17, 7), (7, 17))
        case .partly:
            circle(12, 12, 7.5)
        case .noAnswer:
            // Dashed by the caller's stroke would dash everything, so the dashes are drawn as arcs.
            for i in 0..<9 {
                let start = Double(i) * 40
                path.addArc(center: p(12, 12), radius: 7.5 * s, startAngle: .degrees(start), endAngle: .degrees(start + 18), clockwise: false)
                path.move(to: p(12 + 7.5 * cos((start + 40) * .pi / 180), 12 + 7.5 * sin((start + 40) * .pi / 180)))
            }
        case .pause:
            line((8, 4), (8, 20))
            line((16, 4), (16, 20))
        case .live, .play:
            break
        }
        return path
    }
}

@available(iOS 17.0, macOS 14.0, *)
/// The filled part of an icon: the live dot, half of Partly, and the play sign.
struct IconFill: Shape {
    let name: IconName

    func path(in rect: CGRect) -> Path {
        let s = rect.width / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        switch name {
        case .live:
            path.addEllipse(in: CGRect(x: rect.minX + 7.5 * s, y: rect.minY + 7.5 * s, width: 9 * s, height: 9 * s))
        case .partly:
            path.move(to: p(12, 4.5))
            path.addArc(center: p(12, 12), radius: 7.5 * s, startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: true)
            path.closeSubpath()
        case .play:
            path.move(to: p(6, 3))
            path.addLine(to: p(21, 12))
            path.addLine(to: p(6, 21))
            path.closeSubpath()
        default:
            break
        }
        return path
    }
}
