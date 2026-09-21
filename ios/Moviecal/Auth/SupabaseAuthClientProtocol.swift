import Auth
import Foundation

/// The subset of `Auth.AuthClient` (from `supabase-swift`) that this app
/// depends on, extracted to a protocol so `AuthStore` and
/// `SupabaseAuthTokenProvider` can be exercised in XCTest against a mocked
/// Supabase interaction instead of a real network-backed client.
public protocol SupabaseAuthClientProtocol: Sendable {
    /// The locally persisted session, if any. May be expired — unlike
    /// `session()`, this never performs a refresh or a network call.
    var currentSession: Session? { get }

    /// Emits the current session immediately, then again whenever sign-in,
    /// sign-out, or a token refresh changes it.
    var authStateChanges: AsyncStream<(event: AuthChangeEvent, session: Session?)> { get }

    /// Returns a session guaranteed not to be expired, refreshing it against
    /// Supabase if needed. Throws if there is no session, or if the refresh
    /// token itself is no longer valid — callers must treat that as a signal
    /// to re-authenticate rather than retry silently.
    func session() async throws -> Session

    @discardableResult
    func signIn(email: String, password: String) async throws -> Session

    func signOut() async throws
}
