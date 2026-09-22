import Foundation
import SwiftUI

/// `authStore`/`apiClient` depend on parsing the app's Info.plist
/// configuration, which is static per build but not statically provable at
/// compile time. A parse failure here means the shipped build itself is
/// misconfigured -- not something the app can recover from by retrying --
/// but per MOV-107 review feedback it must still surface as a graceful
/// screen (`ConfigurationErrorView`), never a `try!` crash on every launch.
@MainActor
private struct AppDependencies {
    let authStore: AuthStore
    let apiClient: APIClient

    init() throws {
        let authClient = try Self.makeAuthClient()
        let store = AuthStore(authClient: authClient)
        authStore = store
        apiClient = APIClient(
            environment: try APIEnvironment.fromInfoPlist(),
            tokenProvider: SupabaseAuthTokenProvider(authClient: authClient)
        )
    }

    private static func makeAuthClient() throws -> any SupabaseAuthClientProtocol {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-UITestMockAuth") {
            return UITestFakeSupabaseAuthClient()
        }
        #endif
        return LiveSupabaseAuthClient.moviecal(configuration: try SupabaseAuthConfiguration.fromInfoPlist())
    }
}

@main
struct MoviecalApp: App {
    private let dependencies: Result<AppDependencies, Error>

    init() {
        dependencies = Result { try AppDependencies() }
    }

    var body: some Scene {
        WindowGroup {
            switch dependencies {
            case .success(let dependencies):
                RootView(authStore: dependencies.authStore, apiClient: dependencies.apiClient)
            case .failure(let error):
                ConfigurationErrorView(error: error)
            }
        }
    }
}
