import Foundation
import Observation

/// Loads one list's items from `GET /api/v1/watchlists/{id}`. A `404`
/// (nonexistent or revoked, indistinguishable by contract) becomes
/// `.accessLost` so the view can exit cleanly instead of showing stale data.
@Observable
@MainActor
final class SharedWatchlistDetailViewModel {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded([WatchlistItem])
        case failed(String)
        case accessLost
    }

    let summary: WatchlistSummary
    private(set) var state: LoadState = .idle

    private let apiClient: APIClient

    init(summary: WatchlistSummary, apiClient: APIClient) {
        self.summary = summary
        self.apiClient = apiClient
    }

    func load() async {
        let previous = state
        if case .loaded = previous {} else { state = .loading }

        do {
            state = .loaded(try await apiClient.fetchWatchlistDetail(watchlistId: summary.id).items)
        } catch APIClientError.notFound, APIClientError.accessDenied {
            state = .accessLost
        } catch {
            if case .loaded = previous {
                state = previous
            } else {
                state = .failed("Unable to load this watchlist. Pull to refresh to try again.")
            }
        }
    }
}
