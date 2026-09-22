import SwiftUI

/// The Search tab: debounced TMDb movie search over
/// `GET /api/v1/movies/search` (read-only — adding a result to the
/// watchlist is a separate, later feature).
struct SearchView: View {
    @State private var viewModel: SearchViewModel

    init(apiClient: APIClient) {
        _viewModel = State(initialValue: SearchViewModel(apiClient: apiClient))
    }

    var body: some View {
        NavigationStack {
            SearchContentView(state: viewModel.state) {
                await viewModel.retry()
            }
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
    let onRetry: () async -> Void

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
                    SearchResultRow(result: result)
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
            }
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
