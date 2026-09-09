import Foundation

/// The `{ "error": string }` shape every `v1` error response uses, per
/// `docs/api/v1-contract.md`.
public struct APIErrorBody: Codable, Equatable {
    public let error: String

    public init(error: String) {
        self.error = error
    }
}
