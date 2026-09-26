import Foundation
import Observation

/// Loads every personal and shared list the caller may read from
/// `GET /api/v1/watchlists` through `APIClient`.
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
    /// Set when a list the user was viewing is no longer authorized.
    private(set) var accessLostMessage: String?

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    /// Loads (or refreshes) the lists. Existing content stays visible during
    /// a refresh and after a transient failure, but is dropped when the
    /// server says the caller is no longer authorized.
    func load() async {
        let previous = state
        if case .loaded = previous {} else { state = .loading }

        do {
            state = .loaded(try await apiClient.fetchWatchlists())
        } catch APIClientError.accessDenied, APIClientError.authenticationExpired, APIClientError.notFound {
            state = .failed("You no longer have access to these watchlists. Pull to refresh to try again.")
        } catch {
            if case .loaded = previous {
                state = previous
            } else {
                state = .failed("Unable to load your watchlists. Pull to refresh to try again.")
            }
        }
    }

    /// Called when a list's detail reports that access was lost: records a
    /// message for the user and refreshes so the list disappears.
    func noteAccessLost(to summary: WatchlistSummary) async {
        accessLostMessage = "You no longer have access to \"\(summary.name)\"."
        await load()
    }

    func dismissAccessLostMessage() {
        accessLostMessage = nil
    }
}
