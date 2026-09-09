import Foundation

/// A single entry in a user's personal watchlist. Matches `WatchlistItem` in
/// `docs/api/v1-contract.md`.
public struct WatchlistItem: Codable, Equatable, Identifiable {
    public let id: String
    public let addedAt: String
    public let movie: Movie

    public init(id: String, addedAt: String, movie: Movie) {
        self.id = id
        self.addedAt = addedAt
        self.movie = movie
    }
}
