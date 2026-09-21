import Foundation

/// Concrete `AuthTokenProviding` backed by Supabase auth. Every call asks the
/// auth client for a non-expired session, refreshing it against Supabase if
/// needed; per `docs/api/v1-contract.md` the `v1` API layer itself never
/// refreshes a bearer token, so if the session's refresh token has also
/// expired, this throws rather than returning a stale or empty token —
/// callers must surface that as a need to re-authenticate.
public struct SupabaseAuthTokenProvider: AuthTokenProviding {
    private let authClient: any SupabaseAuthClientProtocol

    public init(authClient: any SupabaseAuthClientProtocol) {
        self.authClient = authClient
    }

    public func currentAccessToken() async throws -> String {
        let session = try await authClient.session()
        return session.accessToken
    }
}
