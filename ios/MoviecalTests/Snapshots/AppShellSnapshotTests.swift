import SwiftUI
import XCTest
@testable import Moviecal

/// Snapshot coverage for the stable app-shell screens added in the
/// navigation-shell issue: the signed-out entry point and each of the
/// three signed-in tabs' placeholder/content states.
@MainActor
final class AppShellSnapshotTests: XCTestCase {
    private func waitForSignedIn(_ authStore: AuthStore, email: String) async {
        let deadline = Date().addingTimeInterval(1)
        while authStore.state != .signedIn(email: email) && Date() < deadline {
            await Task.yield()
        }
    }

    func testSignInSnapshot() {
        let authStore = AuthStore(authClient: MockSupabaseAuthClient())
        assertSnapshot(of: SignInView(authStore: authStore), named: "SignIn")
    }

    func testSearchIdleSnapshot() {
        assertSnapshot(of: SearchContentView(state: .idle, onRetry: {}), named: "Search-Idle")
    }

    func testSearchNoResultsSnapshot() {
        assertSnapshot(of: SearchContentView(state: .noResults, onRetry: {}), named: "Search-NoResults")
    }

    func testSearchWithResultsSnapshot() {
        let result = MovieSearchResult(
            tmdbId: 603,
            title: "The Matrix",
            releaseDate: "1999-03-31",
            posterPath: nil,
            overview: "A hacker discovers the truth."
        )
        assertSnapshot(of: SearchContentView(state: .loaded([result]), onRetry: {}), named: "Search-WithResults")
    }

    func testSearchWithResultsAddedSnapshot() {
        let result = MovieSearchResult(
            tmdbId: 603,
            title: "The Matrix",
            releaseDate: "1999-03-31",
            posterPath: nil,
            overview: "A hacker discovers the truth."
        )
        assertSnapshot(
            of: SearchContentView(
                state: .loaded([result]),
                addToWatchlistStates: [603: .added],
                onRetry: {}
            ),
            named: "Search-WithResults-Added"
        )
    }

    func testSearchFailedSnapshot() {
        assertSnapshot(
            of: SearchContentView(state: .failed("Unable to search movies. Try again."), onRetry: {}),
            named: "Search-Failed"
        )
    }

    private func makeAPIClient() -> APIClient {
        APIClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.moviecal.test")!),
            tokenProvider: SnapshotStubTokenProvider(),
            session: MockURLProtocol.makeSession()
        )
    }

    func testSettingsSnapshotWhenSignedIn() async {
        let mockClient = MockSupabaseAuthClient()
        let authStore = AuthStore(authClient: mockClient)
        mockClient.emit(.initialSession, session: MockSupabaseAuthClient.makeSession(email: "person@example.com"))
        await waitForSignedIn(authStore, email: "person@example.com")

        // Rendering happens synchronously before the view's `.task` runs, so
        // this captures the calendar section's idle/loading appearance
        // regardless of whether a request handler is registered.
        assertSnapshot(of: SettingsView(apiClient: makeAPIClient(), authStore: authStore), named: "Settings")
    }

    func testCalendarSubscriptionLoadingSnapshot() {
        assertSnapshot(
            of: Form { Section("Calendar Subscription") { CalendarSubscriptionSectionView(state: .loading, onRetry: {}) } },
            named: "CalendarSubscription-Loading"
        )
    }

    func testCalendarSubscriptionLoadedSnapshot() {
        let url = URL(string: "https://calendar.example.test/")!
        assertSnapshot(
            of: Form { Section("Calendar Subscription") { CalendarSubscriptionSectionView(state: .loaded(url), onRetry: {}) } },
            named: "CalendarSubscription-Loaded"
        )
    }

    func testCalendarSubscriptionRotateConfirmationSnapshot() {
        let url = URL(string: "https://calendar.example.test/")!
        assertSnapshot(
            of: Form {
                Section("Calendar Subscription") {
                    CalendarSubscriptionSectionView(
                        state: .loaded(url),
                        isConfirmingRotation: true,
                        onRetry: {}
                    )
                }
            },
            named: "CalendarSubscription-RotateConfirm"
        )
    }

    func testCalendarSubscriptionRotatedSnapshot() {
        let url = URL(string: "https://calendar.example.test/rotated")!
        assertSnapshot(
            of: Form {
                Section("Calendar Subscription") {
                    CalendarSubscriptionSectionView(state: .loaded(url), onRetry: {})
                }
            },
            named: "CalendarSubscription-Rotated"
        )
    }

    func testCalendarSubscriptionErrorSnapshot() {
        assertSnapshot(
            of: Form {
                Section("Calendar Subscription") {
                    CalendarSubscriptionSectionView(state: .failed("Unable to load your calendar subscription link. Try again."), onRetry: {})
                }
            },
            named: "CalendarSubscription-Error"
        )
    }

    private var sampleLists: [WatchlistSummary] {
        [
            WatchlistSummary(id: "p1", kind: .personal, name: "Watchlist", ownerUserId: "u1", role: .owner, canEdit: true),
            WatchlistSummary(id: "s1", kind: .shared, name: "Movie Night", ownerUserId: "u1", role: .owner, canEdit: true),
            WatchlistSummary(id: "s2", kind: .shared, name: "Family Picks", ownerUserId: "u2", role: .editor, canEdit: true),
        ]
    }

    func testWatchlistsIndexSnapshot() {
        assertSnapshot(
            of: NavigationStack {
                WatchlistsContentView(state: .loaded(sampleLists), onRetry: {})
                    .navigationTitle("Watchlist")
            },
            named: "Watchlists-Index"
        )
    }

    func testWatchlistsIndexPersonalOnlySnapshot() {
        assertSnapshot(
            of: NavigationStack {
                WatchlistsContentView(state: .loaded([sampleLists[0]]), onRetry: {})
                    .navigationTitle("Watchlist")
            },
            named: "Watchlists-PersonalOnly"
        )
    }

    func testWatchlistsIndexEmptySnapshot() {
        assertSnapshot(of: WatchlistsContentView(state: .loaded([]), onRetry: {}), named: "Watchlists-Empty")
    }

    func testWatchlistsIndexErrorSnapshot() {
        assertSnapshot(
            of: WatchlistsContentView(state: .failed("Unable to load your watchlists. Pull to refresh to try again."), onRetry: {}),
            named: "Watchlists-Error"
        )
    }

    func testWatchlistsIndexLargeTextDarkSnapshot() {
        assertSnapshot(
            of: NavigationStack {
                WatchlistsContentView(state: .loaded(sampleLists), onRetry: {})
                    .navigationTitle("Watchlist")
            }
            .dynamicTypeSize(.accessibility3)
            .preferredColorScheme(.dark),
            named: "Watchlists-LargeText-Dark"
        )
    }

    private func sampleDetail(_ summary: WatchlistSummary, items: [WatchlistItem]) -> WatchlistDetailViewModel.LoadState {
        .loaded(WatchlistDetail(watchlist: summary, items: items))
    }

    private var sampleItem: WatchlistItem {
        WatchlistItem(
            id: "i1",
            addedAt: "2026-06-13T05:00:00.000Z",
            movie: Movie(id: 42, tmdbId: 603, title: "The Matrix", releaseDate: "1999-03-31", posterPath: nil, overview: nil)
        )
    }

    func testSharedDetailOwnerSnapshot() {
        assertSnapshot(
            of: NavigationStack {
                WatchlistDetailContentView(state: sampleDetail(sampleLists[1], items: [sampleItem]), onRetry: {})
                    .navigationTitle("Movie Night")
                    .navigationBarTitleDisplayMode(.inline)
            },
            named: "WatchlistDetail-Owner"
        )
    }

    func testSharedDetailEditorSnapshot() {
        assertSnapshot(
            of: NavigationStack {
                WatchlistDetailContentView(state: sampleDetail(sampleLists[2], items: [sampleItem]), onRetry: {})
                    .navigationTitle("Family Picks")
                    .navigationBarTitleDisplayMode(.inline)
            },
            named: "WatchlistDetail-Editor"
        )
    }

    func testSharedDetailEmptySnapshot() {
        assertSnapshot(
            of: WatchlistDetailContentView(state: sampleDetail(sampleLists[2], items: []), onRetry: {}),
            named: "WatchlistDetail-Empty"
        )
    }

    func testSharedDetailErrorSnapshot() {
        assertSnapshot(
            of: WatchlistDetailContentView(state: .failed("Unable to load this watchlist. Pull to refresh to try again."), onRetry: {}),
            named: "WatchlistDetail-Error"
        )
    }

    func testSharedDetailUnavailableSnapshot() {
        assertSnapshot(
            of: WatchlistDetailContentView(state: .unavailable, onRetry: {}),
            named: "WatchlistDetail-Unavailable"
        )
    }

    func testWatchlistEmptySnapshot() {
        assertSnapshot(of: WatchlistContentView(state: .loaded([]), onRetry: {}), named: "Watchlist-Empty")
    }

    func testWatchlistWithItemsSnapshot() {
        let item = WatchlistItem(
            id: "watchlist-item-1",
            addedAt: "2026-06-13T05:00:00.000Z",
            movie: Movie(
                id: 42,
                tmdbId: 603,
                title: "The Matrix",
                releaseDate: "1999-03-31",
                posterPath: nil,
                overview: nil
            )
        )
        assertSnapshot(of: WatchlistContentView(state: .loaded([item]), onRetry: {}), named: "Watchlist-WithItems")
    }
}

private struct SnapshotStubTokenProvider: AuthTokenProviding {
    func currentAccessToken() async throws -> String {
        "test-access-token"
    }
}
