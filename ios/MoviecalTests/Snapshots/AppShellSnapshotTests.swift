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

    func testSearchSnapshot() {
        assertSnapshot(of: SearchView(), named: "Search")
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
        let url = URL(string: "https://moviecal.example/api/calendar/AbC123SecretToken")!
        assertSnapshot(
            of: Form { Section("Calendar Subscription") { CalendarSubscriptionSectionView(state: .loaded(url), onRetry: {}) } },
            named: "CalendarSubscription-Loaded"
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
