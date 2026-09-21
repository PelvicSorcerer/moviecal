import Auth
import XCTest
@testable import Moviecal

@MainActor
final class AuthStoreTests: XCTestCase {
    private var mockClient: MockSupabaseAuthClient!
    private var store: AuthStore!

    override func setUp() {
        super.setUp()
        mockClient = MockSupabaseAuthClient()
        store = AuthStore(authClient: mockClient)
    }

    override func tearDown() {
        mockClient = nil
        store = nil
        super.tearDown()
    }

    private func waitForState(
        _ expected: AuthState,
        timeout: TimeInterval = 1.0,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while store.state != expected && Date() < deadline {
            await Task.yield()
        }
        XCTAssertEqual(store.state, expected, file: file, line: line)
    }

    // MARK: - Initial state / observation

    func testInitialStateIsUnknownBeforeAnyAuthStateEvent() {
        XCTAssertEqual(store.state, .unknown)
    }

    func testNoStoredSessionOnLaunchTransitionsToSignedOut() async {
        mockClient.emit(.initialSession, session: nil)
        await waitForState(.signedOut)
    }

    func testStoredSessionOnLaunchTransitionsToSignedIn() async {
        let session = MockSupabaseAuthClient.makeSession(email: "returning-user@example.com")
        mockClient.emit(.initialSession, session: session)
        await waitForState(.signedIn(email: "returning-user@example.com"))
    }

    // MARK: - Sign in

    func testSignInSuccessTransitionsStateToSignedIn() async throws {
        let session = MockSupabaseAuthClient.makeSession(email: "new-user@example.com")
        mockClient.signInResult = .success(session)

        try await store.signIn(email: "new-user@example.com", password: "correct horse battery staple")

        XCTAssertEqual(mockClient.signInCallCount, 1)
        await waitForState(.signedIn(email: "new-user@example.com"))
    }

    func testSignInFailurePropagatesAndLeavesStateUnchanged() async {
        struct InvalidCredentials: Error, Equatable {}
        mockClient.signInResult = .failure(InvalidCredentials())

        do {
            try await store.signIn(email: "person@example.com", password: "wrong-password")
            XCTFail("Expected sign-in to throw")
        } catch is InvalidCredentials {
            // expected
        } catch {
            XCTFail("Expected InvalidCredentials, got \(error)")
        }

        XCTAssertEqual(store.state, .unknown, "a failed sign-in must not be reported as signed in")
    }

    // MARK: - Sign out

    func testSignOutClearsSessionAndTransitionsToSignedOut() async throws {
        let session = MockSupabaseAuthClient.makeSession()
        mockClient.emit(.initialSession, session: session)
        await waitForState(.signedIn(email: "person@example.com"))

        try await store.signOut()

        XCTAssertEqual(mockClient.signOutCallCount, 1)
        await waitForState(.signedOut)
    }

    func testSignOutFailurePropagatesAndLeavesSessionSignedIn() async {
        struct TransportFailure: Error, Equatable {}
        let session = MockSupabaseAuthClient.makeSession()
        mockClient.emit(.initialSession, session: session)
        mockClient.signOutError = TransportFailure()

        await waitForState(.signedIn(email: "person@example.com"))

        do {
            try await store.signOut()
            XCTFail("Expected sign-out to throw")
        } catch is TransportFailure {
            // expected
        } catch {
            XCTFail("Expected TransportFailure, got \(error)")
        }

        XCTAssertEqual(store.state, .signedIn(email: "person@example.com"))
    }
}
