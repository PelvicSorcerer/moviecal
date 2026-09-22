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

    // MARK: - Add to watchlist

    private func matrixResult() -> MovieSearchResult {
        MovieSearchResult(
            tmdbId: 603,
            title: "The Matrix",
            releaseDate: "1999-03-31",
            posterPath: "/matrix.jpg",
            overview: "A hacker discovers the truth."
        )
    }

    private func watchlistItemJSON() -> Data {
        """
        {
          "item": {
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
        }
        """.data(using: .utf8)!
    }

    func testAddToWatchlistSuccessSetsAddedState() async {
        MockURLProtocol.requestHandler = { request in
            (self.response(statusCode: 201, url: request.url!), self.watchlistItemJSON())
        }

        let viewModel = makeViewModel()
        await viewModel.addToWatchlist(matrixResult())

        XCTAssertEqual(viewModel.addToWatchlistStates[603], .added)
    }

    /// The server's insert is idempotent-looking for a duplicate `tmdbId` —
    /// `addWatchlistItem` (`src/lib/watchlist/items.ts`) still returns `201`
    /// with the (pre-)existing item rather than an error. The client can't
    /// tell a fresh insert from a duplicate from the response alone, so
    /// re-adding an already-watchlisted movie must land in the same
    /// `.added` state as a fresh add, matching that server behavior.
    func testReAddingAnAlreadyWatchlistedMovieSucceedsLikeAFreshAdd() async {
        MockURLProtocol.requestHandler = { request in
            (self.response(statusCode: 201, url: request.url!), self.watchlistItemJSON())
        }

        let viewModel = makeViewModel()
        await viewModel.addToWatchlist(matrixResult())

        XCTAssertEqual(viewModel.addToWatchlistStates[603], .added)
    }

    func testAddToWatchlistTransportFailureSetsARetryableFailedState() async {
        MockURLProtocol.requestHandler = { _ in
            throw URLError(.notConnectedToInternet)
        }

        let viewModel = makeViewModel()
        await viewModel.addToWatchlist(matrixResult())

        guard case .failed(let message) = viewModel.addToWatchlistStates[603] else {
            return XCTFail("Expected .failed, got \(String(describing: viewModel.addToWatchlistStates[603]))")
        }
        XCTAssertFalse(message.isEmpty)
    }

    func testAddToWatchlistBadRequestSetsAnUnexpectedErrorMessage() async {
        let body = #"{ "error": "A valid tmdbId is required." }"#.data(using: .utf8)!
        MockURLProtocol.requestHandler = { request in
            (self.response(statusCode: 400, url: request.url!), body)
        }

        let viewModel = makeViewModel()
        await viewModel.addToWatchlist(matrixResult())

        guard case .failed(let message) = viewModel.addToWatchlistStates[603] else {
            return XCTFail("Expected .failed, got \(String(describing: viewModel.addToWatchlistStates[603]))")
        }
        XCTAssertFalse(message.isEmpty)
    }

    func testRetryingAfterAFailedAddCanSucceed() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            if requestCount == 1 {
                throw URLError(.notConnectedToInternet)
            }
            return (self.response(statusCode: 201, url: request.url!), self.watchlistItemJSON())
        }

        let viewModel = makeViewModel()
        let result = matrixResult()
        await viewModel.addToWatchlist(result)
        guard case .failed = viewModel.addToWatchlistStates[603] else {
            return XCTFail("Expected first add to fail, got \(String(describing: viewModel.addToWatchlistStates[603]))")
        }

        await viewModel.addToWatchlist(result)

        XCTAssertEqual(viewModel.addToWatchlistStates[603], .added)
        XCTAssertEqual(requestCount, 2)
    }

    func testAddToWatchlistDoesNotRepeatTheRequestOnceAlreadyAdded() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            return (self.response(statusCode: 201, url: request.url!), self.watchlistItemJSON())
        }

        let viewModel = makeViewModel()
        let result = matrixResult()
        await viewModel.addToWatchlist(result)
        await viewModel.addToWatchlist(result)

        XCTAssertEqual(viewModel.addToWatchlistStates[603], .added)
        XCTAssertEqual(requestCount, 1, "a row that already succeeded must not fire a second request")
    }

    func testAddToWatchlistFailureIsScopedToItsOwnRow() async {
        let inception = MovieSearchResult(
            tmdbId: 27205,
            title: "Inception",
            releaseDate: "2010-07-15",
            posterPath: nil,
            overview: nil
        )
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            if requestCount == 1 {
                return (self.response(statusCode: 201, url: request.url!), self.watchlistItemJSON())
            }
            return (self.response(statusCode: 400, url: request.url!), Data())
        }

        let viewModel = makeViewModel()
        await viewModel.addToWatchlist(matrixResult())
        await viewModel.addToWatchlist(inception)

        XCTAssertEqual(viewModel.addToWatchlistStates[603], .added, "The Matrix's own add must succeed")
        guard case .failed = viewModel.addToWatchlistStates[inception.tmdbId] else {
            return XCTFail(
                "Expected Inception's row to fail independently, got "
                    + "\(String(describing: viewModel.addToWatchlistStates[inception.tmdbId]))"
            )
        }
    }
}

private struct StubTokenProvider: AuthTokenProviding {
    func currentAccessToken() async throws -> String {
        "test-access-token"
    }
}
