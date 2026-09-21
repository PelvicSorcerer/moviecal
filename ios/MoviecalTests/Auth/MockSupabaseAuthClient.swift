import Auth
import Foundation
@testable import Moviecal

/// Test double for `SupabaseAuthClientProtocol`. Scripts sign-in/sign-out/
/// session results and drives `authStateChanges` the way the real
/// `Auth.AuthClient` would (sign-in success emits `.signedIn`, sign-out
/// emits `.signedOut`), so `AuthStore` can be exercised end to end without a
/// real Supabase project, network access, or the Keychain.
final class MockSupabaseAuthClient: SupabaseAuthClientProtocol, @unchecked Sendable {
    enum MockError: Error, Equatable {
        case notConfigured
    }

    private(set) var currentSession: Session?
    let authStateChanges: AsyncStream<(event: AuthChangeEvent, session: Session?)>
    private let continuation: AsyncStream<(event: AuthChangeEvent, session: Session?)>.Continuation

    var signInResult: Result<Session, Error> = .failure(MockError.notConfigured)
    var signOutError: Error?
    var sessionResult: Result<Session, Error> = .failure(MockError.notConfigured)

    private(set) var signInCallCount = 0
    private(set) var signOutCallCount = 0
    private(set) var sessionCallCount = 0

    init() {
        (authStateChanges, continuation) = AsyncStream.makeStream()
    }

    /// Pushes an event onto `authStateChanges`, as sign-in/sign-out/refresh
    /// would inside the real client.
    func emit(_ event: AuthChangeEvent, session: Session?) {
        currentSession = session
        continuation.yield((event, session))
    }

    func session() async throws -> Session {
        sessionCallCount += 1
        return try sessionResult.get()
    }

    @discardableResult
    func signIn(email: String, password: String) async throws -> Session {
        signInCallCount += 1
        let session = try signInResult.get()
        emit(.signedIn, session: session)
        return session
    }

    func signOut() async throws {
        signOutCallCount += 1
        if let signOutError {
            throw signOutError
        }
        emit(.signedOut, session: nil)
    }
}

extension MockSupabaseAuthClient {
    static func makeSession(
        email: String? = "person@example.com",
        accessToken: String = "test-access-token"
    ) -> Session {
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
            accessToken: accessToken,
            tokenType: "bearer",
            expiresIn: 3600,
            expiresAt: now.addingTimeInterval(3600).timeIntervalSince1970,
            refreshToken: "test-refresh-token",
            user: user
        )
    }
}
