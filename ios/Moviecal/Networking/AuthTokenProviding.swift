import Foundation

/// Supplies the bearer token injected into every `v1` request. Implementations
/// own how the token is obtained and cached (e.g. from Supabase auth).
///
/// The networking layer never calls back into this protocol to refresh a
/// token after a `401` — `docs/api/v1-contract.md` requires no silent
/// refresh, so an expired token must surface to the caller as
/// `APIClientError.authenticationExpired` instead.
public protocol AuthTokenProviding {
    func currentAccessToken() async throws -> String
}
