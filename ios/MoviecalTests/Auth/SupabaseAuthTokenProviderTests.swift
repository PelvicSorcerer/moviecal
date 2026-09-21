import Auth
import XCTest
@testable import Moviecal

final class SupabaseAuthTokenProviderTests: XCTestCase {
    func testCurrentAccessTokenReturnsTheSessionsAccessToken() async throws {
        let mockClient = MockSupabaseAuthClient()
        mockClient.sessionResult = .success(
            MockSupabaseAuthClient.makeSession(accessToken: "live-access-token")
        )
        let provider = SupabaseAuthTokenProvider(authClient: mockClient)

        let token = try await provider.currentAccessToken()

        XCTAssertEqual(token, "live-access-token")
        XCTAssertEqual(mockClient.sessionCallCount, 1)
    }

    func testExpiredSessionWithNoValidRefreshTokenThrowsInsteadOfReturningAToken() async {
        struct SessionMissing: Error, Equatable {}
        let mockClient = MockSupabaseAuthClient()
        mockClient.sessionResult = .failure(SessionMissing())
        let provider = SupabaseAuthTokenProvider(authClient: mockClient)

        do {
            _ = try await provider.currentAccessToken()
            XCTFail("Expected currentAccessToken to throw when no valid session exists")
        } catch is SessionMissing {
            // expected: the caller must surface this as a need to re-authenticate,
            // not receive a stale/empty token.
        } catch {
            XCTFail("Expected SessionMissing, got \(error)")
        }
    }

    func testEachCallAsksTheAuthClientForAFreshSessionRatherThanCaching() async throws {
        let mockClient = MockSupabaseAuthClient()
        mockClient.sessionResult = .success(MockSupabaseAuthClient.makeSession(accessToken: "token-1"))
        let provider = SupabaseAuthTokenProvider(authClient: mockClient)

        _ = try await provider.currentAccessToken()

        mockClient.sessionResult = .success(MockSupabaseAuthClient.makeSession(accessToken: "token-2"))
        let secondToken = try await provider.currentAccessToken()

        XCTAssertEqual(secondToken, "token-2")
        XCTAssertEqual(mockClient.sessionCallCount, 2, "the v1 layer relies on the auth client to hand back a valid token on every call")
    }
}
