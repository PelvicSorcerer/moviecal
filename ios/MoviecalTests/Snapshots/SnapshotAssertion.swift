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

    if pngData == referenceData { return }

    guard let difference = imageDifference(renderedPNG: pngData, referencePNG: referenceData) else {
        return XCTFail(
            "\"\(name)\" could not be decoded for comparison at \(referenceURL.path)",
            file: file,
            line: line
        )
    }

    // PNG bytes can vary slightly between otherwise identical simulator
    // renders. Compare decoded pixels instead, allowing a tiny amount of
    // antialiasing noise while still catching a visible screen regression.
    XCTAssertLessThanOrEqual(
        difference,
        0.002,
        "\"\(name)\" differs from its reference by \(difference * 100)% of pixels at \(referenceURL.path)",
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

@MainActor
private func imageDifference(renderedPNG: Data, referencePNG: Data) -> Double? {
    guard
        let rendered = UIImage(data: renderedPNG)?.cgImage,
        let reference = UIImage(data: referencePNG)?.cgImage,
        rendered.width == reference.width,
        rendered.height == reference.height
    else {
        return nil
    }

    guard
        let renderedPixels = rgbaPixels(for: rendered),
        let referencePixels = rgbaPixels(for: reference)
    else {
        return nil
    }

    var changedPixels = 0
    for offset in stride(from: 0, to: renderedPixels.count, by: 4) {
        let maximumChannelDifference = (0..<3).map { channel in
            abs(Int(renderedPixels[offset + channel]) - Int(referencePixels[offset + channel]))
        }.max() ?? 0

        if maximumChannelDifference > 2 {
            changedPixels += 1
        }
    }

    return Double(changedPixels) / Double(rendered.width * rendered.height)
}

@MainActor
private func rgbaPixels(for image: CGImage) -> [UInt8]? {
    let bytesPerRow = image.width * 4
    var pixels = [UInt8](repeating: 0, count: bytesPerRow * image.height)
    guard let context = CGContext(
        data: &pixels,
        width: image.width,
        height: image.height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return nil
    }

    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return pixels
}
