import WidgetCore
import WidgetTestSupport
import XCTest

/// What the medium widget's buttons do when tapped, through the same code their App Intents run, on a folder standing in
/// for the App Group.
final class TapTests: XCTestCase {
    private var files: WidgetFiles!
    private let t = Fixtures.instant

    override func setUpWithError() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("widget-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        files = WidgetFiles(root: root)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: files.root)
    }

    private func write(_ name: String) throws {
        try files.writeSnapshot(Fixtures.data("snapshots/\(name).json"))
    }

    private func drawn(at time: String) -> WidgetState {
        let (loaded, shares) = files.load()
        return WidgetState(loaded, shares: shares, at: t(time))
    }

    func testStartQueuesTheTapAndTheWidgetShowsItStartedAtOnceWithUndo() throws {
        try write("start")
        XCTAssertTrue(try WidgetTap.perform(.start(blockId: "spec"), files: files, at: t("2026-11-18T17:06:12Z").addingTimeInterval(0.7)))
        let queued = files.actions.pending()
        XCTAssertEqual(queued.count, 1)
        let action = queued[0]
        XCTAssertEqual(action.kind, .start)
        XCTAssertEqual(action.blockId, "spec")
        XCTAssertEqual(action.rev, Fixtures.snapshot("start").block("spec")!.rev)
        XCTAssertEqual(action.at, t("2026-11-18T17:06:12Z"), "to the whole second")
        XCTAssertNil(action.target)
        XCTAssertTrue(WidgetAction.isFileName(action.id))
        let s = drawn(at: "2026-11-18T17:06:13Z")
        XCTAssertEqual(s.mode, .now)
        XCTAssertEqual(s.button, .undo(actionId: action.id, blockId: "spec", early: false))
    }

    func testUndoBeforeTheAppAppliesTheStartTakesItOffTheQueue() throws {
        try write("start")
        try WidgetTap.perform(.start(blockId: "spec"), files: files, at: t("2026-11-18T17:06:00Z"))
        let start = files.actions.pending()[0]
        XCTAssertTrue(try WidgetTap.perform(.undo(actionId: start.id, blockId: "spec", early: false), files: files, at: t("2026-11-18T17:07:00Z")))
        XCTAssertEqual(files.actions.pending(), [])
        XCTAssertEqual(drawn(at: "2026-11-18T17:07:01Z").button, .start(blockId: "spec"))
    }

    func testUndoAfterTheAppAppliedTheStartQueuesAnUndoForIt() throws {
        // As the app writes the snapshot once it has applied a start: started, with the start still offered to undo.
        var s = Fixtures.snapshot("start")
        let started = WidgetAction(v: 1, id: "1795107960000-6F9619FF-8B86-4011-B42D-00C04FC96401.json", kind: .start, blockId: "spec", rev: "x", at: t("2026-11-18T17:06:00Z"), target: nil)
        s = s.applying([started])
        try files.writeSnapshot(WidgetJSON.encoder.encode(s))
        XCTAssertTrue(try WidgetTap.perform(.undo(actionId: started.id, blockId: "spec", early: false), files: files, at: t("2026-11-18T17:08:00Z")))
        let undo = files.actions.pending()
        XCTAssertEqual(undo.map(\.kind), [.undo])
        XCTAssertEqual(undo[0].target, started.id)
        XCTAssertEqual(drawn(at: "2026-11-18T17:08:01Z").mode, .start)
    }

    func testStartEarlyMovesTheNextBlockToNowInTheWidgetAtOnce() throws {
        try write("next")
        try WidgetTap.perform(.startEarly(blockId: "dentist"), files: files, at: t("2026-11-18T18:48:30Z"))
        let s = drawn(at: "2026-11-18T18:48:31Z")
        XCTAssertEqual(s.mode, .now)
        XCTAssertEqual(s.current?.id, "dentist")
        XCTAssertEqual(s.current?.start, t("2026-11-18T18:48:00Z"))
        XCTAssertEqual(s.current?.end, t("2026-11-18T19:03:00Z"))
        XCTAssertEqual(s.button, .undo(actionId: files.actions.pending()[0].id, blockId: "dentist", early: true))
    }

    func testPauseAndResumeUndoEachOther() throws {
        try write("now")
        try WidgetTap.perform(.pause(blockId: "spec"), files: files, at: t("2026-11-18T18:04:00Z"))
        XCTAssertEqual(drawn(at: "2026-11-18T18:04:01Z").button, .resume(blockId: "spec"))
        try WidgetTap.perform(.resume(blockId: "spec"), files: files, at: t("2026-11-18T18:04:10Z"))
        let s = drawn(at: "2026-11-18T18:04:11Z")
        XCTAssertEqual(s.button, .pause(blockId: "spec"))
        XCTAssertEqual(s.current?.end, t("2026-11-18T18:30:00Z"), "a pause under 30 seconds moves nothing")
        XCTAssertEqual(files.actions.pending().map(\.kind), [.pause, .resume])
    }

    func testATapOnAButtonThatNoLongerFitsChangesNothing() throws {
        try write("start")
        XCTAssertFalse(try WidgetTap.perform(.start(blockId: "spec"), files: files, at: t("2026-11-18T18:31:00Z")))
        XCTAssertFalse(try WidgetTap.perform(.pause(blockId: "spec"), files: files, at: t("2026-11-18T17:06:00Z")))
        XCTAssertFalse(try WidgetTap.perform(.undo(actionId: "1795107960000-6F9619FF-8B86-4011-B42D-00C04FC96401.json", blockId: "spec", early: false), files: files, at: t("2026-11-18T17:06:00Z")))
        try write("signedout")
        XCTAssertFalse(try WidgetTap.perform(.start(blockId: "spec"), files: files, at: t("2026-11-18T17:06:00Z")))
        XCTAssertEqual(files.actions.pending(), [])
    }

    func testTwoQuickTapsQueueOnceAsTheWidgetHasMovedOn() throws {
        try write("start")
        try WidgetTap.perform(.start(blockId: "spec"), files: files, at: t("2026-11-18T17:06:00Z"))
        XCTAssertFalse(try WidgetTap.perform(.start(blockId: "spec"), files: files, at: t("2026-11-18T17:06:00Z").addingTimeInterval(0.2)))
        XCTAssertEqual(files.actions.pending().count, 1)
    }
}

/// The App Group's files, as the app and the widgets share them.
final class StoreTests: XCTestCase {
    private var files: WidgetFiles!

    override func setUpWithError() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("widget-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        files = WidgetFiles(root: root)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: files.root)
    }

    func testTheSnapshotRoundTripsAndIsKeptOutOfBackups() throws {
        try files.writeSnapshot(Fixtures.data("snapshots/now.json"))
        XCTAssertEqual(files.readSnapshot(), Fixtures.loaded("now"))
        let values = try files.snapshotURL.deletingLastPathComponent().resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }

    func testOnlyASnapshotAWidgetCanReadIsSaved() {
        XCTAssertThrowsError(try files.writeSnapshot(Data("{\"v\":1}".utf8)))
        XCTAssertThrowsError(try files.writeSnapshot(Data(repeating: 32, count: Snapshot.maxBytes + 1)))
        XCTAssertThrowsError(try files.writeSnapshot(Fixtures.data("snapshots/newer.json")))
        XCTAssertEqual(files.readSnapshot(), .missing)
    }

    func testClearTakesTheSnapshotAndTheQueue() throws {
        try files.writeSnapshot(Fixtures.data("snapshots/now.json"))
        try files.actions.enqueue(.pause, blockId: "spec", rev: "x", at: Date())
        files.clear()
        XCTAssertEqual(files.readSnapshot(), .missing)
        XCTAssertEqual(files.actions.items().count, 0)
    }

    func testTheQueueReadsOnlyItsOwnFilesInTheOrderOfTheTaps() throws {
        let queue = files.actions
        let later = try queue.enqueue(.resume, blockId: "spec", rev: "x", at: Date(timeIntervalSince1970: 1_795_000_100))
        let earlier = try queue.enqueue(.pause, blockId: "spec", rev: "x", at: Date(timeIntervalSince1970: 1_795_000_000))
        try Data("x".utf8).write(to: queue.folder.appendingPathComponent("notes.txt"))
        try Data("{".utf8).write(to: queue.folder.appendingPathComponent("1795000200000-6F9619FF-8B86-4011-B42D-00C04FC96499.json"))
        XCTAssertEqual(queue.items().map(\.id), [earlier.id, later.id, "1795000200000-6F9619FF-8B86-4011-B42D-00C04FC96499.json"])
        XCTAssertEqual(queue.pending(), [earlier, later], "the unreadable one is left for the app to drop")
        XCTAssertFalse(queue.remove("../notes.txt"))
        XCTAssertFalse(queue.remove("notes.txt"))
        XCTAssertTrue(queue.remove(earlier.id))
        XCTAssertFalse(queue.remove(earlier.id))
    }

    func testWaitingSharesAddToTheInbox() throws {
        let shares = files.root.appendingPathComponent("share-queue")
        try FileManager.default.createDirectory(at: shares, withIntermediateDirectories: true)
        for name in ["1-a.txt", "2-b.txt", ".txt", "x.json"] { try Data("x".utf8).write(to: shares.appendingPathComponent(name)) }
        try files.writeSnapshot(Fixtures.data("snapshots/inbox.json"))
        let (loaded, waiting) = files.load()
        XCTAssertEqual(waiting, 2)
        XCTAssertEqual(WidgetState(loaded, shares: waiting, at: Fixtures.moment("inbox")).inbox, 6)
    }
}
