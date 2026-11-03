import XCTest
@testable import Moviecal

@MainActor
final class WatchlistsViewModelTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    private func makeClient() -> APIClient {
        APIClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.moviecal.test")!),
            tokenProvider: ListsStubTokenProvider(),
            session: MockURLProtocol.makeSession()
        )
    }

    private func respond(_ request: URLRequest, status: Int = 200, body: String) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, Data(body.utf8))
    }

    private let personalJSON = """
    { "id": "p1", "kind": "personal", "name": "Watchlist", "ownerUserId": "u1", "role": "owner", "canEdit": true }
    """
    private let editorJSON = """
    { "id": "s1", "kind": "shared", "name": "Movie Night", "ownerUserId": "u2", "role": "editor", "canEdit": true }
    """
    private let itemJSON = """
    { "id": "i1", "addedAt": "2026-06-13T05:00:00.000Z",
      "movie": { "id": 42, "tmdbId": 603, "title": "The Matrix", "releaseDate": "1999-03-31", "posterPath": null, "overview": null } }
    """

    // MARK: - Decoding

    func testSummaryDecodesRolesAndKinds() throws {
        let owner = try JSONDecoder().decode(WatchlistSummary.self, from: Data(personalJSON.utf8))
        XCTAssertEqual(owner.kind, .personal)
        XCTAssertEqual(owner.role, .owner)
        let editor = try JSONDecoder().decode(WatchlistSummary.self, from: Data(editorJSON.utf8))
        XCTAssertEqual(editor.kind, .shared)
        XCTAssertEqual(editor.role, .editor)
        XCTAssertEqual(editor.roleDescription, "Shared with you · Editor")
    }

    func testSummaryRejectsUnknownRole() {
        let json = editorJSON.replacingOccurrences(of: "editor", with: "viewer")
        XCTAssertThrowsError(try JSONDecoder().decode(WatchlistSummary.self, from: Data(json.utf8)))
    }

    // MARK: - APIClient

    func testFetchWatchlistsFollowsCursor() async throws {
        var cursors: [String?] = []
        MockURLProtocol.requestHandler = { request in
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "cursor" }?.value
            cursors.append(cursor)
            XCTAssertEqual(request.url?.path, "/api/v1/watchlists")
            if cursor == nil {
                return self.respond(request, body: #"{ "watchlists": [\#(self.personalJSON)], "page": { "limit": 1, "nextCursor": "abc" } }"#)
            }
            return self.respond(request, body: #"{ "watchlists": [\#(self.editorJSON)], "page": { "limit": 1, "nextCursor": null } }"#)
        }

        let lists = try await makeClient().fetchWatchlists()

        XCTAssertEqual(lists.map(\.id), ["p1", "s1"])
        XCTAssertEqual(cursors, [nil, "abc"])
    }

    func testFetchWatchlistDetailDecodesItems() async throws {
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/watchlists/s1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-access-token")
            return self.respond(request, body: #"{ "watchlist": \#(self.editorJSON), "items": [\#(self.itemJSON)], "page": { "limit": 50, "nextCursor": null } }"#)
        }

        let detail = try await makeClient().fetchWatchlistDetail(id: "s1")

        XCTAssertEqual(detail.watchlist.name, "Movie Night")
        XCTAssertEqual(detail.items.map(\.movie.title), ["The Matrix"])
    }

    // MARK: - WatchlistsViewModel

    func testLoadPopulatesLists() async {
        MockURLProtocol.requestHandler = { request in
            self.respond(request, body: #"{ "watchlists": [\#(self.personalJSON), \#(self.editorJSON)], "page": { "limit": 50, "nextCursor": null } }"#)
        }
        let viewModel = WatchlistsViewModel(apiClient: makeClient())
        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.load()

        guard case .loaded(let lists) = viewModel.state else {
            return XCTFail("Expected .loaded, got \(viewModel.state)")
        }
        XCTAssertEqual(lists.count, 2)
    }

    func testRefreshAfterRevocationDropsList() async {
        var call = 0
        MockURLProtocol.requestHandler = { request in
            call += 1
            if call == 1 {
                return self.respond(request, body: #"{ "watchlists": [\#(self.personalJSON), \#(self.editorJSON)], "page": { "limit": 50, "nextCursor": null } }"#)
            }
            return self.respond(request, body: #"{ "watchlists": [\#(self.personalJSON)], "page": { "limit": 50, "nextCursor": null } }"#)
        }
        let viewModel = WatchlistsViewModel(apiClient: makeClient())
        await viewModel.load()
        await viewModel.load()

        guard case .loaded(let lists) = viewModel.state else {
            return XCTFail("Expected .loaded, got \(viewModel.state)")
        }
        XCTAssertEqual(lists.map(\.id), ["p1"])
    }

    func testLoadErrorReplacesPreviouslyLoadedLists() async {
        var call = 0
        MockURLProtocol.requestHandler = { request in
            call += 1
            if call == 1 {
                return self.respond(request, body: #"{ "watchlists": [\#(self.editorJSON)], "page": { "limit": 50, "nextCursor": null } }"#)
            }
            throw URLError(.notConnectedToInternet)
        }
        let viewModel = WatchlistsViewModel(apiClient: makeClient())
        await viewModel.load()
        await viewModel.load()

        guard case .failed(let message) = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
        XCTAssertFalse(message.isEmpty)
    }

    func testMalformedListIsNotShown() async {
        MockURLProtocol.requestHandler = { request in
            self.respond(request, body: #"{ "watchlists": [{ "id": "x", "kind": "mystery" }], "page": { "limit": 50, "nextCursor": null } }"#)
        }
        let viewModel = WatchlistsViewModel(apiClient: makeClient())
        await viewModel.load()

        guard case .failed = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
    }

    // MARK: - WatchlistDetailViewModel

    func testDetailLoadPopulatesItems() async {
        MockURLProtocol.requestHandler = { request in
            self.respond(request, body: #"{ "watchlist": \#(self.editorJSON), "items": [\#(self.itemJSON)], "page": { "limit": 50, "nextCursor": null } }"#)
        }
        let viewModel = WatchlistDetailViewModel(watchlistId: "s1", apiClient: makeClient())

        await viewModel.load()

        guard case .loaded(let detail) = viewModel.state else {
            return XCTFail("Expected .loaded, got \(viewModel.state)")
        }
        XCTAssertEqual(detail.items.count, 1)
    }

    func testDetailNotFoundBecomesUnavailable() async {
        MockURLProtocol.requestHandler = { request in
            self.respond(request, status: 404, body: #"{ "error": "Watchlist not found." }"#)
        }
        let viewModel = WatchlistDetailViewModel(watchlistId: "s1", apiClient: makeClient())

        await viewModel.load()

        XCTAssertEqual(viewModel.state, .unavailable)
    }

    func testDetailRevokedAfterLoadBecomesUnavailable() async {
        var call = 0
        MockURLProtocol.requestHandler = { request in
            call += 1
            if call == 1 {
                return self.respond(request, body: #"{ "watchlist": \#(self.editorJSON), "items": [\#(self.itemJSON)], "page": { "limit": 50, "nextCursor": null } }"#)
            }
            return self.respond(request, status: 404, body: #"{ "error": "Watchlist not found." }"#)
        }
        let viewModel = WatchlistDetailViewModel(watchlistId: "s1", apiClient: makeClient())
        await viewModel.load()
        await viewModel.load()

        XCTAssertEqual(viewModel.state, .unavailable)
    }

    func testDetailTransportErrorFails() async {
        MockURLProtocol.requestHandler = { _ in throw URLError(.timedOut) }
        let viewModel = WatchlistDetailViewModel(watchlistId: "s1", apiClient: makeClient())

        await viewModel.load()

        guard case .failed = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
    }
}

private struct ListsStubTokenProvider: AuthTokenProviding {
    func currentAccessToken() async throws -> String {
        "test-access-token"
    }
}
