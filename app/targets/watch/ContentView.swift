import SwiftUI

struct ContentView: View {
    @ObservedObject private var link = PhoneLink.shared
    @State private var showingSessions = false

    var body: some View {
        Group {
            switch link.step {
            case .idle:
                homeView
            case .recording:
                RecordingView(link: link)
            case .transcribing:
                TranscribingView(link: link)
            case .confirm(let text):
                ConfirmView(link: link, text: text)
            case .error(let message):
                ErrorView(link: link, message: message)
            case .sent:
                SentView()
            }
        }
        .sheet(isPresented: $showingSessions) {
            SessionPickerView(link: link)
        }
    }

    private var homeView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    showingSessions = true
                } label: {
                    HStack(spacing: 4) {
                        Text(targetName)
                            .font(.system(size: 15, weight: .semibold))
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                    }
                }
                .buttonStyle(.plain)

                Text(statusLine)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)

                Button {
                    link.startRecording()
                } label: {
                    ZStack {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 64, height: 64)
                        Image(systemName: "mic.fill")
                            .font(.system(size: 26, weight: .medium))
                            .foregroundStyle(.white)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Record a message")

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                    ForEach(["Continue", "Yes", "No", "Stop"], id: \.self) { word in
                        Button {
                            link.sendQuickReply(word)
                        } label: {
                            Text(word)
                                .font(.system(size: 13, weight: .semibold))
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }
                }

                if let note = link.quickReplyNote {
                    Text(note)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }

                #if DEBUG
                Divider()
                Button {
                    link.sendTestClip()
                } label: {
                    Text("Send test clip")
                        .font(.system(size: 12))
                }
                .buttonStyle(.bordered)
                Button {
                    link.sayHello()
                } label: {
                    Text("Say hello")
                        .font(.system(size: 12))
                }
                .buttonStyle(.bordered)
                #endif
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var targetName: String {
        let selected = link.selectedSessionId ?? link.defaultSessionId
        if let row = link.rows.first(where: { $0.id == selected }) {
            return row.project.isEmpty ? "Zode" : row.project
        }
        return link.rows.first?.project ?? "Zode"
    }

    private var statusLine: String {
        if !link.activated { return "Waiting for phone" }
        return link.reachable ? "Phone: reachable" : "Phone: not reachable"
    }
}

// Pick the conversation the next prompt goes to (first five rows).
private struct SessionPickerView: View {
    @ObservedObject var link: PhoneLink
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List(link.rows.prefix(5)) { row in
            Button {
                link.selectedSessionId = row.id
                dismiss()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.project)
                            .font(.system(size: 14, weight: .semibold))
                            .lineLimit(1)
                        Text(row.title)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    if row.id == (link.selectedSessionId ?? link.defaultSessionId) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 13, weight: .bold))
                    }
                }
            }
            .buttonStyle(.plain)
        }
        .navigationTitle("Conversation")
    }
}
