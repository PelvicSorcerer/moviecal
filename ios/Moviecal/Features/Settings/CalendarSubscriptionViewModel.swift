import Foundation
import Observation

/// Loads the signed-in user's calendar subscription URL from
/// `GET /api/v1/calendar-token` through `APIClient`, and rotates it via
/// `POST /api/v1/calendar-token`. The URL embeds a bearer credential for the
/// calendar feed (`docs/api/v1-contract.md`) — this type never logs it, only
/// ever exposing it to callers that render or share it explicitly.
@Observable
@MainActor
final class CalendarSubscriptionViewModel {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded(URL)
        case failed(String)
    }

    private(set) var state: LoadState = .idle

    /// Rotation requires the user to confirm the action from the section
    /// view before `confirmRotation()` fires the actual request — this flag
    /// gates that confirmation and is what `requestRotation()`/
    /// `cancelRotation()` toggle.
    private(set) var isConfirmingRotation = false
    private(set) var isRotating = false
    private(set) var rotationErrorMessage: String?

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func load() async {
        state = .loading
        do {
            let url = try await apiClient.fetchCalendarSubscriptionURL()
            state = .loaded(url)
        } catch {
            state = .failed("Unable to load your calendar subscription link. Try again.")
        }
    }

    func requestRotation() {
        guard case .loaded = state else { return }
        rotationErrorMessage = nil
        isConfirmingRotation = true
    }

    func cancelRotation() {
        isConfirmingRotation = false
    }

    /// Rotates the token. On failure, `state` is left untouched — the
    /// previously displayed URL is still valid — and the error surfaces
    /// through `rotationErrorMessage` instead.
    func confirmRotation() async {
        isConfirmingRotation = false
        isRotating = true
        defer { isRotating = false }
        do {
            let url = try await apiClient.rotateCalendarSubscriptionURL()
            state = .loaded(url)
            rotationErrorMessage = nil
        } catch {
            rotationErrorMessage = "Unable to rotate your calendar subscription link. Try again."
        }
    }

    func dismissRotationError() {
        rotationErrorMessage = nil
    }
}
