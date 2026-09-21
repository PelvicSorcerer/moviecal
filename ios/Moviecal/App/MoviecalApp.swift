import Foundation
import SwiftUI

@main
struct MoviecalApp: App {
    private let authStore: AuthStore
    private let apiClient: APIClient

    init() {
        let authClient = Self.makeAuthClient()
        let store = AuthStore(authClient: authClient)
        authStore = store
        apiClient = APIClient(
            environment: try! APIEnvironment.fromInfoPlist(),
            tokenProvider: SupabaseAuthTokenProvider(authClient: authClient)
        )
    }

    var body: some Scene {
        WindowGroup {
            RootView(authStore: authStore, apiClient: apiClient)
        }
    }

    private static func makeAuthClient() -> any SupabaseAuthClientProtocol {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-UITestMockAuth") {
            return UITestFakeSupabaseAuthClient()
        }
        #endif
        return LiveSupabaseAuthClient.moviecal(configuration: try! SupabaseAuthConfiguration.fromInfoPlist())
    }
}
