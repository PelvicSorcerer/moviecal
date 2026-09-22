import Foundation
import Observation

/// Loads the signed-in user's watchlist from `GET /api/v1/watchlist`
/// through `APIClient`.
@Observable
@MainActor
final class WatchlistViewModel {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded([WatchlistItem])
        case failed(String)
    }

    private(set) var state: LoadState = .idle

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func load() async {
        state = .loading
        do {
            let items = try await apiClient.fetchWatchlist()
            state = .loaded(items)
        } catch {
            state = .failed("Unable to load your watchlist. Pull to refresh to try again.")
        }
    }
}
