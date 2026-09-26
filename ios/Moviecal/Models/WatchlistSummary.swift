import Foundation

/// A personal or shared list the caller may read. Matches `WatchlistView` in
/// `docs/api/v1-contract.md`. Unknown `kind`/`role` values fail decoding so
/// data the client does not understand is never displayed.
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

    /// Whether the fields agree with the contract's invariants: a personal
    /// list is always owned by the caller, and an owner or editor can edit.
    var isConsistent: Bool {
        guard !id.isEmpty, !name.isEmpty, !ownerUserId.isEmpty, canEdit else { return false }
        return kind == .shared || role == .owner
    }

    /// Text shown next to the name so ownership and sharing never rely on
    /// color or iconography alone.
    var statusText: String {
        switch (kind, role) {
        case (.personal, _):
            return "Personal"
        case (.shared, .owner):
            return "Shared · You own this"
        case (.shared, .editor):
            return "Shared · You can edit"
        }
    }

    var systemImage: String {
        kind == .personal ? "bookmark" : "person.2"
    }
}

/// `{ limit, nextCursor }` from the paginated read endpoints.
struct WatchlistPage: Decodable, Equatable {
    let limit: Int
    let nextCursor: String?
}

/// One page of `GET /api/v1/watchlists`.
struct WatchlistSummaryPage: Decodable {
    let watchlists: [WatchlistSummary]
    let page: WatchlistPage
}

/// One page of `GET /api/v1/watchlists/{id}`.
struct WatchlistDetailPage: Decodable {
    let watchlist: WatchlistSummary
    let items: [WatchlistItem]
    let page: WatchlistPage
}

/// A fully paged list detail: the summary plus every item.
public struct WatchlistDetail: Equatable {
    public let watchlist: WatchlistSummary
    public let items: [WatchlistItem]
}
