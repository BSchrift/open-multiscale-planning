import Foundation

/// A folder in the App Group: the share extension adds a file per share, and the app imports them when it next opens.
enum ShareQueue {
    private static let maxLength = 10_000

    private static var folder: URL? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "MultiscaleAppGroup") as? String else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
            .appendingPathComponent("share-queue", isDirectory: true)
    }

    static func add(_ text: String) throws {
        guard let folder else { throw CocoaError(.fileWriteNoPermission) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Named by time so the app imports in the order things were shared. Atomic so it never reads half a file.
        let name = "\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString).txt"
        try String(text.prefix(maxLength)).write(to: folder.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    /// What's queued, oldest first, by file name. It stays until the app has saved it and calls remove.
    static func peek() -> [(id: String, text: String)] {
        guard let folder, let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return [] }
        return names.filter { $0.hasSuffix(".txt") }.sorted().compactMap { name in
            guard let text = try? String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8) else { return nil }
            return (id: name, text: text)
        }
    }

    /// Takes saved items off the queue. Only queue files by name, never a path elsewhere.
    static func remove(_ ids: [String]) {
        guard let folder else { return }
        for id in ids where id.hasSuffix(".txt") && !id.contains("/") && id != ".txt" {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(id))
        }
    }
}
