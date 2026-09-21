import Foundation
import Observation

/// Drives the email/password sign-in form. `AuthStore.state` (observed by
/// the app shell separately) is the source of truth for whether sign-in
/// succeeded — this view model only tracks the form's own submission state.
@Observable
@MainActor
final class SignInViewModel {
    var email = ""
    var password = ""
    private(set) var isSubmitting = false
    private(set) var errorMessage: String?

    private let authStore: AuthStore

    init(authStore: AuthStore) {
        self.authStore = authStore
    }

    var canSubmit: Bool {
        !isSubmitting && !email.isEmpty && !password.isEmpty
    }

    func signIn() async {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            try await authStore.signIn(email: email, password: password)
        } catch {
            errorMessage = "Unable to sign in. Check your email and password and try again."
        }
    }
}
