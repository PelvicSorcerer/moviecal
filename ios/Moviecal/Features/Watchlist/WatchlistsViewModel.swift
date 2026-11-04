import Foundation
import Observation

/// Loads every list the caller may read from `GET /api/v1/watchlists`.
@Observable
@MainActor
final class WatchlistsViewModel {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded([WatchlistSummary])
        case failed(String)
    }

    private(set) var state: LoadState = .idle

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    /// Reloads the lists. Already-loaded lists stay visible while a refresh
    /// is in flight; a failed refresh replaces them so lists the caller may
    /// no longer be authorized for are not left on screen.
    func load() async {
        if case .loaded = state {} else {
            state = .loading
        }
        do {
            state = .loaded(try await apiClient.fetchWatchlists())
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed("Unable to load your watchlists. Pull to refresh to try again.")
        }
    }
}

/// Loads one list and its items from `GET /api/v1/watchlists/{id}`.
@Observable
@MainActor
final class WatchlistDetailViewModel {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded(WatchlistDetail)
        case failed(String)
        /// The list no longer exists or the caller lost access (`403`/`404`).
        case unavailable
    }

    private(set) var state: LoadState = .idle

    let watchlistId: String
    private let apiClient: APIClient

    init(watchlistId: String, apiClient: APIClient) {
        self.watchlistId = watchlistId
        self.apiClient = apiClient
    }

    func load() async {
        if case .loaded = state {} else {
            state = .loading
        }
        do {
            state = .loaded(try await apiClient.fetchWatchlistDetail(id: watchlistId))
        } catch APIClientError.notFound, APIClientError.accessDenied {
            state = .unavailable
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed("Unable to load this watchlist. Pull to refresh to try again.")
        }
    }
}
