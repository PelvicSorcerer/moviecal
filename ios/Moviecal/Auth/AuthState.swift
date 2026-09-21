import Foundation

/// Observable authentication state for the app shell.
public enum AuthState: Equatable, Sendable {
    /// No session has been checked yet (briefly, on launch, before the first
    /// `authStateChanges` event arrives).
    case unknown
    /// No valid session. Includes both "never signed in" and "session
    /// expired/refresh failed" — either way the app must show sign-in again.
    case signedOut
    case signedIn(email: String?)
}
