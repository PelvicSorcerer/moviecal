import XCTest
@testable import Moviecal

private struct StubTokenProvider: AuthTokenProviding {
    let token: String

    func currentAccessToken() async throws -> String {
        token
    }
}

private struct FailingTokenProvider: AuthTokenProviding {
    struct Failure: Error, Equatable {}

    func currentAccessToken() async throws -> String {
        throw Failure()
    }
}

final class APIClientTests: XCTestCase {
    private var client: APIClient!
    private var baseURL: URL!

    override func setUp() {
        super.setUp()
        baseURL = URL(string: "https://api.moviecal.test")!
        client = APIClient(
            environment: APIEnvironment(baseURL: baseURL),
            tokenProvider: StubTokenProvider(token: "test-access-token"),
            session: MockURLProtocol.makeSession()
        )
    }

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        client = nil
        baseURL = nil
        super.tearDown()
    }

    private func jsonResponse(statusCode: Int, url: URL, body: Data) -> HTTPURLResponse {
        HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
    }

    // MARK: - Success cases

    func testFetchWatchlistDecodesItemsAndSendsBearerToken() async throws {
        let json = """
        {
          "items": [
            {
              "id": "watchlist-item-1",
              "addedAt": "2026-06-13T05:00:00.000Z",
              "movie": {
                "id": 42,
                "tmdbId": 603,
                "title": "The Matrix",
                "releaseDate": "1999-03-31",
                "posterPath": "/matrix.jpg",
                "overview": "A hacker discovers the truth."
              }
            }
          ]
        }
        """.data(using: .utf8)!

        var capturedRequest: URLRequest?
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            return (self.jsonResponse(statusCode: 200, url: request.url!, body: json), json)
        }

        let items = try await client.fetchWatchlist()

        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].id, "watchlist-item-1")
        XCTAssertEqual(items[0].addedAt, "2026-06-13T05:00:00.000Z")
        XCTAssertEqual(items[0].movie, Movie(
            id: 42,
            tmdbId: 603,
            title: "The Matrix",
            releaseDate: "1999-03-31",
            posterPath: "/matrix.jpg",
            overview: "A hacker discovers the truth."
        ))

        XCTAssertEqual(capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(capturedRequest?.url?.path, "/api/v1/watchlist")
        XCTAssertEqual(capturedRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer test-access-token")
    }

    func testAddWatchlistItemEncodesBodyAndDecodesItem() async throws {
        let json = """
        {
          "item": {
            "id": "watchlist-item-2",
            "addedAt": "2026-06-14T05:00:00.000Z",
            "movie": {
              "id": 43,
              "tmdbId": 604,
              "title": "The Matrix Reloaded",
              "releaseDate": "2003-05-15",
              "posterPath": null,
              "overview": null
            }
          }
        }
        """.data(using: .utf8)!

        var capturedRequest: URLRequest?
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            return (self.jsonResponse(statusCode: 201, url: request.url!, body: json), json)
        }

        let item = try await client.addWatchlistItem(tmdbId: 604)

        XCTAssertEqual(item.id, "watchlist-item-2")
        XCTAssertNil(item.movie.posterPath)
        XCTAssertNil(item.movie.overview)

        XCTAssertEqual(capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(capturedRequest?.value(forHTTPHeaderField: "Content-Type"), "application/json")

        let sentBody = try XCTUnwrap(capturedRequest?.httpBodyStreamData() ?? capturedRequest?.httpBody)
        let decoded = try JSONSerialization.jsonObject(with: sentBody) as? [String: Any]
        XCTAssertEqual(decoded?["tmdbId"] as? Int, 604)
    }

    func testRemoveWatchlistItemSendsExpectedBodyAndSucceedsOn204() async throws {
        var capturedRequest: URLRequest?
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            return (self.jsonResponse(statusCode: 204, url: request.url!, body: Data()), Data())
        }

        try await client.removeWatchlistItem(watchlistItemId: "watchlist-item-1")

        XCTAssertEqual(capturedRequest?.httpMethod, "DELETE")
        let sentBody = try XCTUnwrap(capturedRequest?.httpBodyStreamData() ?? capturedRequest?.httpBody)
        let decoded = try JSONSerialization.jsonObject(with: sentBody) as? [String: Any]
        XCTAssertEqual(decoded?["watchlistItemId"] as? String, "watchlist-item-1")
    }

    func testSearchMoviesEncodesQueryAndDecodesResults() async throws {
        let json = """
        {
          "results": [
            {
              "tmdbId": 603,
              "title": "The Matrix",
              "releaseDate": "1999-03-31",
              "posterPath": "/matrix.jpg",
              "overview": "A hacker discovers the truth."
            }
          ]
        }
        """.data(using: .utf8)!

        var capturedRequest: URLRequest?
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            return (self.jsonResponse(statusCode: 200, url: request.url!, body: json), json)
        }

        let results = try await client.searchMovies(query: "the matrix")

        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].tmdbId, 603)
        XCTAssertEqual(results[0].id, 603)

        let components = try XCTUnwrap(capturedRequest?.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) })
        XCTAssertEqual(components.path, "/api/v1/movies/search")
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "q", value: "the matrix")])
    }

    func testFetchCalendarSubscriptionURLDecodesURL() async throws {
        let json = """
        { "subscriptionUrl": "https://moviecal.example/api/calendar/AbC123" }
        """.data(using: .utf8)!

        MockURLProtocol.requestHandler = { request in
            (self.jsonResponse(statusCode: 200, url: request.url!, body: json), json)
        }

        let url = try await client.fetchCalendarSubscriptionURL()

        XCTAssertEqual(url, URL(string: "https://moviecal.example/api/calendar/AbC123"))
    }

    func testRotateCalendarSubscriptionURLUsesPOSTAndDecodesNewURL() async throws {
        let json = """
        { "subscriptionUrl": "https://moviecal.example/api/calendar/NewToken" }
        """.data(using: .utf8)!

        var capturedRequest: URLRequest?
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            return (self.jsonResponse(statusCode: 200, url: request.url!, body: json), json)
        }

        let url = try await client.rotateCalendarSubscriptionURL()

        XCTAssertEqual(url, URL(string: "https://moviecal.example/api/calendar/NewToken"))
        XCTAssertEqual(capturedRequest?.httpMethod, "POST")
    }

    // MARK: - Error mapping

    func testUnauthorizedSurfacesDistinctAuthExpiredErrorWithoutRetry() async throws {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            let body = #"{ "error": "Unauthorized." }"#.data(using: .utf8)!
            return (self.jsonResponse(statusCode: 401, url: request.url!, body: body), body)
        }

        do {
            _ = try await client.fetchWatchlist()
            XCTFail("Expected authenticationExpired to be thrown")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .authenticationExpired)
        }

        XCTAssertEqual(requestCount, 1, "the client must not silently retry after a 401")
    }

    func testBadRequestMapsToInvalidRequestWithServerMessage() async throws {
        let body = #"{ "error": "tmdbId is required." }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            (self.jsonResponse(statusCode: 400, url: request.url!, body: body), body)
        }

        do {
            _ = try await client.addWatchlistItem(tmdbId: 0)
            XCTFail("Expected invalidRequest to be thrown")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .invalidRequest(message: "tmdbId is required."))
        }
    }

    func testForbiddenMapsToAccessDenied() async throws {
        let body = #"{ "error": "Access denied." }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            (self.jsonResponse(statusCode: 403, url: request.url!, body: body), body)
        }

        do {
            _ = try await client.fetchWatchlist()
            XCTFail("Expected accessDenied to be thrown")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .accessDenied(message: "Access denied."))
        }
    }

    func testNotFoundMapsToNotFound() async throws {
        let body = #"{ "error": "Watchlist item not found." }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            (self.jsonResponse(statusCode: 404, url: request.url!, body: body), body)
        }

        do {
            try await client.removeWatchlistItem(watchlistItemId: "missing")
            XCTFail("Expected notFound to be thrown")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .notFound(message: "Watchlist item not found."))
        }
    }

    func testServerErrorMapsToServerError() async throws {
        let body = #"{ "error": "Unexpected error." }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            (self.jsonResponse(statusCode: 500, url: request.url!, body: body), body)
        }

        do {
            _ = try await client.fetchWatchlist()
            XCTFail("Expected serverError to be thrown")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .serverError(message: "Unexpected error."))
        }
    }

    func testServiceUnavailableMapsToServiceUnavailable() async throws {
        let body = #"{ "error": "Movie search is unavailable until TMDb is configured." }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            (self.jsonResponse(statusCode: 503, url: request.url!, body: body), body)
        }

        do {
            _ = try await client.searchMovies(query: "matrix")
            XCTFail("Expected serviceUnavailable to be thrown")
        } catch let error as APIClientError {
            XCTAssertEqual(
                error,
                .serviceUnavailable(message: "Movie search is unavailable until TMDb is configured.")
            )
        }
    }

    func testMalformedResponseBodyMapsToDecodingFailed() async throws {
        let body = #"{ "items": "not-an-array" }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            (self.jsonResponse(statusCode: 200, url: request.url!, body: body), body)
        }

        do {
            _ = try await client.fetchWatchlist()
            XCTFail("Expected decodingFailed to be thrown")
        } catch let error as APIClientError {
            guard case .decodingFailed = error else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    func testTransportFailureMapsToTransportFailed() async throws {
        MockURLProtocol.requestHandler = { _ in
            throw URLError(.notConnectedToInternet)
        }

        do {
            _ = try await client.fetchWatchlist()
            XCTFail("Expected transportFailed to be thrown")
        } catch let error as APIClientError {
            guard case .transportFailed = error else {
                return XCTFail("Expected transportFailed, got \(error)")
            }
        }
    }

    func testTokenProviderFailurePropagatesWithoutNetworkCall() async throws {
        let failingClient = APIClient(
            environment: APIEnvironment(baseURL: baseURL),
            tokenProvider: FailingTokenProvider(),
            session: MockURLProtocol.makeSession()
        )

        var requestMade = false
        MockURLProtocol.requestHandler = { request in
            requestMade = true
            return (self.jsonResponse(statusCode: 200, url: request.url!, body: Data()), Data())
        }

        do {
            _ = try await failingClient.fetchWatchlist()
            XCTFail("Expected the token provider's error to propagate")
        } catch is FailingTokenProvider.Failure {
            // expected
        }

        XCTAssertFalse(requestMade, "no network call should happen when the token provider fails")
    }
}

private extension URLRequest {
    /// `httpBody` is nil for requests replayed through `URLProtocol`; the body
    /// is available on `httpBodyStream` instead.
    func httpBodyStreamData() -> Data? {
        guard let stream = httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }

        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
