import Foundation
import Observation

/// Client-side mirror of the server's shared-list name rules (trimmed, 1–80
/// characters). The server stays authoritative; this only avoids a round trip.
enum WatchlistNameValidator {
    static let maxLength = 80

    enum Failure: Equatable {
        case blank
        case tooLong

        var message: String {
            switch self {
            case .blank: "Enter a name for the list."
            case .tooLong: "Names can be at most \(WatchlistNameValidator.maxLength) characters."
            }
        }
    }

    /// The trimmed name, or the reason it is not acceptable.
    static func validate(_ raw: String) -> Result<String, Failure> {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return .failure(.blank) }
        if name.count > maxLength { return .failure(.tooLong) }
        return .success(name)
    }
}

/// Drives the create / rename form. Errors are recoverable: the typed name is
/// kept so the user can fix it, and nothing is reported as saved on failure.
@Observable
@MainActor
final class WatchlistNameEditorViewModel {
    enum Mode: Equatable {
        case create
        case rename(id: String)
    }

    enum Outcome: Equatable {
        case saved(WatchlistSummary)
        /// The list was deleted or the caller lost access; nothing was changed.
        case accessLost
    }

    var name: String
    private(set) var errorMessage: String?
    private(set) var isSaving = false

    let mode: Mode
    private let apiClient: APIClient

    init(mode: Mode, initialName: String = "", apiClient: APIClient) {
        self.mode = mode
        self.name = initialName
        self.apiClient = apiClient
    }

    var title: String {
        mode == .create ? "New Shared List" : "Rename List"
    }

    var canSubmit: Bool {
        !isSaving && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func clearError() {
        errorMessage = nil
    }

    /// Validates then saves. Returns `nil` when validation or the request
    /// failed (see `errorMessage`).
    func submit() async -> Outcome? {
        guard !isSaving else { return nil }
        let trimmed: String
        switch WatchlistNameValidator.validate(name) {
        case .failure(let failure):
            errorMessage = failure.message
            return nil
        case .success(let value):
            trimmed = value
        }
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }
        do {
            let saved: WatchlistSummary
            switch mode {
            case .create:
                saved = try await apiClient.createSharedWatchlist(name: trimmed)
            case .rename(let id):
                saved = try await apiClient.renameSharedWatchlist(id: id, name: trimmed)
            }
            return .saved(saved)
        } catch APIClientError.notFound, APIClientError.accessDenied {
            if case .rename = mode { return .accessLost }
            errorMessage = "You can't create a list right now."
            return nil
        } catch APIClientError.invalidRequest(let message) {
            errorMessage = message
            return nil
        } catch APIClientError.authenticationExpired {
            errorMessage = "Your session expired. Sign in again to continue."
            return nil
        } catch {
            guard !Task.isCancelled else { return nil }
            errorMessage = "Couldn't save the list. Check your connection and try again."
            return nil
        }
    }
}
