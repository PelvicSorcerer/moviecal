import SwiftUI
import UIKit
import XCTest

/// Minimal, dependency-free reference-image snapshot assertion for the
/// stable app-shell screens. Renders `view` inside a real, laid-out
/// `UIHostingController`/`UIWindow` (so `NavigationStack`/`Form`/`List`
/// chrome sizes the same way it would on-screen), then compares the PNG
/// bytes against a reference file checked in under
/// `MoviecalTests/Snapshots/__Snapshots__/<name>.png`.
///
/// A missing reference normally fails the test — it also writes the
/// rendered PNG next to where the reference belongs, so a maintainer can
/// review and commit it, then rerun to confirm the recorded image matches
/// — the same record-then-compare convention every snapshot-testing tool
/// uses, just without a third-party dependency. Set `SNAPSHOT_RECORD=1` in
/// the test run's environment to record new/updated references without
/// failing, for the one-time bootstrap pass and for deliberate updates.
@MainActor
func assertSnapshot<V: View>(
    of view: V,
    named name: String,
    size: CGSize = CGSize(width: 390, height: 844),
    file: StaticString = #filePath,
    line: UInt = #line
) {
    guard let pngData = renderPNG(of: view, size: size) else {
        XCTFail("Failed to render a snapshot image for \(name)", file: file, line: line)
        return
    }

    let isRecording = ProcessInfo.processInfo.environment["SNAPSHOT_RECORD"] == "1"
    let referenceURL = snapshotDirectory().appendingPathComponent("\(name).png")
    let referenceData = try? Data(contentsOf: referenceURL)

    if isRecording || referenceData == nil {
        try? FileManager.default.createDirectory(
            at: snapshotDirectory(),
            withIntermediateDirectories: true
        )
        try? pngData.write(to: referenceURL)
    }

    guard let referenceData else {
        XCTFail(
            "No reference snapshot for \"\(name)\" — recorded a new one at \(referenceURL.path). "
                + "Review it, commit it, then rerun to verify.",
            file: file,
            line: line
        )
        return
    }

    if isRecording { return }

    XCTAssertEqual(
        pngData,
        referenceData,
        "\"\(name)\" does not match its reference snapshot at \(referenceURL.path)",
        file: file,
        line: line
    )
}

@MainActor
private func renderPNG<V: View>(of view: V, size: CGSize) -> Data? {
    let controller = UIHostingController(rootView: view)
    controller.view.frame = CGRect(origin: .zero, size: size)
    controller.view.backgroundColor = .systemBackground

    let window = UIWindow(frame: CGRect(origin: .zero, size: size))
    window.rootViewController = controller
    window.isHidden = false
    window.layoutIfNeeded()
    controller.view.layoutIfNeeded()

    let renderer = UIGraphicsImageRenderer(size: size)
    let image = renderer.image { _ in
        controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
    }
    return image.pngData()
}

private func snapshotDirectory() -> URL {
    URL(fileURLWithPath: "\(#filePath)")
        .deletingLastPathComponent()
        .appendingPathComponent("__Snapshots__")
}
