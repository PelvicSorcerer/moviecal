import SwiftUI

/// The app's auth gate: renders `SignInView` while signed out and
/// `MainTabView` once `AuthStore` reports a signed-in session, switching
/// automatically as `authStore.state` changes.
struct RootView: View {
    let authStore: AuthStore
    let apiClient: APIClient

    var body: some View {
        switch authStore.state {
        case .unknown:
            ProgressView()
        case .signedOut:
            SignInView(authStore: authStore)
        case .signedIn:
            MainTabView(apiClient: apiClient, authStore: authStore)
        }
    }
}
