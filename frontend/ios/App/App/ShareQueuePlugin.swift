import Capacitor

@objc(MultiscaleShareQueuePlugin)
class ShareQueuePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MultiscaleShareQueuePlugin"
    let jsName = "MultiscaleShareQueue"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "peek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    @objc func status(_ call: CAPPluginCall) {
        let enabled = Bundle.main.object(forInfoDictionaryKey: "MultiscaleExtensions") as? String == "YES"
        call.resolve(["enabled": enabled])
    }

    @objc func peek(_ call: CAPPluginCall) {
        call.resolve(["items": ShareQueue.peek().map { ["id": $0.id, "text": $0.text] }])
    }

    @objc func remove(_ call: CAPPluginCall) {
        ShareQueue.remove(call.getArray("ids", String.self) ?? [])
        call.resolve()
    }
}
