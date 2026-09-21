#if DEBUG
import Auth
import Foundation

/// Deterministic in-memory `SupabaseAuthClientProtocol` used only to drive
/// the sign-in → main-tabs XCUITest happy path without a live Supabase
/// project. Compiled into Debug builds only, and only activated when the
/// `-UITestMockAuth` launch argument is present (see `MoviecalApp`) — never
/// reachable in a Release build or an ordinary Debug launch.
final class UITestFakeSupabaseAuthClient: SupabaseAuthClientProtocol, @unchecked Sendable {
    enum Failure: Error {
        case noSession
    }

    private(set) var currentSession: Session?
    let authStateChanges: AsyncStream<(event: AuthChangeEvent, session: Session?)>
    private let continuation: AsyncStream<(event: AuthChangeEvent, session: Session?)>.Continuation

    init() {
        (authStateChanges, continuation) = AsyncStream.makeStream()
        continuation.yield((.initialSession, nil))
    }

    func session() async throws -> Session {
        guard let currentSession else {
            throw Failure.noSession
        }
        return currentSession
    }

    @discardableResult
    func signIn(email: String, password: String) async throws -> Session {
        let session = Self.makeSession(email: email)
        currentSession = session
        continuation.yield((.signedIn, session))
        return session
    }

    func signOut() async throws {
        currentSession = nil
        continuation.yield((.signedOut, nil))
    }

    private static func makeSession(email: String) -> Session {
        let now = Date()
        let user = User(
            id: UUID(),
            appMetadata: [:],
            userMetadata: [:],
            aud: "authenticated",
            email: email,
            createdAt: now,
            updatedAt: now
        )
        return Session(
            accessToken: "uitest-access-token",
            tokenType: "bearer",
            expiresIn: 3600,
            expiresAt: now.addingTimeInterval(3600).timeIntervalSince1970,
            refreshToken: "uitest-refresh-token",
            user: user
        )
    }
}
#endif
