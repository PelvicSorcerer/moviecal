import SwiftUI

/// The Watchlist tab: an index of the personal list and every authorized
/// shared list (`GET /api/v1/watchlists`), each pushing its own detail.
struct WatchlistView: View {
    let apiClient: APIClient

    var body: some View {
        NavigationStack {
            WatchlistsIndexScreen(apiClient: apiClient)
        }
    }
}

/// The Watchlist tab's presentational content, factored out of
/// `WatchlistView` so each load state can be rendered and snapshot-tested
/// directly, without depending on a real or mocked network round trip.
struct WatchlistContentView: View {
    let state: WatchlistViewModel.LoadState
    let onRetry: () async -> Void
    var onDelete: (WatchlistItem) async -> Void = { _ in }

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                ProgressView()
            case .loaded(let items) where items.isEmpty:
                ContentUnavailableView(
                    "No Movies Yet",
                    systemImage: "bookmark",
                    description: Text("Movies you add to your watchlist appear here.")
                )
            case .loaded(let items):
                List(items) { item in
                    VStack(alignment: .leading) {
                        Text(item.movie.title)
                            .font(.headline)
                        if let releaseDate = item.movie.releaseDate {
                            Text(releaseDate)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await onDelete(item) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
                .listStyle(.plain)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Couldn't Load Watchlist", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry") {
                        Task { await onRetry() }
                    }
                }
            }
        }
        .refreshable { await onRetry() }
    }
}
