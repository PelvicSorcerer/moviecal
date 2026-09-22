import SwiftUI

/// The signed-in app shell: standard `TabView` navigation across the three
/// v1 feature areas, each in its own `NavigationStack` per HIG guidance.
struct MainTabView: View {
    let apiClient: APIClient
    let authStore: AuthStore

    var body: some View {
        TabView {
            SearchView()
                .tabItem {
                    Label("Search", systemImage: "magnifyingglass")
                }

            WatchlistView(apiClient: apiClient)
                .tabItem {
                    Label("Watchlist", systemImage: "bookmark")
                }

            SettingsView(authStore: authStore)
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
        }
    }
}
