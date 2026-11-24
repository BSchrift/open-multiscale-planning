import Capacitor
import MetricKit
import UIKit

/// What drains the battery, for telemetry (docs/performance.md, Battery): the battery's state each minute, and MetricKit's
/// reports, which iOS delivers about once a day after the day they cover. Each report becomes plain seconds and bytes
/// here, from MetricKit's typed measurements, so the numbers don't depend on the phone's region. Reports are kept until
/// the page takes them, since one can arrive before the page loads, or in a run that ends before telemetry sends it.
@objc(MultiscaleEnergyPlugin)
class EnergyPlugin: CAPPlugin, CAPBridgedPlugin, MXMetricManagerSubscriber {
    let identifier = "MultiscaleEnergyPlugin"
    let jsName = "MultiscaleEnergy"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sample", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reports", returnType: CAPPluginReturnPromise),
    ]
    private static let key = "multiscale.energy.reports"
    /// About a month of days, so a phone that never gets to send holds only so much.
    private static let kept = 31

    override func load() {
        MXMetricManager.shared.add(self)
    }

    deinit {
        MXMetricManager.shared.remove(self)
    }

    /// Plugged in or not, Low Power Mode, and how hot the phone runs. Battery monitoring is on only while it's read.
    @objc func sample(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let device = UIDevice.current
            device.isBatteryMonitoringEnabled = true
            let battery = device.batteryState
            device.isBatteryMonitoringEnabled = false
            let thermal: String
            switch ProcessInfo.processInfo.thermalState {
            case .nominal: thermal = "nominal"
            case .fair: thermal = "fair"
            case .serious: thermal = "serious"
            case .critical: thermal = "critical"
            @unknown default: thermal = "unknown"
            }
            var power: [String: Any] = ["lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled, "thermal": thermal]
            // The Simulator has no battery.
            if battery != .unknown { power["charging"] = battery == .charging || battery == .full }
            call.resolve(["power": power])
        }
    }

    /// The reports kept since the last call, which this hands over and forgets.
    @objc func reports(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let held = Self.heldReports()
            UserDefaults.standard.removeObject(forKey: Self.key)
            call.resolve(held)
        }
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        let days = payloads.map(Self.day)
        DispatchQueue.main.async { Self.store(daily: days) }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let exceptions = payloads.flatMap(Self.exceptions)
        DispatchQueue.main.async { Self.store(exceptions: exceptions) }
    }

    /// Adds reports to those kept, on the main thread, where reports() takes them.
    static func store(daily: [[String: Any]] = [], exceptions: [[String: Any]] = []) {
        var held = heldReports()
        held["daily"] = Array((((held["daily"] as? [[String: Any]]) ?? []) + daily).suffix(kept))
        held["exceptions"] = Array((((held["exceptions"] as? [[String: Any]]) ?? []) + exceptions).suffix(kept))
        // JSONSerialization raises rather than throws on what JSON can't hold, such as a NaN.
        guard JSONSerialization.isValidJSONObject(held), let data = try? JSONSerialization.data(withJSONObject: held) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    private static func heldReports() -> [String: Any] {
        let data = UserDefaults.standard.data(forKey: key)
        let held = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        return ["daily": held["daily"] ?? [Any](), "exceptions": held["exceptions"] ?? [Any]()]
    }

    private static func seconds(_ value: Measurement<UnitDuration>) -> Double { value.converted(to: .seconds).value }
    private static func bytes(_ value: Measurement<UnitInformationStorage>) -> Double { value.converted(to: .bytes).value }

    /// One day's totals. Hangs come as a histogram, so their time is each bucket's middle times its count.
    static func day(_ payload: MXMetricPayload) -> [String: Any] {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(identifier: "UTC")
        format.dateFormat = "yyyy-MM-dd"
        var day: [String: Any] = ["day": format.string(from: payload.timeStampBegin)]
        if let cpu = payload.cpuMetrics { day["cpuSeconds"] = seconds(cpu.cumulativeCPUTime) }
        if let gpu = payload.gpuMetrics { day["gpuSeconds"] = seconds(gpu.cumulativeGPUTime) }
        if let network = payload.networkTransferMetrics {
            day["cellularBytes"] = bytes(network.cumulativeCellularDownload) + bytes(network.cumulativeCellularUpload)
            day["wifiBytes"] = bytes(network.cumulativeWifiDownload) + bytes(network.cumulativeWifiUpload)
        }
        if let time = payload.applicationTimeMetrics {
            day["foregroundSeconds"] = seconds(time.cumulativeForegroundTime)
            day["backgroundSeconds"] = seconds(time.cumulativeBackgroundTime)
        }
        if let hangs = payload.applicationResponsivenessMetrics?.histogrammedApplicationHangTime {
            var total = 0.0
            for case let bucket as MXHistogramBucket<UnitDuration> in hangs.bucketEnumerator {
                total += Double(bucket.bucketCount) * (seconds(bucket.bucketStart) + seconds(bucket.bucketEnd)) / 2
            }
            day["hangSeconds"] = total
        }
        return day
    }

    /// MetricKit's JSON of a call stack tree, of which the page reads only the top frame's binary and offset.
    private static func tree(_ stacks: MXCallStackTree) -> Any {
        (try? JSONSerialization.jsonObject(with: stacks.jsonRepresentation())) ?? [String: Any]()
    }

    /// iOS stopping the app for too much CPU in the background, or for writing too much to disk.
    static func exceptions(_ payload: MXDiagnosticPayload) -> [[String: Any]] {
        let cpu: [[String: Any]] = (payload.cpuExceptionDiagnostics ?? []).map {
            ["kind": "cpu", "cpuSeconds": seconds($0.totalCPUTime), "callStackTree": tree($0.callStackTree)]
        }
        let disk: [[String: Any]] = (payload.diskWriteExceptionDiagnostics ?? []).map {
            ["kind": "disk", "diskBytes": bytes($0.totalWritesCaused), "callStackTree": tree($0.callStackTree)]
        }
        return cpu + disk
    }
}
