import SwiftUI

struct RootView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "film.stack")
                .font(.system(size: 48))
            Text("Moviecal")
                .font(.title)
        }
        .padding()
    }
}

#Preview {
    RootView()
}
