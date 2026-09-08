import XCTest
@testable import Moviecal

final class MoviecalTests: XCTestCase {
    func testTrivialSmoke() {
        XCTAssertEqual(1 + 1, 2)
    }

    func testRootViewInstantiates() {
        let view = RootView()
        XCTAssertNotNil(view.body)
    }
}
