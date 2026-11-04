import SwiftUI

extension WatchlistSummary {
    /// Plain-language ownership/sharing description, shown under the name and
    /// used as part of the VoiceOver label so state never relies on color or icon.
    var roleDescription: String {
        switch (kind, role) {
        case (.personal, _): "Personal"
        case (.shared, .owner): "Shared · You own this list"
        case (.shared, .editor): "Shared with you · Editor"
        }
    }

    var iconName: String {
        kind == .personal ? "bookmark" : "person.2"
    }
}

/// The Watchlist tab's index of every list the caller may read, with a
/// destination per list. Reloads whenever the app becomes active so a list
/// whose access was revoked while backgrounded disappears.
struct WatchlistsIndexScreen: View {
    @State private var viewModel: WatchlistsViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var isCreating = false
    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
        _viewModel = State(initialValue: WatchlistsViewModel(apiClient: apiClient))
    }

    var body: some View {
        WatchlistsContentView(
            state: viewModel.state,
            onRetry: { await viewModel.load() }
        )
        .navigationTitle("Watchlist")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    isCreating = true
                } label: {
                    Label("New Shared List", systemImage: "plus")
                }
                .accessibilityIdentifier("new-shared-list-button")
            }
        }
        .sheet(isPresented: $isCreating) {
            WatchlistNameEditorView(
                viewModel: WatchlistNameEditorViewModel(mode: .create, apiClient: apiClient),
                onFinish: { _ in await viewModel.load() }
            )
        }
        .navigationDestination(for: WatchlistSummary.self) { summary in
            if summary.kind == .personal {
                PersonalWatchlistScreen(apiClient: apiClient)
            } else {
                SharedWatchlistDetailScreen(
                    summary: summary,
                    apiClient: apiClient,
                    onUnavailable: { await viewModel.load() }
                )
            }
        }
        .task(id: scenePhase) {
            if scenePhase == .active {
                await viewModel.load()
            }
        }
    }
}

struct WatchlistsContentView: View {
    let state: WatchlistsViewModel.LoadState
    let onRetry: () async -> Void

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                ProgressView()
            case .loaded(let lists) where lists.isEmpty:
                ContentUnavailableView(
                    "No Watchlists",
                    systemImage: "bookmark",
                    description: Text("Your watchlists appear here.")
                )
            case .loaded(let lists):
                List(lists) { summary in
                    NavigationLink(value: summary) {
                        WatchlistSummaryRow(summary: summary)
                    }
                }
                .listStyle(.insetGrouped)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Couldn't Load Watchlists", systemImage: "exclamationmark.triangle")
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

struct WatchlistSummaryRow: View {
    let summary: WatchlistSummary

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: summary.iconName)
                .foregroundStyle(.tint)
                .frame(minWidth: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(summary.kind == .personal ? "My Watchlist" : summary.name)
                    .font(.headline)
                Text(summary.roleDescription)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Existing single-list personal screen (add/remove via the singular
/// `/api/v1/watchlist` API), pushed from the personal row.
struct PersonalWatchlistScreen: View {
    @State private var viewModel: WatchlistViewModel

    init(apiClient: APIClient) {
        _viewModel = State(initialValue: WatchlistViewModel(apiClient: apiClient))
    }

    var body: some View {
        WatchlistContentView(
            state: viewModel.state,
            onRetry: { await viewModel.load() },
            onDelete: { item in await viewModel.remove(item: item) }
        )
        .navigationTitle("My Watchlist")
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

/// A shared list's items (read-only). If the list was deleted or access was
/// revoked it pops back to the index and asks it to refresh.
struct SharedWatchlistDetailScreen: View {
    let summary: WatchlistSummary
    let onUnavailable: () async -> Void

    @State private var viewModel: WatchlistDetailViewModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var isRenaming = false
    @State private var currentName: String?
    private let apiClient: APIClient

    init(summary: WatchlistSummary, apiClient: APIClient, onUnavailable: @escaping () async -> Void) {
        self.summary = summary
        self.onUnavailable = onUnavailable
        self.apiClient = apiClient
        _viewModel = State(
            initialValue: WatchlistDetailViewModel(watchlistId: summary.id, apiClient: apiClient)
        )
    }

    var body: some View {
        WatchlistDetailContentView(
            state: viewModel.state,
            onRetry: { await viewModel.load() }
        )
        .navigationTitle(displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if summary.kind == .shared && summary.canEdit {
                ToolbarItem(placement: .primaryAction) {
                    Button("Rename") { isRenaming = true }
                        .accessibilityIdentifier("rename-shared-list-button")
                }
            }
        }
        .sheet(isPresented: $isRenaming) {
            WatchlistNameEditorView(
                viewModel: WatchlistNameEditorViewModel(
                    mode: .rename(id: summary.id),
                    initialName: displayName,
                    apiClient: apiClient
                ),
                onFinish: { outcome in
                    switch outcome {
                    case .saved(let saved):
                        currentName = saved.name
                        await viewModel.load()
                        await refreshIndex()
                    case .accessLost:
                        dismiss()
                        await onUnavailable()
                    }
                }
            )
        }
        .task(id: scenePhase) {
            if scenePhase == .active {
                await viewModel.load()
            }
        }
        .onChange(of: viewModel.state) { _, newState in
            if newState == .unavailable {
                dismiss()
                Task { await onUnavailable() }
            }
        }
    }
}

extension SharedWatchlistDetailScreen {
    /// The freshest known name: the loaded detail, else a just-saved rename,
    /// else the name from the index row.
    fileprivate var displayName: String {
        if case .loaded(let detail) = viewModel.state { return detail.watchlist.name }
        return currentName ?? summary.name
    }

    /// Refreshes the index too so its row shows the same name.
    fileprivate func refreshIndex() async {
        await onUnavailable()
    }
}

struct WatchlistDetailContentView: View {
    let state: WatchlistDetailViewModel.LoadState
    let onRetry: () async -> Void

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                ProgressView()
            case .unavailable:
                ContentUnavailableView(
                    "Watchlist Unavailable",
                    systemImage: "lock",
                    description: Text("This watchlist was removed or you no longer have access.")
                )
            case .loaded(let detail) where detail.items.isEmpty:
                ContentUnavailableView(
                    "No Movies Yet",
                    systemImage: "bookmark",
                    description: Text("Movies added to this list appear here.")
                )
                .safeAreaInset(edge: .top) { header(detail.watchlist) }
            case .loaded(let detail):
                List {
                    Section {
                        ForEach(detail.items) { item in
                            VStack(alignment: .leading) {
                                Text(item.movie.title)
                                    .font(.headline)
                                if let releaseDate = item.movie.releaseDate {
                                    Text(releaseDate)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .accessibilityElement(children: .combine)
                        }
                    } header: {
                        Text(detail.watchlist.roleDescription)
                    }
                }
                .listStyle(.insetGrouped)
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

    private func header(_ watchlist: WatchlistSummary) -> some View {
        Text(watchlist.roleDescription)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.top, 8)
    }
}
