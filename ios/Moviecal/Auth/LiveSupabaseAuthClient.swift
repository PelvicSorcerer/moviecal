import Auth
import Foundation

/// Adapts `supabase-swift`'s `Auth.AuthClient` to `SupabaseAuthClientProtocol`.
public struct LiveSupabaseAuthClient: SupabaseAuthClientProtocol {
    private let client: AuthClient

    public init(client: AuthClient) {
        self.client = client
    }

    public var currentSession: Session? {
        client.currentSession
    }

    public var authStateChanges: AsyncStream<(event: AuthChangeEvent, session: Session?)> {
        client.authStateChanges
    }

    public func session() async throws -> Session {
        try await client.session
    }

    @discardableResult
    public func signIn(email: String, password: String) async throws -> Session {
        try await client.signIn(email: email, password: password)
    }

    public func signOut() async throws {
        try await client.signOut()
    }
}

extension LiveSupabaseAuthClient {
    /// Builds the app's `AuthClient`, storing its session exclusively in the
    /// Keychain (`Auth.KeychainLocalStorage`) under a Moviecal-specific
    /// service name, and enabling background token refresh so
    /// `SupabaseAuthTokenProvider` can hand the `v1` API client a valid
    /// access token without the `v1` layer ever refreshing it itself.
    public static func moviecal(configuration: SupabaseAuthConfiguration) -> LiveSupabaseAuthClient {
        let client = AuthClient(
            configuration: AuthClient.Configuration(
                url: configuration.projectURL.appendingPathComponent("auth/v1"),
                headers: ["apikey": configuration.anonKey],
                localStorage: KeychainLocalStorage(service: "com.moviecal.ios.supabase-auth"),
                autoRefreshToken: true
            )
        )
        return LiveSupabaseAuthClient(client: client)
    }
}
