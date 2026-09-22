import SwiftUI

/// The Search tab: debounced TMDb movie search over
/// `GET /api/v1/movies/search`, plus a per-row "Add to Watchlist" action
/// over `POST /api/v1/watchlist`.
struct SearchView: View {
    @State private var viewModel: SearchViewModel

    init(apiClient: APIClient) {
        _viewModel = State(initialValue: SearchViewModel(apiClient: apiClient))
    }

    var body: some View {
        NavigationStack {
            SearchContentView(
                state: viewModel.state,
                addToWatchlistStates: viewModel.addToWatchlistStates,
                onRetry: { await viewModel.retry() },
                onAddToWatchlist: { result in await viewModel.addToWatchlist(result) }
            )
            .navigationTitle("Search")
            .searchable(text: $viewModel.query, prompt: "Movies")
        }
    }
}

/// The Search tab's presentational content, factored out of `SearchView`
/// so each search state can be rendered and snapshot-tested directly,
/// without depending on a real or mocked network round trip.
struct SearchContentView: View {
    let state: SearchViewModel.SearchState
    let addToWatchlistStates: [Int: SearchViewModel.AddToWatchlistState]
    let onRetry: () async -> Void
    let onAddToWatchlist: (MovieSearchResult) async -> Void

    init(
        state: SearchViewModel.SearchState,
        addToWatchlistStates: [Int: SearchViewModel.AddToWatchlistState] = [:],
        onRetry: @escaping () async -> Void,
        onAddToWatchlist: @escaping (MovieSearchResult) async -> Void = { _ in }
    ) {
        self.state = state
        self.addToWatchlistStates = addToWatchlistStates
        self.onRetry = onRetry
        self.onAddToWatchlist = onAddToWatchlist
    }

    var body: some View {
        Group {
            switch state {
            case .idle:
                ContentUnavailableView(
                    "Search Movies",
                    systemImage: "magnifyingglass",
                    description: Text("Search for a movie by title.")
                )
            case .loading:
                ProgressView()
            case .loaded(let results):
                List(results) { result in
                    SearchResultRow(
                        result: result,
                        addState: addToWatchlistStates[result.tmdbId] ?? .idle,
                        onAdd: { Task { await onAddToWatchlist(result) } }
                    )
                }
                .listStyle(.plain)
            case .noResults:
                ContentUnavailableView.search
            case .failed(let message):
                ContentUnavailableView {
                    Label("Couldn't Search Movies", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry") {
                        Task { await onRetry() }
                    }
                }
            }
        }
    }
}

private struct SearchResultRow: View {
    let result: MovieSearchResult
    let addState: SearchViewModel.AddToWatchlistState
    let onAdd: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AsyncImage(url: result.posterURL) { phase in
                if case .success(let image) = phase {
                    image
                        .resizable()
                        .aspectRatio(2 / 3, contentMode: .fill)
                } else {
                    Image(systemName: "film")
                        .resizable()
                        .aspectRatio(2 / 3, contentMode: .fit)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 60, height: 90)
            .clipShape(RoundedRectangle(cornerRadius: 6))

            VStack(alignment: .leading, spacing: 4) {
                Text(result.title)
                    .font(.headline)
                if let releaseDate = result.releaseDate {
                    Text(releaseDate)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if case .failed(let message) = addState {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            Spacer(minLength: 8)

            AddToWatchlistButton(state: addState, onAdd: onAdd)
        }
    }
}

/// The add-to-watchlist affordance for a single search result row. Once a
/// row reaches `.added` it renders a static checkmark rather than a
/// re-tappable button, per MOV-293's "confirmed" state.
private struct AddToWatchlistButton: View {
    let state: SearchViewModel.AddToWatchlistState
    let onAdd: () -> Void

    var body: some View {
        switch state {
        case .idle:
            Button(action: onAdd) {
                Image(systemName: "plus.circle")
                    .font(.title2)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Add to Watchlist")
        case .adding:
            ProgressView()
                .accessibilityLabel("Adding to Watchlist")
        case .added:
            Image(systemName: "checkmark.circle.fill")
                .font(.title2)
                .foregroundStyle(.green)
                .accessibilityLabel("Added to Watchlist")
        case .failed:
            Button(action: onAdd) {
                Image(systemName: "arrow.clockwise.circle")
                    .font(.title2)
                    .foregroundStyle(.red)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Retry adding to Watchlist")
        }
    }
}

private extension MovieSearchResult {
    /// TMDb's public image CDN, keyed off the `posterPath` the search
    /// contract returns (`docs/api/v1-contract.md`). `w200` matches this
    /// row's ~60pt-wide thumbnail without over-fetching.
    var posterURL: URL? {
        guard let posterPath else { return nil }
        return URL(string: "https://image.tmdb.org/t/p/w200\(posterPath)")
    }
}
