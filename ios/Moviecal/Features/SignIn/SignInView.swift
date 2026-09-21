import SwiftUI

/// The signed-out entry point. A plain SwiftUI `Form` with no custom
/// navigation chrome, per the app-shell's HIG-aligned navigation contract.
struct SignInView: View {
    @State private var viewModel: SignInViewModel

    init(authStore: AuthStore) {
        _viewModel = State(initialValue: SignInViewModel(authStore: authStore))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $viewModel.email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("signIn.email")
                    SecureField("Password", text: $viewModel.password)
                        .textContentType(.password)
                        .accessibilityIdentifier("signIn.password")
                }

                if let errorMessage = viewModel.errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await viewModel.signIn() }
                    } label: {
                        if viewModel.isSubmitting {
                            ProgressView()
                        } else {
                            Text("Sign In")
                        }
                    }
                    .disabled(!viewModel.canSubmit)
                    .accessibilityIdentifier("signIn.submit")
                }
            }
            .navigationTitle("Moviecal")
        }
    }
}
