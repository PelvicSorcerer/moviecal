import Foundation

/// Errors surfaced by `APIClient`, mapped from the `v1` contract's status
/// codes and `{ "error": string }` body (`docs/api/v1-contract.md`).
public enum APIClientError: Error, Equatable {
    /// `400` — invalid request body or query parameters.
    case invalidRequest(message: String)
    /// `401` — a distinct signal so callers can route to re-authentication.
    /// `APIClient` never attempts a silent refresh or retry on this error.
    case authenticationExpired
    /// `403` — denied by domain/RLS rules.
    case accessDenied(message: String)
    /// `404` — item or resource not found.
    case notFound(message: String)
    /// `500` — unexpected/data error.
    case serverError(message: String)
    /// `503` — a dependency (TMDb) is not configured.
    case serviceUnavailable(message: String)
    /// Any HTTP status the `v1` contract does not define.
    case unexpectedStatus(code: Int, message: String?)
    /// The response body did not decode into the expected model.
    case decodingFailed(message: String)
    /// A transport-level failure (offline, timeout, DNS, etc).
    case transportFailed(message: String)
}
