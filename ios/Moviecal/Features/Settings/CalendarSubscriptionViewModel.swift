import Foundation
import Observation

/// Loads the signed-in user's calendar subscription URL from
/// `GET /api/v1/calendar-token` through `APIClient`. The URL embeds a bearer
/// credential for the calendar feed (`docs/api/v1-contract.md`) — this type
/// never logs it, only ever exposing it to callers that render or share it
/// explicitly. Token rotation (MOV-291's out-of-scope follow-up) is not
/// implemented here.
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
}
