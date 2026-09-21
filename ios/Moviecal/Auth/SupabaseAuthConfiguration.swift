import Foundation

/// Which Supabase project the app authenticates against. Loaded from the
/// `MoviecalSupabaseURL` / `MoviecalSupabaseAnonKey` Info.plist keys (see the
/// Debug/Release build settings in `Moviecal.xcodeproj`), mirroring how
/// `APIEnvironment` resolves the `v1` API base URL.
///
/// The anon key is a client-safe publishable credential — never the Supabase
/// service-role key — and is safe to ship in the app binary.
public struct SupabaseAuthConfiguration {
    public let projectURL: URL
    public let anonKey: String

    public init(projectURL: URL, anonKey: String) {
        self.projectURL = projectURL
        self.anonKey = anonKey
    }
}

public enum SupabaseAuthConfigurationError: Error, Equatable {
    case missingProjectURL
    case invalidProjectURL(String)
    case missingAnonKey
}

extension SupabaseAuthConfiguration {
    public static func fromInfoPlist(bundle: Bundle = .main) throws -> SupabaseAuthConfiguration {
        guard let rawURL = bundle.object(forInfoDictionaryKey: "MoviecalSupabaseURL") as? String,
              !rawURL.isEmpty else {
            throw SupabaseAuthConfigurationError.missingProjectURL
        }
        guard let url = URL(string: rawURL) else {
            throw SupabaseAuthConfigurationError.invalidProjectURL(rawURL)
        }
        guard let anonKey = bundle.object(forInfoDictionaryKey: "MoviecalSupabaseAnonKey") as? String,
              !anonKey.isEmpty else {
            throw SupabaseAuthConfigurationError.missingAnonKey
        }
        return SupabaseAuthConfiguration(projectURL: url, anonKey: anonKey)
    }
}
