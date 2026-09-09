import Foundation

/// Which backend `APIClient` talks to. The base URL is supplied per build
/// configuration via the `MoviecalAPIBaseURL` Info.plist key (see the
/// Debug/Release build settings in `Moviecal.xcodeproj`), so Debug builds can
/// point at a local dev server while Release builds point at the deployed API
/// without changing source.
public struct APIEnvironment {
    public let baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }
}

public enum APIEnvironmentError: Error, Equatable {
    case missingBaseURL
    case invalidBaseURL(String)
}

extension APIEnvironment {
    public static func fromInfoPlist(bundle: Bundle = .main) throws -> APIEnvironment {
        guard let raw = bundle.object(forInfoDictionaryKey: "MoviecalAPIBaseURL") as? String,
              !raw.isEmpty else {
            throw APIEnvironmentError.missingBaseURL
        }
        guard let url = URL(string: raw) else {
            throw APIEnvironmentError.invalidBaseURL(raw)
        }
        return APIEnvironment(baseURL: url)
    }
}
