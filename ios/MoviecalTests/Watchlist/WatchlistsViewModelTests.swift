import XCTest
@testable import Moviecal

/// Shared fixtures for the personal/shared list tests.
enum WatchlistsFixtures {
    static let personal = WatchlistSummary(
        id: "list-personal", kind: .personal, name: "My Watchlist",
        ownerUserId: "user-1", role: .owner, canEdit: true
    )
    static let owned = WatchlistSummary(
        id: "list-owned", kind: .shared, name: "Movie Night",
        ownerUserId: "user-1", role: .owner, canEdit: true
    )
    static let edited = WatchlistSummary(
        id: "list-edited", kind: .shared, name: "Family Picks",
        ownerUserId: "user-2", role: .editor, canEdit: true
    )

    static func summaryJSON(_ id: String, kind: String, role: String, ownerUserId: String = "user-1", name: String = "List") -> String {
        """
        {"id":"\(id)","kind":"\(kind)","name":"\(name)","ownerUserId":"\(ownerUserId)","role":"\(role)","canEdit":true}
        """
    }

    static func listBody(_ summaries: [String], nextCursor: String? = nil) -> Data {
        let cursor = nextCursor.map { "\"\($0)\"" } ?? "null"
        return #"{"watchlists":[\#(summaries.joined(separator: ","))],"page":{"limit":50,"nextCursor":\#(cursor)}}"#
            .data(using: .utf8)!
    }

    static func detailBody(_ summary: String, items: [String] = [], nextCursor: String? = nil) -> Data {
        let cursor = nextCursor.map { "\"\($0)\"" } ?? "null"
        return #"{"watchlist":\#(summary),"items":[\#(items.joined(separator: ","))],"page":{"limit":50,"nextCursor":\#(cursor)}}"#
            .data(using: .utf8)!
    }

    static let itemJSON = """
    {"id":"item-1","addedAt":"2026-06-13T05:00:00.000Z","movie":{"id":42,"tmdbId":603,"title":"The Matrix","releaseDate":"1999-03-31","posterPath":null,"overview":null}}
    """

    static func makeClient() -> APIClient {
        APIClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.moviecal.test")!),
            tokenProvider: WatchlistsStubTokenProvider(),
            session: MockURLProtocol.makeSession()
        )
    }

    static func respond(status: Int = 200, body: Data) {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, body)
        }
    }
}

struct WatchlistsStubTokenProvider: AuthTokenProviding {
    func currentAccessToken() async throws -> String { "test-access-token" }
}

@MainActor
final class WatchlistsViewModelTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    private var twoListsBody: Data {
        WatchlistsFixtures.listBody([
            WatchlistsFixtures.summaryJSON("list-personal", kind: "personal", role: "owner"),
            WatchlistsFixtures.summaryJSON("list-owned", kind: "shared", role: "owner"),
        ])
    }

    func testLoadPopulatesPersonalAndSharedLists() async {
        WatchlistsFixtures.respond(body: twoListsBody)
        let viewModel = WatchlistsViewModel(apiClient: WatchlistsFixtures.makeClient())
        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.load()

        guard case .loaded(let summaries) = viewModel.state else {
            return XCTFail("Expected .loaded, got \(viewModel.state)")
        }
        XCTAssertEqual(summaries.map(\.kind), [.personal, .shared])
    }

    func testLoadFailureShowsErrorWhenNothingLoadedYet() async {
        MockURLProtocol.requestHandler = { _ in throw URLError(.notConnectedToInternet) }
        let viewModel = WatchlistsViewModel(apiClient: WatchlistsFixtures.makeClient())

        await viewModel.load()

        guard case .failed(let message) = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
        XCTAssertFalse(message.isEmpty)
    }

    func testTransientRefreshFailureKeepsLoadedLists() async {
        WatchlistsFixtures.respond(body: twoListsBody)
        let viewModel = WatchlistsViewModel(apiClient: WatchlistsFixtures.makeClient())
        await viewModel.load()
        let loaded = viewModel.state

        MockURLProtocol.requestHandler = { _ in throw URLError(.timedOut) }
        await viewModel.load()

        XCTAssertEqual(viewModel.state, loaded)
    }

    func testRefreshDropsListsThatWereRevoked() async {
        WatchlistsFixtures.respond(body: twoListsBody)
        let viewModel = WatchlistsViewModel(apiClient: WatchlistsFixtures.makeClient())
        await viewModel.load()

        WatchlistsFixtures.respond(body: WatchlistsFixtures.listBody([
            WatchlistsFixtures.summaryJSON("list-personal", kind: "personal", role: "owner"),
        ]))
        await viewModel.load()

        guard case .loaded(let summaries) = viewModel.state else {
            return XCTFail("Expected .loaded, got \(viewModel.state)")
        }
        XCTAssertEqual(summaries.map(\.id), ["list-personal"])
    }

    func testUnauthorizedRefreshDropsLoadedLists() async {
        WatchlistsFixtures.respond(body: twoListsBody)
        let viewModel = WatchlistsViewModel(apiClient: WatchlistsFixtures.makeClient())
        await viewModel.load()

        WatchlistsFixtures.respond(status: 401, body: #"{"error":"Unauthorized."}"#.data(using: .utf8)!)
        await viewModel.load()

        guard case .failed = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
    }

    func testInvalidDataIsNotShown() async {
        // A personal list the caller does not own violates the contract.
        WatchlistsFixtures.respond(body: WatchlistsFixtures.listBody([
            WatchlistsFixtures.summaryJSON("list-personal", kind: "personal", role: "editor"),
        ]))
        let viewModel = WatchlistsViewModel(apiClient: WatchlistsFixtures.makeClient())

        await viewModel.load()

        guard case .failed = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
    }

    func testNoteAccessLostSetsMessageAndRefreshes() async {
        WatchlistsFixtures.respond(body: twoListsBody)
        let viewModel = WatchlistsViewModel(apiClient: WatchlistsFixtures.makeClient())
        await viewModel.load()

        WatchlistsFixtures.respond(body: WatchlistsFixtures.listBody([
            WatchlistsFixtures.summaryJSON("list-personal", kind: "personal", role: "owner"),
        ]))
        await viewModel.noteAccessLost(to: WatchlistsFixtures.owned)

        XCTAssertEqual(viewModel.accessLostMessage, "You no longer have access to \"Movie Night\".")
        guard case .loaded(let summaries) = viewModel.state else {
            return XCTFail("Expected .loaded, got \(viewModel.state)")
        }
        XCTAssertEqual(summaries.count, 1)

        viewModel.dismissAccessLostMessage()
        XCTAssertNil(viewModel.accessLostMessage)
    }
}
