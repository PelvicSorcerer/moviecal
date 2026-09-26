import SwiftUI

/// The summary list's presentational content, factored out so each load
/// state can be snapshot-tested without a network round trip.
struct WatchlistBrowserContentView: View {
    let state: WatchlistsViewModel.LoadState
    let onRetry: () async -> Void

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                ProgressView()
            case .loaded(let summaries) where summaries.isEmpty:
                ContentUnavailableView(
                    "No Watchlists",
                    systemImage: "bookmark",
                    description: Text("Watchlists you own or are invited to edit appear here.")
                )
            case .loaded(let summaries):
                List {
                    section("Personal", summaries.filter { $0.kind == .personal })
                    section("Shared", summaries.filter { $0.kind == .shared })
                }
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

    @ViewBuilder
    private func section(_ title: String, _ summaries: [WatchlistSummary]) -> some View {
        if !summaries.isEmpty {
            Section(title) {
                ForEach(summaries) { summary in
                    NavigationLink(value: summary) {
                        WatchlistSummaryRow(summary: summary)
                    }
                }
            }
        }
    }
}

/// One list row: name plus a text status, read by VoiceOver as one element.
struct WatchlistSummaryRow: View {
    let summary: WatchlistSummary

    var body: some View {
        Label {
            VStack(alignment: .leading) {
                Text(summary.name)
                    .font(.headline)
                Text(summary.statusText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: summary.systemImage)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A shared list's detail: the caller's role, then its movies (read-only).
struct SharedWatchlistDetailView: View {
    @State var viewModel: SharedWatchlistDetailViewModel
    let onAccessLost: () -> Void
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SharedWatchlistDetailContentView(
            summary: viewModel.summary,
            state: viewModel.state,
            onRetry: { await viewModel.load() }
        )
        .navigationTitle(viewModel.summary.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.load() }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                Task { await viewModel.load() }
            }
        }
        .onChange(of: viewModel.state) { _, newState in
            if newState == .accessLost {
                onAccessLost()
            }
        }
    }
}

struct SharedWatchlistDetailContentView: View {
    let summary: WatchlistSummary
    let state: SharedWatchlistDetailViewModel.LoadState
    let onRetry: () async -> Void

    var body: some View {
        Group {
            switch state {
            case .idle, .loading, .accessLost:
                ProgressView()
            case .loaded(let items):
                List {
                    Section {
                        Label(summary.statusText, systemImage: summary.systemImage)
                    }
                    Section("Movies") {
                        if items.isEmpty {
                            Text("No movies on this watchlist yet.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(items) { item in
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
                    }
                }
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
