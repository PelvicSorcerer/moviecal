import XCTest
@testable import Moviecal

@MainActor
final class SearchViewModelTests: XCTestCase {
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

    private func makeViewModel() -> SearchViewModel {
        let apiClient = APIClient(
            environment: APIEnvironment(baseURL: baseURL),
            tokenProvider: StubTokenProvider(),
            session: MockURLProtocol.makeSession()
        )
        return SearchViewModel(apiClient: apiClient, debounceInterval: .milliseconds(1))
    }

    private func response(statusCode: Int, url: URL) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: nil)!
    }

    private func resultsJSON() -> Data {
        """
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
    }

    func testInitialStateIsIdle() {
        let viewModel = makeViewModel()
        XCTAssertEqual(viewModel.state, .idle)
    }

    func testWhitespaceOnlyQueryStaysIdleWithoutNetworkCall() async {
        var requestMade = false
        MockURLProtocol.requestHandler = { request in
            requestMade = true
            return (self.response(statusCode: 200, url: request.url!), Data())
        }

        let viewModel = makeViewModel()
        viewModel.query = "   "
        await viewModel.searchTask?.value

        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertFalse(requestMade)
    }

    func testClearingQueryAfterASearchReturnsToIdleWithoutAnAdditionalNetworkCall() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            return (self.response(statusCode: 200, url: request.url!), self.resultsJSON())
        }

        let viewModel = makeViewModel()
        viewModel.query = "matrix"
        await viewModel.searchTask?.value
        XCTAssertEqual(requestCount, 1)

        viewModel.query = ""
        await viewModel.searchTask?.value

        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertEqual(requestCount, 1, "clearing the query must not call the endpoint")
    }

    func testTypingDebouncesToASingleRequestForTheFinalQuery() async {
        var capturedQueries: [String] = []
        MockURLProtocol.requestHandler = { request in
            let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
            capturedQueries.append(components?.queryItems?.first(where: { $0.name == "q" })?.value ?? "")
            return (self.response(statusCode: 200, url: request.url!), self.resultsJSON())
        }

        let viewModel = makeViewModel()
        viewModel.query = "m"
        viewModel.query = "ma"
        viewModel.query = "mat"
        viewModel.query = "matrix"
        await viewModel.searchTask?.value

        XCTAssertEqual(capturedQueries, ["matrix"], "only the final debounced query should reach the network")
    }

    func testResultsPopulateLoadedState() async {
        MockURLProtocol.requestHandler = { request in
            (self.response(statusCode: 200, url: request.url!), self.resultsJSON())
        }

        let viewModel = makeViewModel()
        viewModel.query = "matrix"
        await viewModel.searchTask?.value

        guard case .loaded(let results) = viewModel.state else {
            return XCTFail("Expected .loaded, got \(viewModel.state)")
        }
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].title, "The Matrix")
    }

    func testEmptyResultsPopulateNoResultsState() async {
        let json = #"{ "results": [] }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            (self.response(statusCode: 200, url: request.url!), json)
        }

        let viewModel = makeViewModel()
        viewModel.query = "zzzznonsense"
        await viewModel.searchTask?.value

        XCTAssertEqual(viewModel.state, .noResults)
    }

    func testTransportFailureMapsToFailedState() async {
        MockURLProtocol.requestHandler = { _ in
            throw URLError(.notConnectedToInternet)
        }

        let viewModel = makeViewModel()
        viewModel.query = "matrix"
        await viewModel.searchTask?.value

        guard case .failed(let message) = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
        XCTAssertFalse(message.isEmpty)
    }

    func testServiceUnavailableMapsToADistinctFailedMessage() async {
        let body = #"{ "error": "Movie search is unavailable until TMDb is configured." }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            (self.response(statusCode: 503, url: request.url!), body)
        }

        let viewModel = makeViewModel()
        viewModel.query = "matrix"
        await viewModel.searchTask?.value

        guard case .failed(let message) = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
        XCTAssertTrue(message.contains("TMDb"))
    }

    func testRetryAfterFailureCanSucceed() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            if requestCount == 1 {
                throw URLError(.notConnectedToInternet)
            }
            return (self.response(statusCode: 200, url: request.url!), self.resultsJSON())
        }

        let viewModel = makeViewModel()
        viewModel.query = "matrix"
        await viewModel.searchTask?.value
        guard case .failed = viewModel.state else {
            return XCTFail("Expected first search to fail, got \(viewModel.state)")
        }

        await viewModel.retry()

        guard case .loaded(let results) = viewModel.state else {
            return XCTFail("Expected .loaded after retry, got \(viewModel.state)")
        }
        XCTAssertEqual(results.count, 1)
    }
}

private struct StubTokenProvider: AuthTokenProviding {
    func currentAccessToken() async throws -> String {
        "test-access-token"
    }
}
