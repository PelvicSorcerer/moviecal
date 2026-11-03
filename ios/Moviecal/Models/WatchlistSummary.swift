import Foundation

/// A list the caller may read. Matches `WatchlistView` in
/// `docs/api/v1-contract.md`. Decoding fails on an unknown `kind` or `role`
/// so unrecognized data is never shown.
public struct WatchlistSummary: Codable, Equatable, Hashable, Identifiable {
    public enum Kind: String, Codable, Hashable {
        case personal
        case shared
    }

    public enum Role: String, Codable, Hashable {
        case owner
        case editor
    }

    public let id: String
    public let kind: Kind
    public let name: String
    public let ownerUserId: String
    public let role: Role
    public let canEdit: Bool

    public init(id: String, kind: Kind, name: String, ownerUserId: String, role: Role, canEdit: Bool) {
        self.id = id
        self.kind = kind
        self.name = name
        self.ownerUserId = ownerUserId
        self.role = role
        self.canEdit = canEdit
    }
}

/// Pagination metadata from the shared/personal list reads.
public struct WatchlistPage: Codable, Equatable {
    public let limit: Int
    public let nextCursor: String?

    public init(limit: Int, nextCursor: String?) {
        self.limit = limit
        self.nextCursor = nextCursor
    }
}

/// A list together with its items, from `GET /api/v1/watchlists/{id}`.
public struct WatchlistDetail: Equatable {
    public let watchlist: WatchlistSummary
    public let items: [WatchlistItem]

    public init(watchlist: WatchlistSummary, items: [WatchlistItem]) {
        self.watchlist = watchlist
        self.items = items
    }
}
