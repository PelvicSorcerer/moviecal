import XCTest
@testable import Moviecal

/// Decodes the exact JSON examples from `docs/api/v1-contract.md` to prove
/// the Codable models match the contract.
final class ModelDecodingTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testWatchlistItemDecodesFromContractExample() throws {
        let json = """
        {
          "id": "watchlist-item-1",
          "addedAt": "2026-06-13T05:00:00.000Z",
          "movie": {
            "id": 42,
            "tmdbId": 603,
            "title": "The Matrix",
            "releaseDate": "1999-03-31",
            "posterPath": "/matrix.jpg",
            "overview": "A hacker discovers the truth."
          }
        }
        """.data(using: .utf8)!

        let item = try decoder.decode(WatchlistItem.self, from: json)

        XCTAssertEqual(item.id, "watchlist-item-1")
        XCTAssertEqual(item.addedAt, "2026-06-13T05:00:00.000Z")
        XCTAssertEqual(item.movie.id, 42)
        XCTAssertEqual(item.movie.tmdbId, 603)
        XCTAssertEqual(item.movie.title, "The Matrix")
        XCTAssertEqual(item.movie.releaseDate, "1999-03-31")
        XCTAssertEqual(item.movie.posterPath, "/matrix.jpg")
        XCTAssertEqual(item.movie.overview, "A hacker discovers the truth.")
    }

    func testMovieSearchResultDecodesFromContractExampleAndOmitsWatchlistId() throws {
        let json = """
        {
          "tmdbId": 603,
          "title": "The Matrix",
          "releaseDate": "1999-03-31",
          "posterPath": "/matrix.jpg",
          "overview": "A hacker discovers the truth."
        }
        """.data(using: .utf8)!

        let result = try decoder.decode(MovieSearchResult.self, from: json)

        XCTAssertEqual(result.tmdbId, 603)
        XCTAssertEqual(result.title, "The Matrix")
        XCTAssertEqual(result.id, 603, "search results identify by tmdbId, not a watchlist id")
    }

    func testCalendarSubscriptionResponseDecodesFromContractExample() throws {
        let json = """
        { "subscriptionUrl": "https://moviecal.example/api/calendar/AbC123..." }
        """.data(using: .utf8)!

        let response = try decoder.decode(CalendarSubscriptionResponse.self, from: json)

        XCTAssertEqual(response.subscriptionUrl, URL(string: "https://moviecal.example/api/calendar/AbC123..."))
    }

    func testAPIErrorBodyDecodesFromContractShape() throws {
        let json = #"{ "error": "Unauthorized." }"#.data(using: .utf8)!

        let body = try decoder.decode(APIErrorBody.self, from: json)

        XCTAssertEqual(body.error, "Unauthorized.")
    }

    func testMovieDecodesNullableFieldsAsNil() throws {
        let json = """
        {
          "id": 43,
          "tmdbId": 604,
          "title": "Untitled",
          "releaseDate": null,
          "posterPath": null,
          "overview": null
        }
        """.data(using: .utf8)!

        let movie = try decoder.decode(Movie.self, from: json)

        XCTAssertNil(movie.releaseDate)
        XCTAssertNil(movie.posterPath)
        XCTAssertNil(movie.overview)
    }
}
