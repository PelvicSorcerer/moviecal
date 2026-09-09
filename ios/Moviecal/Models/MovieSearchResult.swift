import Foundation

/// A single TMDb search result. Matches an element of `results` from
/// `GET /api/v1/movies/search` in `docs/api/v1-contract.md`. Unlike `Movie`,
/// search results carry no local watchlist `id` — `tmdbId` identifies them.
public struct MovieSearchResult: Codable, Equatable, Identifiable {
    public var id: Int { tmdbId }

    public let tmdbId: Int
    public let title: String
    public let releaseDate: String?
    public let posterPath: String?
    public let overview: String?

    public init(
        tmdbId: Int,
        title: String,
        releaseDate: String?,
        posterPath: String?,
        overview: String?
    ) {
        self.tmdbId = tmdbId
        self.title = title
        self.releaseDate = releaseDate
        self.posterPath = posterPath
        self.overview = overview
    }
}
