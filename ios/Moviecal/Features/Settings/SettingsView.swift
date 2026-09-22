import SwiftUI

/// Settings tab: account info, sign-out, and (MOV-291/MOV-295) view, share,
/// and rotate of the calendar subscription link.
struct SettingsView: View {
    let authStore: AuthStore

    @State private var calendarViewModel: CalendarSubscriptionViewModel
    @State private var isSigningOut = false
    @State private var errorMessage: String?

    init(apiClient: APIClient, authStore: AuthStore) {
        self.authStore = authStore
        _calendarViewModel = State(initialValue: CalendarSubscriptionViewModel(apiClient: apiClient))
    }

    var body: some View {
        NavigationStack {
            Form {
                if case .signedIn(let email) = authStore.state, let email {
                    Section {
                        LabeledContent("Email", value: email)
                    }
                }

                Section("Calendar Subscription") {
                    CalendarSubscriptionSectionView(
                        state: calendarViewModel.state,
                        isConfirmingRotation: calendarViewModel.isConfirmingRotation,
                        isRotating: calendarViewModel.isRotating,
                        rotationErrorMessage: calendarViewModel.rotationErrorMessage,
                        onRetry: { await calendarViewModel.load() },
                        onRequestRotation: { calendarViewModel.requestRotation() },
                        onCancelRotation: { calendarViewModel.cancelRotation() },
                        onConfirmRotation: { await calendarViewModel.confirmRotation() }
                    )
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
            .task { await calendarViewModel.load() }
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

/// The calendar-subscription section's content, factored out of
/// `SettingsView` so each load state can be rendered and snapshot-tested
/// directly. The real `subscriptionUrl` is a bearer credential for the feed
/// (`docs/api/v1-contract.md`): this view only ever displays a masked
/// representation of it, and the real URL is exposed solely through the
/// user-triggered `ShareLink` share sheet — never logged, never shown as
/// plain text that could be screenshotted and shared unintentionally.
///
/// Rotation's confirmation prompt is rendered inline (rather than a system
/// `.alert`/`.confirmationDialog`) so it participates in the same
/// state-driven rendering — and snapshot coverage — as every other state
/// here.
struct CalendarSubscriptionSectionView: View {
    let state: CalendarSubscriptionViewModel.LoadState
    var isConfirmingRotation: Bool = false
    var isRotating: Bool = false
    var rotationErrorMessage: String?
    let onRetry: () async -> Void
    var onRequestRotation: () -> Void = {}
    var onCancelRotation: () -> Void = {}
    var onConfirmRotation: () async -> Void = {}

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                HStack {
                    ProgressView()
                    Text("Loading calendar link…")
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("settings.calendarSubscription.loading")
            case .loaded(let url):
                LabeledContent("Subscription Link", value: maskedRepresentation(of: url))
                    .accessibilityIdentifier("settings.calendarSubscription.link")
                ShareLink(item: url) {
                    Label("Share Calendar Link", systemImage: "square.and.arrow.up")
                }
                .accessibilityIdentifier("settings.calendarSubscription.share")

                if isConfirmingRotation {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(
                            "Rotating creates a new subscription link and immediately "
                                + "stops the current one from working. Any calendar app "
                                + "subscribed to it will need to re-subscribe with the new link."
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("settings.calendarSubscription.rotate.confirmationMessage")

                        HStack {
                            Button("Cancel", role: .cancel) {
                                onCancelRotation()
                            }
                            .accessibilityIdentifier("settings.calendarSubscription.rotate.cancel")

                            Spacer()

                            Button("Rotate", role: .destructive) {
                                Task { await onConfirmRotation() }
                            }
                            .disabled(isRotating)
                            .accessibilityIdentifier("settings.calendarSubscription.rotate.confirm")
                        }
                    }
                    .accessibilityIdentifier("settings.calendarSubscription.rotate.confirmation")
                } else {
                    Button("Rotate", role: .destructive) {
                        onRequestRotation()
                    }
                    .disabled(isRotating)
                    .accessibilityIdentifier("settings.calendarSubscription.rotate")
                }

                if let rotationErrorMessage {
                    Label(rotationErrorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("settings.calendarSubscription.rotate.error")
                }
            case .failed(let message):
                Label(message, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("settings.calendarSubscription.error")
                Button("Retry") {
                    Task { await onRetry() }
                }
                .accessibilityIdentifier("settings.calendarSubscription.retry")
            }
        }
    }

    private func maskedRepresentation(of url: URL) -> String {
        guard let host = url.host else { return "••••••" }
        let scheme = url.scheme.map { "\($0)://" } ?? ""
        return "\(scheme)\(host)/••••••"
    }
}
