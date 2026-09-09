import Foundation

/// A movie as it appears inside a watchlist item. Matches `WatchlistMovie` in
/// `docs/api/v1-contract.md`.
public struct Movie: Codable, Equatable, Identifiable {
    public let id: Int
    public let tmdbId: Int
    public let title: String
    public let releaseDate: String?
    public let posterPath: String?
    public let overview: String?

    public init(
        id: Int,
        tmdbId: Int,
        title: String,
        releaseDate: String?,
        posterPath: String?,
        overview: String?
    ) {
        self.id = id
        self.tmdbId = tmdbId
        self.title = title
        self.releaseDate = releaseDate
        self.posterPath = posterPath
        self.overview = overview
    }
}
