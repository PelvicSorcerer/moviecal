import SwiftUI

/// Form sheet for creating a shared list or renaming one.
struct WatchlistNameEditorView: View {
    @State private var viewModel: WatchlistNameEditorViewModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var nameFocused: Bool
    private let onFinish: (WatchlistNameEditorViewModel.Outcome) async -> Void

    init(
        viewModel: WatchlistNameEditorViewModel,
        onFinish: @escaping (WatchlistNameEditorViewModel.Outcome) async -> Void
    ) {
        _viewModel = State(initialValue: viewModel)
        self.onFinish = onFinish
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $viewModel.name)
                        .focused($nameFocused)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                        .onSubmit { Task { await save() } }
                        .onChange(of: viewModel.name) { _, _ in viewModel.clearError() }
                        .accessibilityIdentifier("watchlist-name-field")
                } footer: {
                    if let message = viewModel.errorMessage {
                        Text(message)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("watchlist-name-error")
                    } else if viewModel.mode != .create {
                        Text("Everyone on this list sees the new name.")
                    }
                }
            }
            .navigationTitle(viewModel.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(viewModel.mode == .create ? "Create" : "Save") {
                        Task { await save() }
                    }
                    .disabled(!viewModel.canSubmit)
                }
            }
            .disabled(viewModel.isSaving)
            .onAppear { nameFocused = true }
        }
    }

    private func save() async {
        guard let outcome = await viewModel.submit() else { return }
        dismiss()
        await onFinish(outcome)
    }
}
