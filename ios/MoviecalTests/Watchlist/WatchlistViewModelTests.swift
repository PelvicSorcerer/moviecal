import XCTest
@testable import Moviecal

@MainActor
final class WatchlistViewModelTests: XCTestCase {
    private var baseURL: URL!

    override func setUp() {
        super.setUp()
        baseURL = URL(string: "https://api.moviecal.test")!
    }

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        baseURL = nil
        super.tearDown()
    }

    private func makeClient() -> APIClient {
        APIClient(
            environment: APIEnvironment(baseURL: baseURL),
            tokenProvider: StubTokenProvider(),
            session: MockURLProtocol.makeSession()
        )
    }

    func testInitialStateIsIdle() {
        let viewModel = WatchlistViewModel(apiClient: makeClient())
        XCTAssertEqual(viewModel.state, .idle)
    }

    func testLoadSuccessPopulatesLoadedState() async {
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

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, json)
        }

        let viewModel = WatchlistViewModel(apiClient: makeClient())
        await viewModel.load()

        guard case .loaded(let items) = viewModel.state else {
            return XCTFail("Expected .loaded, got \(viewModel.state)")
        }
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].movie.title, "The Matrix")
    }

    func testLoadSuccessWithNoItemsPopulatesEmptyLoadedState() async {
        let json = #"{ "items": [] }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, json)
        }

        let viewModel = WatchlistViewModel(apiClient: makeClient())
        await viewModel.load()

        XCTAssertEqual(viewModel.state, .loaded([]))
    }

    func testLoadFailurePopulatesFailedStateWithMessage() async {
        MockURLProtocol.requestHandler = { _ in
            throw URLError(.notConnectedToInternet)
        }

        let viewModel = WatchlistViewModel(apiClient: makeClient())
        await viewModel.load()

        guard case .failed(let message) = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
        XCTAssertFalse(message.isEmpty)
    }

    func testReloadAfterFailureCanSucceed() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            if requestCount == 1 {
                throw URLError(.notConnectedToInternet)
            }
            let json = #"{ "items": [] }"#.data(using: .utf8)!
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, json)
        }

        let viewModel = WatchlistViewModel(apiClient: makeClient())
        await viewModel.load()
        guard case .failed = viewModel.state else {
            return XCTFail("Expected first load to fail, got \(viewModel.state)")
        }

        await viewModel.load()
        XCTAssertEqual(viewModel.state, .loaded([]))
    }
}

private struct StubTokenProvider: AuthTokenProviding {
    func currentAccessToken() async throws -> String {
        "test-access-token"
    }
}
