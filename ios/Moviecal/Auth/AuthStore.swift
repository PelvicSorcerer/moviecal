import Auth
import Foundation
import Observation

/// Observable auth state for the app shell, backed by a
/// `SupabaseAuthClientProtocol`. `state` updates itself by observing
/// `authStateChanges`, so a successful `signIn`/`signOut` is reflected
/// automatically once the client emits the corresponding event — callers
/// don't update `state` directly.
@Observable
@MainActor
public final class AuthStore {
    public private(set) var state: AuthState = .unknown

    private let authClient: any SupabaseAuthClientProtocol
    // `Task.cancel()` is safe to call from any thread, and `deinit` on a
    // `@MainActor` class runs nonisolated — this property must be too so
    // `deinit` can cancel the observation loop without hopping actors.
    private nonisolated(unsafe) var observationTask: Task<Void, Never>?

    public init(authClient: any SupabaseAuthClientProtocol) {
        self.authClient = authClient
        observationTask = Task { [weak self] in
            guard let self else { return }
            for await (_, session) in authClient.authStateChanges {
                if Task.isCancelled { return }
                self.apply(session: session)
            }
        }
    }

    deinit {
        observationTask?.cancel()
    }

    /// Signs in with email/password. Throws on invalid credentials or a
    /// transport failure; `state` only changes once the client confirms the
    /// session via `authStateChanges`.
    public func signIn(email: String, password: String) async throws {
        try await authClient.signIn(email: email, password: password)
    }

    /// Signs out and clears the persisted Keychain session.
    public func signOut() async throws {
        try await authClient.signOut()
    }

    private func apply(session: Session?) {
        state = session.map { .signedIn(email: $0.user.email) } ?? .signedOut
    }
}
