import Foundation

/// Typed client over the `/api/v1` surface documented in
/// `docs/api/v1-contract.md`. Every request carries a bearer token obtained
/// from `tokenProvider`; the client never reads or sends cookies and never
/// logs the token or a response containing it.
public final class APIClient {
    private let environment: APIEnvironment
    private let tokenProvider: AuthTokenProviding
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(
        environment: APIEnvironment,
        tokenProvider: AuthTokenProviding,
        session: URLSession = .shared
    ) {
        self.environment = environment
        self.tokenProvider = tokenProvider
        self.session = session
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    // MARK: - Watchlist

    public func fetchWatchlist() async throws -> [WatchlistItem] {
        let request = try await makeRequest(path: "/api/v1/watchlist", method: "GET")
        let body: WatchlistListResponseBody = try await send(request)
        return body.items
    }

    public func addWatchlistItem(tmdbId: Int) async throws -> WatchlistItem {
        var request = try await makeRequest(path: "/api/v1/watchlist", method: "POST")
        request.httpBody = try encoder.encode(AddWatchlistItemRequestBody(tmdbId: tmdbId))
        let body: WatchlistItemResponseBody = try await send(request)
        return body.item
    }

    public func removeWatchlistItem(watchlistItemId: String) async throws {
        var request = try await makeRequest(path: "/api/v1/watchlist", method: "DELETE")
        request.httpBody = try encoder.encode(RemoveWatchlistItemRequestBody(watchlistItemId: watchlistItemId))
        try await sendExpectingNoContent(request)
    }

    // MARK: - Personal and shared lists

    /// Every list the caller may read, following `nextCursor` to the end.
    /// Inconsistent or duplicate entries fail the whole read rather than
    /// showing data the contract does not allow.
    public func fetchWatchlists() async throws -> [WatchlistSummary] {
        var summaries: [WatchlistSummary] = []
        var cursor: String?
        for _ in 0..<Self.maxPages {
            let request = try await makeRequest(
                path: "/api/v1/watchlists",
                method: "GET",
                queryItems: cursor.map { [URLQueryItem(name: "cursor", value: $0)] }
            )
            let body: WatchlistSummaryPage = try await send(request)
            summaries.append(contentsOf: body.watchlists)
            guard let next = body.page.nextCursor else {
                let ids = Set(summaries.map(\.id))
                guard summaries.allSatisfy(\.isConsistent), ids.count == summaries.count else {
                    throw APIClientError.decodingFailed(message: "Invalid watchlist summaries.")
                }
                return summaries
            }
            guard next != cursor else { break }
            cursor = next
        }
        throw APIClientError.decodingFailed(message: "Watchlist pagination did not terminate.")
    }

    /// The list `watchlistId` and all of its items. A `404` means the list
    /// does not exist or access was lost; the two are indistinguishable.
    public func fetchWatchlistDetail(watchlistId: String) async throws -> WatchlistDetail {
        // `appendingPathComponent` percent-encodes everything but `/`, which
        // would let an id escape its path segment.
        guard !watchlistId.isEmpty, !watchlistId.contains("/") else {
            throw APIClientError.invalidRequest(message: "Invalid watchlist id.")
        }

        var watchlist: WatchlistSummary?
        var items: [WatchlistItem] = []
        var cursor: String?
        for _ in 0..<Self.maxPages {
            let request = try await makeRequest(
                path: "/api/v1/watchlists/\(watchlistId)",
                method: "GET",
                queryItems: cursor.map { [URLQueryItem(name: "cursor", value: $0)] }
            )
            let body: WatchlistDetailPage = try await send(request)
            guard body.watchlist.id == watchlistId, body.watchlist.isConsistent else {
                throw APIClientError.decodingFailed(message: "Invalid watchlist detail.")
            }
            watchlist = body.watchlist
            items.append(contentsOf: body.items)
            guard let next = body.page.nextCursor else {
                guard let watchlist else { break }
                return WatchlistDetail(watchlist: watchlist, items: items)
            }
            guard next != cursor else { break }
            cursor = next
        }
        throw APIClientError.decodingFailed(message: "Watchlist pagination did not terminate.")
    }

    private static let maxPages = 50

    // MARK: - Movie search

    public func searchMovies(query: String) async throws -> [MovieSearchResult] {
        let request = try await makeRequest(
            path: "/api/v1/movies/search",
            method: "GET",
            queryItems: [URLQueryItem(name: "q", value: query)]
        )
        let body: MovieSearchResponseBody = try await send(request)
        return body.results
    }

    // MARK: - Calendar token

    public func fetchCalendarSubscriptionURL() async throws -> URL {
        let request = try await makeRequest(path: "/api/v1/calendar-token", method: "GET")
        let body: CalendarSubscriptionResponse = try await send(request)
        return body.subscriptionUrl
    }

    public func rotateCalendarSubscriptionURL() async throws -> URL {
        let request = try await makeRequest(path: "/api/v1/calendar-token", method: "POST")
        let body: CalendarSubscriptionResponse = try await send(request)
        return body.subscriptionUrl
    }

    // MARK: - Request building

    private func makeRequest(
        path: String,
        method: String,
        queryItems: [URLQueryItem]? = nil
    ) async throws -> URLRequest {
        guard var components = URLComponents(
            url: environment.baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIClientError.invalidRequest(message: "Unable to build request URL for \(path).")
        }
        components.queryItems = queryItems

        guard let url = components.url else {
            throw APIClientError.invalidRequest(message: "Unable to build request URL for \(path).")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let token = try await tokenProvider.currentAccessToken()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        if method == "POST" || method == "DELETE" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        return request
    }

    // MARK: - Sending

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await performRequest(request)
        try validate(response: response, data: data)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIClientError.decodingFailed(message: String(describing: error))
        }
    }

    private func sendExpectingNoContent(_ request: URLRequest) async throws {
        let (data, response) = try await performRequest(request)
        try validate(response: response, data: data)
    }

    private func performRequest(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch {
            throw APIClientError.transportFailed(message: error.localizedDescription)
        }
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIClientError.transportFailed(message: "Received a non-HTTP response.")
        }

        switch httpResponse.statusCode {
        case 200, 201, 204:
            return
        case 401:
            throw APIClientError.authenticationExpired
        default:
            let message = (try? decoder.decode(APIErrorBody.self, from: data))?.error
            throw mapErrorStatus(httpResponse.statusCode, message: message)
        }
    }

    private func mapErrorStatus(_ statusCode: Int, message: String?) -> APIClientError {
        switch statusCode {
        case 400:
            return .invalidRequest(message: message ?? "Invalid request.")
        case 403:
            return .accessDenied(message: message ?? "Access denied.")
        case 404:
            return .notFound(message: message ?? "Not found.")
        case 500:
            return .serverError(message: message ?? "Server error.")
        case 503:
            return .serviceUnavailable(message: message ?? "Service unavailable.")
        default:
            return .unexpectedStatus(code: statusCode, message: message)
        }
    }
}

// MARK: - Request/response envelopes

private struct AddWatchlistItemRequestBody: Encodable {
    let tmdbId: Int
}

private struct RemoveWatchlistItemRequestBody: Encodable {
    let watchlistItemId: String
}

private struct WatchlistListResponseBody: Decodable {
    let items: [WatchlistItem]
}

private struct WatchlistItemResponseBody: Decodable {
    let item: WatchlistItem
}

private struct MovieSearchResponseBody: Decodable {
    let results: [MovieSearchResult]
}
