import XCTest
@testable import Moviecal

@MainActor
final class MoviecalTests: XCTestCase {
    func testTrivialSmoke() {
        XCTAssertEqual(1 + 1, 2)
    }

    func testRootViewInstantiates() {
        let authStore = AuthStore(authClient: MockSupabaseAuthClient())
        let apiClient = APIClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.moviecal.test")!),
            tokenProvider: StubTokenProvider(),
            session: MockURLProtocol.makeSession()
        )
        let view = RootView(authStore: authStore, apiClient: apiClient)
        XCTAssertNotNil(view.body)
    }
}

private struct StubTokenProvider: AuthTokenProviding {
    func currentAccessToken() async throws -> String {
        "test-access-token"
    }
}
