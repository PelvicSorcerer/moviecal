import SwiftUI

/// Placeholder settings tab. Calendar-subscription management is a later
/// feature issue — this proves the tab's shell and exercises sign-out.
struct SettingsView: View {
    let authStore: AuthStore

    @State private var isSigningOut = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if case .signedIn(let email) = authStore.state, let email {
                    Section {
                        LabeledContent("Email", value: email)
                    }
                }

                Section {
                    Button("Sign Out", role: .destructive) {
                        Task { await signOut() }
                    }
                    .disabled(isSigningOut)
                    .accessibilityIdentifier("settings.signOut")
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }

    private func signOut() async {
        isSigningOut = true
        defer { isSigningOut = false }
        do {
            try await authStore.signOut()
        } catch {
            errorMessage = "Unable to sign out. Try again."
        }
    }
}
