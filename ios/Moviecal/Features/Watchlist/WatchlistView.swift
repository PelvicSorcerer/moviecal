import SwiftUI

/// The Watchlist tab: lists every personal and shared watchlist the caller
/// may read (`GET /api/v1/watchlists`) and pushes the selected list's detail.
struct WatchlistView: View {
    @State private var viewModel: WatchlistsViewModel
    @State private var path: [WatchlistSummary] = []
    @Environment(\.scenePhase) private var scenePhase
    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
        _viewModel = State(initialValue: WatchlistsViewModel(apiClient: apiClient))
    }

    var body: some View {
        NavigationStack(path: $path) {
            WatchlistBrowserContentView(
                state: viewModel.state,
                onRetry: { await viewModel.load() }
            )
            .navigationTitle("Watchlists")
            .navigationDestination(for: WatchlistSummary.self) { summary in
                switch summary.kind {
                case .personal:
                    PersonalWatchlistView(apiClient: apiClient, title: summary.name)
                case .shared:
                    SharedWatchlistDetailView(
                        viewModel: SharedWatchlistDetailViewModel(summary: summary, apiClient: apiClient),
                        onAccessLost: {
                            path.removeAll { $0.id == summary.id }
                            Task { await viewModel.noteAccessLost(to: summary) }
                        }
                    )
                }
            }
            .task { await viewModel.load() }
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    Task { await viewModel.load() }
                }
            }
            .onChange(of: viewModel.state) { _, newState in
                // Exit any open detail whose list is no longer authorized.
                switch newState {
                case .loaded(let summaries):
                    path.removeAll { open in !summaries.contains { $0.id == open.id } }
                case .failed:
                    path.removeAll()
                case .idle, .loading:
                    break
                }
            }
            .alert(
                "Watchlist Unavailable",
                isPresented: Binding(
                    get: { viewModel.accessLostMessage != nil },
                    set: { isPresented in
                        if !isPresented {
                            viewModel.dismissAccessLostMessage()
                        }
                    }
                ),
                actions: {
                    Button("OK", role: .cancel) {}
                },
                message: {
                    Text(viewModel.accessLostMessage ?? "")
                }
            )
        }
    }
}

/// The caller's personal watchlist (`/api/v1/watchlist`), including item
/// removal, unchanged from before shared lists were browsable.
struct PersonalWatchlistView: View {
    @State private var viewModel: WatchlistViewModel
    private let title: String

    init(apiClient: APIClient, title: String = "Watchlist") {
        _viewModel = State(initialValue: WatchlistViewModel(apiClient: apiClient))
        self.title = title
    }

    var body: some View {
        WatchlistContentView(
            state: viewModel.state,
            onRetry: { await viewModel.load() },
            onDelete: { item in await viewModel.remove(item: item) }
        )
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.load() }
        .alert(
            "Couldn't Remove Item",
            isPresented: Binding(
                get: { viewModel.removalErrorMessage != nil },
                set: { isPresented in
                    if !isPresented {
                        viewModel.dismissRemovalError()
                    }
                }
            ),
            actions: {
                Button("OK", role: .cancel) {}
            },
            message: {
                Text(viewModel.removalErrorMessage ?? "")
            }
        )
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
