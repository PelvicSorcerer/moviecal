import Foundation
import Observation

/// Loads the signed-in user's watchlist from `GET /api/v1/watchlist` and
/// removes items via `DELETE /api/v1/watchlist`, both through `APIClient`.
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
    private(set) var removalErrorMessage: String?

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

    /// Removes `item` from the list optimistically. A `404` means the item
    /// is already gone server-side, so it is treated as success. Any other
    /// failure restores the item to its original position and surfaces
    /// `removalErrorMessage`.
    func remove(item: WatchlistItem) async {
        guard case .loaded(var items) = state, let index = items.firstIndex(of: item) else {
            return
        }

        items.remove(at: index)
        state = .loaded(items)
        removalErrorMessage = nil

        do {
            try await apiClient.removeWatchlistItem(watchlistItemId: item.id)
        } catch APIClientError.notFound {
            // Already removed server-side; the optimistic removal stands.
        } catch {
            items.insert(item, at: index)
            state = .loaded(items)
            removalErrorMessage = "Unable to remove \"\(item.movie.title)\". Please try again."
        }
    }

    func dismissRemovalError() {
        removalErrorMessage = nil
    }
}
