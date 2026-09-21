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

    func testSettingsSnapshotWhenSignedIn() async {
        let mockClient = MockSupabaseAuthClient()
        let authStore = AuthStore(authClient: mockClient)
        mockClient.emit(.initialSession, session: MockSupabaseAuthClient.makeSession(email: "person@example.com"))
        await waitForSignedIn(authStore, email: "person@example.com")

        assertSnapshot(of: SettingsView(authStore: authStore), named: "Settings")
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
