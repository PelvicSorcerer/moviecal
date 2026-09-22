import SwiftUI

/// Shown instead of crashing when the app's Info.plist configuration
/// (`APIEnvironment`/`SupabaseAuthConfiguration`) fails to parse. That only
/// happens if the build itself is misconfigured, so there is nothing the
/// user can do to recover -- but a build-config bug still shouldn't crash on
/// every launch with no explanation.
struct ConfigurationErrorView: View {
    let error: Error

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundStyle(.orange)
            Text("Moviecal Can't Start")
                .font(.title2)
                .bold()
            Text("The app's configuration is invalid. Please reinstall Moviecal or contact support if this continues.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .padding()
    }
}

#Preview {
    ConfigurationErrorView(error: SupabaseAuthConfigurationError.missingProjectURL)
}
