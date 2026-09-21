import XCTest

/// Exercises the required sign-in → main-tabs happy path end to end
/// against the real app process. `-UITestMockAuth` swaps in
/// `UITestFakeSupabaseAuthClient` (Debug-only, see `MoviecalApp`) so the
/// test is deterministic and needs no live Supabase project.
final class SignInToMainTabsUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSignInTransitionsToMainTabs() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-UITestMockAuth"]
        app.launch()

        let emailField = app.textFields["signIn.email"]
        XCTAssertTrue(emailField.waitForExistence(timeout: 5))
        emailField.tap()
        emailField.typeText("person@example.com")

        let passwordField = app.secureTextFields["signIn.password"]
        XCTAssertTrue(passwordField.exists)
        passwordField.tap()
        passwordField.typeText("correct horse battery staple")

        app.buttons["signIn.submit"].tap()

        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.buttons["Search"].waitForExistence(timeout: 5))
        XCTAssertTrue(tabBar.buttons["Watchlist"].exists)
        XCTAssertTrue(tabBar.buttons["Settings"].exists)
    }
}
