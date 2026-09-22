import SwiftUI

/// Placeholder search tab. Movie search wiring is a later feature issue —
/// this proves the tab's navigation and searchable-field shell.
struct SearchView: View {
    @State private var query = ""

    var body: some View {
        NavigationStack {
            ContentUnavailableView(
                "Search Movies",
                systemImage: "magnifyingglass",
                description: Text("Search coming soon.")
            )
            .navigationTitle("Search")
            .searchable(text: $query, prompt: "Movies")
        }
    }
}
