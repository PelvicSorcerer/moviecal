import XCTest

/// Exercises the required sign-in → main-tabs happy path end to end
/// against the real app process. `-UITestMockAuth` swaps in
/// `UITestFakeSupabaseAuthClient` (Debug-only, see `MoviecalApp`) so the
/// test is deterministic and needs no live Supabase project.
final class SignInToMainTabsUITests: XCTestCase {
    /// These waits resolve in about a second on an idle machine. They are set
    /// far above that because the CI runner is an 8 GB Mac that is routinely
    /// swapping, where the simulator can take tens of seconds to render a
    /// view. The timeout only bounds a hang, so a generous value costs nothing
    /// on a healthy run and prevents a false red on a slow one (MOV-313).
    private static let elementWaitTimeout: TimeInterval = 45

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSignInTransitionsToMainTabs() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-UITestMockAuth"]
        app.launch()

        let emailField = app.textFields["signIn.email"]
        XCTAssertTrue(emailField.waitForExistence(timeout: Self.elementWaitTimeout))
        emailField.tap()
        emailField.typeText("person@example.com")

        let passwordField = app.secureTextFields["signIn.password"]
        XCTAssertTrue(passwordField.exists)
        passwordField.tap()
        passwordField.typeText("correct horse battery staple")

        app.buttons["signIn.submit"].tap()

        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.buttons["Search"].waitForExistence(timeout: Self.elementWaitTimeout))
        XCTAssertTrue(tabBar.buttons["Watchlist"].exists)
        XCTAssertTrue(tabBar.buttons["Settings"].exists)
    }
}

#error("MOV-302 disposable fixture: expected lane-ios failure")
