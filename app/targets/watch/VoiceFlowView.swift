import SwiftUI

// Recording: pulsing ring, elapsed seconds, tap to stop, Cancel.
struct RecordingView: View {
    @ObservedObject var link: PhoneLink
    @State private var pulse = false

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .stroke(Color.accentColor, lineWidth: 3)
                    .frame(width: 84, height: 84)
                    .scaleEffect(pulse ? 1.08 : 1.0)
                    .opacity(pulse ? 0.5 : 1.0)
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 56, height: 56)
                Image(systemName: "mic.fill")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(.white)
            }
            .onAppear {
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                    pulse = true
                }
            }
            Text(String(format: "0:%02d", link.elapsed))
                .font(.system(size: 18, weight: .semibold, design: .monospaced))
            Button {
                link.finishRecording()
            } label: {
                Text("Tap to stop")
                    .font(.system(size: 14, weight: .semibold))
            }
            Button {
                link.cancelRecording()
            } label: {
                Text("Cancel")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
    }
}

// The phone has the clip and is transcribing it.
struct TranscribingView: View {
    @ObservedObject var link: PhoneLink

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Writing it down...")
                .font(.system(size: 15, weight: .medium))
            Button {
                link.goHome()
            } label: {
                Text("Cancel")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
    }
}

// Review the words, then send or record again.
struct ConfirmView: View {
    @ObservedObject var link: PhoneLink
    let text: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(text)
                    .font(.system(size: 15))
                Button {
                    link.confirmSend()
                } label: {
                    Text("Send")
                        .font(.system(size: 16, weight: .bold))
                        .frame(maxWidth: .infinity)
                }
                Button {
                    link.startRecording()
                } label: {
                    Text("Redo")
                        .font(.system(size: 14))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// Plain-words failure with a retry — or typing when voice is not an option.
struct ErrorView: View {
    @ObservedObject var link: PhoneLink
    let message: String
    @State private var typing = false
    @State private var typed = ""

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 22))
                .foregroundStyle(.secondary)
            Text(message)
                .font(.system(size: 14))
                .multilineTextAlignment(.center)
            Button {
                link.startRecording()
            } label: {
                Text("Try again")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            if typing {
                TextField("Type a message", text: $typed)
                    .font(.system(size: 14))
                    .submitLabel(.send)
                Button {
                    let text = typed
                    typed = ""
                    link.confirmTyped(text)
                } label: {
                    Text("Next")
                        .font(.system(size: 14, weight: .semibold))
                        .frame(maxWidth: .infinity)
                }
                .disabled(typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } else {
                Button {
                    typing = true
                } label: {
                    Text("Type instead")
                        .font(.system(size: 13))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            Button {
                link.goHome()
            } label: {
                Text("Home")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
    }
}

// Brief ack after sending; PhoneLink returns home after 1.5 s.
struct SentView: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 34, weight: .medium))
                .foregroundStyle(.green)
            Text("Sent")
                .font(.system(size: 16, weight: .semibold))
        }
    }
}
