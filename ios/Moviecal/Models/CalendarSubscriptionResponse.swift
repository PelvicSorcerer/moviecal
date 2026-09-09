import Foundation

/// Response body shared by `GET` and `POST /api/v1/calendar-token` in
/// `docs/api/v1-contract.md`. The embedded token is a bearer credential for
/// the calendar feed — callers must treat the whole URL like a password and
/// never log it.
public struct CalendarSubscriptionResponse: Codable, Equatable {
    public let subscriptionUrl: URL

    public init(subscriptionUrl: URL) {
        self.subscriptionUrl = subscriptionUrl
    }
}
