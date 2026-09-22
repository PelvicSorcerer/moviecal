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

    private(set) var state: SearchState = .idle

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
}
