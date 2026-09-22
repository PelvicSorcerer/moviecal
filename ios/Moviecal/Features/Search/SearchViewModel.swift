import Foundation
import Observation

/// Debounces the Search tab's query text and calls
/// `GET /api/v1/movies/search` through `APIClient`.
@Observable
@MainActor
final class SearchViewModel {
    enum SearchState: Equatable {
        case idle
        case loading
        case loaded([MovieSearchResult])
        case noResults
        case failed(String)
    }

    /// Per-row state for `POST /api/v1/watchlist`, keyed by `tmdbId`. The
    /// server's insert is idempotent-looking for a duplicate `tmdbId` — it
    /// returns `201` with the (pre-)existing item either way
    /// (`addWatchlistItem` in `src/lib/watchlist/items.ts`) — so there is no
    /// separate "already on watchlist" case here: any `201` maps to
    /// `.added`, matching the server's own behavior instead of guessing at
    /// one.
    enum AddToWatchlistState: Equatable {
        case idle
        case adding
        case added
        case failed(String)
    }

    private(set) var state: SearchState = .idle
    private(set) var addToWatchlistStates: [Int: AddToWatchlistState] = [:]

    var query: String = "" {
        didSet {
            guard query != oldValue else { return }
            queryDidChange()
        }
    }

    /// Exposed so tests can await the in-flight debounce/search without
    /// polling `state`.
    private(set) var searchTask: Task<Void, Never>?

    private let apiClient: APIClient
    private let debounceInterval: Duration

    init(apiClient: APIClient, debounceInterval: Duration = .milliseconds(300)) {
        self.apiClient = apiClient
        self.debounceInterval = debounceInterval
    }

    func retry() async {
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            state = .idle
            return
        }
        await performSearch(query: trimmed)
    }

    private func queryDidChange() {
        searchTask?.cancel()

        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            state = .idle
            return
        }

        searchTask = Task { [debounceInterval] in
            do {
                try await Task.sleep(for: debounceInterval)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await self.performSearch(query: trimmed)
        }
    }

    private func performSearch(query: String) async {
        state = .loading
        do {
            let results = try await apiClient.searchMovies(query: query)
            guard !Task.isCancelled else { return }
            state = results.isEmpty ? .noResults : .loaded(results)
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(Self.errorMessage(for: error))
        }
    }

    private static func errorMessage(for error: Error) -> String {
        if let apiError = error as? APIClientError {
            switch apiError {
            case .serviceUnavailable:
                return "Movie search is unavailable until TMDb is configured. Try again later."
            case .invalidRequest:
                return "That search couldn't be completed. Try a different query."
            default:
                break
            }
        }
        return "Unable to search movies. Try again."
    }

    /// Adds `result` to the personal watchlist via `POST /api/v1/watchlist`
    /// and tracks the outcome per-row in `addToWatchlistStates`. A no-op
    /// while already `.adding` or once `.added`, so a row that already
    /// succeeded can't fire a second request.
    func addToWatchlist(_ result: MovieSearchResult) async {
        switch addToWatchlistStates[result.tmdbId] {
        case .adding, .added:
            return
        case .idle, .failed, nil:
            break
        }

        addToWatchlistStates[result.tmdbId] = .adding
        do {
            _ = try await apiClient.addWatchlistItem(tmdbId: result.tmdbId)
            addToWatchlistStates[result.tmdbId] = .added
        } catch {
            addToWatchlistStates[result.tmdbId] = .failed(Self.addToWatchlistErrorMessage(for: error))
        }
    }

    private static func addToWatchlistErrorMessage(for error: Error) -> String {
        if let apiError = error as? APIClientError, case .invalidRequest = apiError {
            // A real search result always carries a valid tmdbId, so a 400
            // here means something unexpected rather than a transient/user
            // fixable failure — but the row still offers the same retry
            // affordance as any other failure.
            return "Something went wrong adding this movie."
        }
        return "Couldn't add to watchlist. Try again."
    }
}
