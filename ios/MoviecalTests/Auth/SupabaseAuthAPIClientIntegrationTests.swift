import XCTest
@testable import Moviecal

/// Proves `SupabaseAuthTokenProvider` plugs into `APIClient` as its
/// `AuthTokenProviding`, and that an auth failure reaches the API client
/// without a network call — the "access token is provided to the API
/// client" and "no silent refresh" acceptance criteria, exercised across the
/// module boundary rather than through either type in isolation.
final class SupabaseAuthAPIClientIntegrationTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testAPIClientSendsTheSupabaseAccessTokenAsTheBearerToken() async throws {
        let mockAuthClient = MockSupabaseAuthClient()
        mockAuthClient.sessionResult = .success(
            MockSupabaseAuthClient.makeSession(accessToken: "supabase-access-token")
        )
        let apiClient = APIClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.moviecal.test")!),
            tokenProvider: SupabaseAuthTokenProvider(authClient: mockAuthClient),
            session: MockURLProtocol.makeSession()
        )

        var capturedRequest: URLRequest?
        let json = #"{ "items": [] }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, json)
        }

        _ = try await apiClient.fetchWatchlist()

        XCTAssertEqual(
            capturedRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer supabase-access-token"
        )
    }

    func testNoValidSupabaseSessionFailsBeforeAnyNetworkCall() async {
        struct SessionMissing: Error {}
        let mockAuthClient = MockSupabaseAuthClient()
        mockAuthClient.sessionResult = .failure(SessionMissing())
        let apiClient = APIClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.moviecal.test")!),
            tokenProvider: SupabaseAuthTokenProvider(authClient: mockAuthClient),
            session: MockURLProtocol.makeSession()
        )

        var requestMade = false
        MockURLProtocol.requestHandler = { request in
            requestMade = true
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: nil
            )!
            return (response, Data())
        }

        do {
            _ = try await apiClient.fetchWatchlist()
            XCTFail("Expected the missing-session error to propagate")
        } catch is SessionMissing {
            // expected
        } catch {
            XCTFail("Expected SessionMissing, got \(error)")
        }

        XCTAssertFalse(requestMade, "an invalid Supabase session must surface re-authentication, not an unauthenticated request")
    }
}
