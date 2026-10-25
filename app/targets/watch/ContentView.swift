import SwiftUI

struct ContentView: View {
    @ObservedObject private var link = PhoneLink.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Zode")
                    .font(.system(size: 22, weight: .bold))
                Text(statusLine)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                Button {
                    link.sayHello()
                } label: {
                    Text("Say hello")
                        .font(.system(size: 14, weight: .semibold))
                }
                if link.answered {
                    Text("Phone says: connected to \(link.serverCount) Mac servers")
                        .font(.system(size: 12, weight: .medium))
                }
                ForEach(link.rows) { row in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(color(for: row.state))
                            .frame(width: 7, height: 7)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.project)
                                .font(.system(size: 13, weight: .semibold))
                                .lineLimit(1)
                            Text(row.title)
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var statusLine: String {
        if !link.activated { return "Waiting for phone" }
        return link.reachable ? "Phone: reachable" : "Phone: not reachable"
    }

    private func color(for state: String) -> Color {
        switch state {
        case "needs":
            return .orange
        case "working":
            return .blue
        default:
            return .green
        }
    }
}

#Preview {
    ContentView()
}
