import SwiftUI

/// Settings tab: account info, sign-out, and (MOV-291) view/share of the
/// calendar subscription link. Token rotation is a separate follow-up issue.
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
                        onRetry: { await calendarViewModel.load() }
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
struct CalendarSubscriptionSectionView: View {
    let state: CalendarSubscriptionViewModel.LoadState
    let onRetry: () async -> Void

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
