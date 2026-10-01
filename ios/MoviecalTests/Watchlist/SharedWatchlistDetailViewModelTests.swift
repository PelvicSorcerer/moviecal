import XCTest
@testable import Moviecal

@MainActor
final class SharedWatchlistDetailViewModelTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    private func makeViewModel() -> SharedWatchlistDetailViewModel {
        SharedWatchlistDetailViewModel(summary: WatchlistsFixtures.edited, apiClient: WatchlistsFixtures.makeClient())
    }

    private var editedJSON: String {
        WatchlistsFixtures.summaryJSON("list-edited", kind: "shared", role: "editor", ownerUserId: "user-2")
    }

    func testLoadPopulatesItems() async {
        WatchlistsFixtures.respond(body: WatchlistsFixtures.detailBody(editedJSON, items: [WatchlistsFixtures.itemJSON]))
        let viewModel = makeViewModel()

        await viewModel.load()

        guard case .loaded(let items) = viewModel.state else {
            return XCTFail("Expected .loaded, got \(viewModel.state)")
        }
        XCTAssertEqual(items.map(\.movie.title), ["The Matrix"])
    }

    func testNotFoundMeansAccessLost() async {
        WatchlistsFixtures.respond(status: 404, body: #"{"error":"Watchlist not found."}"#.data(using: .utf8)!)
        let viewModel = makeViewModel()

        await viewModel.load()

        XCTAssertEqual(viewModel.state, .accessLost)
    }

    func testRefreshAfterRevocationExitsAndDropsItems() async {
        WatchlistsFixtures.respond(body: WatchlistsFixtures.detailBody(editedJSON, items: [WatchlistsFixtures.itemJSON]))
        let viewModel = makeViewModel()
        await viewModel.load()

        WatchlistsFixtures.respond(status: 404, body: #"{"error":"Watchlist not found."}"#.data(using: .utf8)!)
        await viewModel.load()

        XCTAssertEqual(viewModel.state, .accessLost)
    }

    func testTransientFailureShowsErrorOrKeepsItems() async {
        MockURLProtocol.requestHandler = { _ in throw URLError(.notConnectedToInternet) }
        let viewModel = makeViewModel()
        await viewModel.load()
        guard case .failed = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }

        WatchlistsFixtures.respond(body: WatchlistsFixtures.detailBody(editedJSON, items: [WatchlistsFixtures.itemJSON]))
        await viewModel.load()
        let loaded = viewModel.state

        MockURLProtocol.requestHandler = { _ in throw URLError(.timedOut) }
        await viewModel.load()
        XCTAssertEqual(viewModel.state, loaded)
    }

    func testDetailForADifferentListIsRejected() async {
        let other = WatchlistsFixtures.summaryJSON("some-other-list", kind: "shared", role: "owner")
        WatchlistsFixtures.respond(body: WatchlistsFixtures.detailBody(other))
        let viewModel = makeViewModel()

        await viewModel.load()

        guard case .failed = viewModel.state else {
            return XCTFail("Expected .failed, got \(viewModel.state)")
        }
    }
}
