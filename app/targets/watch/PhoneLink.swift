import AVFAudio
import Foundation
import WatchConnectivity
import WatchKit

// One row on the watch: project name plus a state dot.
struct WatchSessionRow: Identifiable, Equatable {
    let id: String
    let project: String
    let title: String
    let state: String // "needs" | "working" | "idle"
}

// Where the voice flow stands; drives the whole interface.
enum VoiceStep: Equatable {
    case idle
    case recording
    case transcribing
    case confirm(String)
    case error(String)
    case sent
}

// Owns the WCSession: activates on launch, fires hello at the phone, sends
// recorded clips and prompts, and absorbs the answers and snapshots.
final class PhoneLink: NSObject, ObservableObject, WCSessionDelegate {
    @Published var activated = false
    @Published var reachable = false
    @Published var answered = false
    @Published var serverCount = 0
    @Published var rows: [WatchSessionRow] = []
    @Published var defaultSessionId: String?
    @Published var selectedSessionId: String?
    @Published var step: VoiceStep = .idle
    @Published var elapsed = 0
    @Published var quickReplyNote: String?

    static let shared = PhoneLink()

    override private init() {
        super.init()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        absorb(snapshot: session.receivedApplicationContext)
    }

    // MARK: hello (W1)

    // The button: ask the phone for a snapshot. Reachable → sendMessage with
    // a reply handler; otherwise queue it with transferUserInfo.
    func sayHello() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        let message: [String: Any] = [
            "type": "hello",
            "at": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        if session.isReachable {
            session.sendMessage(
                message,
                replyHandler: { [weak self] payload in
                    self?.absorb(snapshot: payload)
                },
                errorHandler: { [weak self] _ in
                    self?.queue(message)
                }
            )
        } else {
            queue(message)
        }
    }

    private func queue(_ message: [String: Any]) {
        WCSession.default.transferUserInfo(message)
    }

    // MARK: voice flow (W2)

    func toggleRecording() {
        if step == .recording {
            finishRecording()
        } else {
            startRecording()
        }
    }

    func startRecording() {
        guard step != .recording, step != .transcribing else { return }
        // The prompt belongs to the mic tap and happens exactly once: passive
        // reads never trigger it, and nothing touches AVAudioSession before
        // permission is granted.
        if micPermissionRequested {
            beginRecordingIfPermitted()
            return
        }
        micPermissionRequested = true
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                self.micPermissionGranted = granted
                if granted {
                    self.beginRecording()
                } else {
                    self.step = .error("Allow the microphone for Zode in the phone's Settings.")
                }
            }
        }
    }

    private func beginRecordingIfPermitted() {
        if micPermissionGranted {
            beginRecording()
        } else {
            step = .error("Allow the microphone for Zode in the phone's Settings.")
        }
    }

    private func beginRecording() {
        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setCategory(.record, mode: .default)
        try? audioSession.setActive(true)

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("zode-clip-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000.0,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            AVEncoderBitRateKey: 24_000,
        ]
        guard let recorder = try? AVAudioRecorder(url: url, settings: settings) else {
            step = .error("Could not start the microphone. Try again.")
            return
        }
        audioRecorder = recorder
        recorder.record()
        elapsed = 0
        step = .recording

        recordTimer?.invalidate()
        recordTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, self.step == .recording else { return }
            self.elapsed += 1
            if self.elapsed >= Self.maxSeconds {
                self.finishRecording()
            }
        }
    }

    func finishRecording() {
        recordTimer?.invalidate()
        recordTimer = nil
        guard let recorder = audioRecorder else {
            step = .idle
            return
        }
        let url = recorder.url
        recorder.stop()
        audioRecorder = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        guard elapsed >= 1 else {
            try? FileManager.default.removeItem(at: url)
            step = .idle
            return
        }
        beginTranscription(fileURL: url, format: "m4a")
    }

    func cancelRecording() {
        recordTimer?.invalidate()
        recordTimer = nil
        if let recorder = audioRecorder {
            recorder.stop()
            try? FileManager.default.removeItem(at: recorder.url)
            audioRecorder = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false)
        step = .idle
    }

    // The simulator has no microphone: send the bundled 8 s clip instead.
    #if DEBUG
    func sendTestClip() {
        guard let url = Bundle.main.url(forResource: "test-clip", withExtension: "m4a") else {
            step = .error("test-clip.m4a is not bundled.")
            return
        }
        beginTranscription(fileURL: url, format: "m4a")
    }
    #endif

    private func beginTranscription(fileURL: URL, format: String) {
        guard WCSession.isSupported() else { return }
        guard let sessionId = selectedSessionId ?? defaultSessionId else {
            step = .error("No conversation selected yet. Open the phone once.")
            return
        }
        let id = UUID().uuidString
        pendingAudioId = id
        step = .transcribing
        let session = WCSession.default

        // Reachable: the clip rides inside a message and the transcript comes
        // straight back through the reply handler. Not reachable: queue the
        // file instead, and the transcript arrives as a separate message.
        if session.isReachable {
            guard let data = try? Data(contentsOf: fileURL) else {
                step = .error("Could not read the recording. Try again.")
                return
            }
            let base64 = data.base64EncodedString()
            // WatchConnectivity rejects large messages (WCErrorCodePayloadTooLarge); a long clip goes
            // by file transfer, which has no such limit.
            guard base64.count <= Self.maxBase64Characters else {
                transferClip(fileURL: fileURL, id: id, sessionId: sessionId, format: format)
                startTranscriptTimer()
                return
            }
            session.sendMessage(
                [
                    "type": "audio",
                    "id": id,
                    "rid": id,   // the phone library replaces "id" on incoming messages
                    "sessionId": sessionId,
                    "format": format,
                    "audioBase64": base64,
                ],
                replyHandler: { [weak self] reply in
                    DispatchQueue.main.async {
                        self?.handleTranscript(reply)
                    }
                },
                errorHandler: { [weak self] _ in
                    DispatchQueue.main.async {
                        // The message did not get through: queue the file once.
                        // The transcript then arrives as a separate message.
                        guard let self, self.pendingAudioId == id else { return }
                        self.transferClip(
                            fileURL: fileURL,
                            id: id,
                            sessionId: sessionId,
                            format: format
                        )
                    }
                }
            )
            startTranscriptTimer()
            return
        }

        transferClip(fileURL: fileURL, id: id, sessionId: sessionId, format: format)
        startTranscriptTimer()
    }

    private func transferClip(fileURL: URL, id: String, sessionId: String, format: String) {
        pendingAudioId = id
        WCSession.default.transferFile(fileURL, metadata: [
            "type": "audio",
            "id": id,
            "rid": id,   // the phone library replaces "id" on incoming messages
            "sessionId": sessionId,
            "format": format,
        ])
    }

    private func startTranscriptTimer() {
        transcriptTimer?.invalidate()
        transcriptTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in
            guard let self, self.step == .transcribing else { return }
            self.pendingAudioId = nil
            self.step = .error("Your Mac did not answer. Try again.")
        }
    }

    private func stopTranscriptTimer() {
        transcriptTimer?.invalidate()
        transcriptTimer = nil
    }

    // The transcript screen: Send hands the text to the conversation.
    func confirmSend() {
        guard case .confirm(let text) = step else { return }
        WKInterfaceDevice.current().play(.success)
        step = .sent
        sendPrompt(text)
        scheduleSentReset()
    }

    // Quick replies go out at once: haptic, then a one-line confirmation.
    func sendQuickReply(_ word: String) {
        WKInterfaceDevice.current().play(.click)
        sendPrompt(word)
        quickReplyNote = "Sent \u{201C}\(word)\u{201D}"
        quickReplyTimer?.invalidate()
        quickReplyTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
            self?.quickReplyNote = nil
        }
    }

    func sendPrompt(_ text: String) {
        guard WCSession.isSupported() else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let sessionId = selectedSessionId ?? defaultSessionId else {
            step = .error("No conversation selected yet. Open the phone once.")
            return
        }
        let id = UUID().uuidString
        pendingPromptId = id
        WCSession.default.sendMessage(
            [
                "type": "prompt",
                "id": id,
                "rid": id,   // the phone library replaces "id" on incoming messages
                "sessionId": sessionId,
                "text": trimmed,
            ],
            replyHandler: nil,
            errorHandler: { [weak self] _ in
                DispatchQueue.main.async {
                    self?.handleResult([
                        "type": "result",
                        "id": id,
                        "rid": id,   // the phone library replaces "id" on incoming messages
                        "ok": false,
                        "message": "Your phone cannot reach your Mac.",
                    ])
                }
            }
        )
    }

    func goHome() {
        step = .idle
    }

    // Type instead: whatever the watch user typed takes the same Send step.
    func confirmTyped(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        step = .confirm(trimmed)
    }

    private func markSent() {
        WKInterfaceDevice.current().play(.success)
        step = .sent
        scheduleSentReset()
    }

    private func scheduleSentReset() {
        sentResetTimer?.invalidate()
        sentResetTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
            guard let self, self.step == .sent else { return }
            self.step = .idle
        }
    }

    // MARK: parsing

    private func absorb(snapshot: [String: Any]) {
        guard (snapshot["ok"] as? Bool) == true else { return }
        DispatchQueue.main.async {
            if let servers = snapshot["servers"] as? Int, servers >= 0 {
                self.serverCount = servers
            }
            self.answered = true
            if let defaultId = snapshot["defaultSessionId"] as? String {
                self.defaultSessionId = defaultId
                if self.selectedSessionId == nil {
                    self.selectedSessionId = defaultId
                }
            }
            var parsed: [WatchSessionRow] = []
            if let items = snapshot["sessions"] as? [[String: Any]] {
                for item in items.prefix(5) {
                    guard let id = item["id"] as? String else { continue }
                    parsed.append(
                        WatchSessionRow(
                            id: id,
                            project: item["project"] as? String ?? "",
                            title: item["title"] as? String ?? "",
                            state: item["state"] as? String ?? "idle"
                        )
                    )
                }
            }
            self.rows = parsed
        }
    }

    private func handleTranscript(_ message: [String: Any]) {
        guard let id = message["id"] as? String, id == pendingAudioId else { return }
        pendingAudioId = nil
        stopTranscriptTimer()
        if (message["ok"] as? Bool) == true, let text = message["text"] as? String, !text.isEmpty {
            step = .confirm(text)
        } else {
            step = .error((message["message"] as? String) ?? "Could not turn that into text. Try again.")
        }
    }

    private func handleResult(_ message: [String: Any]) {
        guard let id = message["id"] as? String, id == pendingPromptId else { return }
        pendingPromptId = nil
        if (message["ok"] as? Bool) == true {
            if step != .sent {
                markSent()
            }
        } else {
            step = .error((message["message"] as? String) ?? "Could not send that. Try again.")
        }
    }

    // MARK: WCSessionDelegate

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        DispatchQueue.main.async {
            self.activated = activationState == .activated
            self.reachable = session.isReachable
            guard activationState == .activated else { return }
            // Launched after the phone last pushed: take the stored context, and ask the phone
            // for a fresh snapshot when there is still no conversation to talk to.
            self.absorb(snapshot: session.receivedApplicationContext)
            if self.defaultSessionId == nil, session.isReachable { self.sayHello() }
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.reachable = session.isReachable
            if session.isReachable, self.defaultSessionId == nil { self.sayHello() }
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        absorb(snapshot: applicationContext)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        DispatchQueue.main.async {
            switch message["type"] as? String {
            case "transcript":
                self.handleTranscript(message)
            case "result":
                self.handleResult(message)
            default:
                break
            }
            self.absorb(snapshot: message)
        }
    }

    // MARK: constants and state

    static let maxSeconds = 55
    // About 12 s of 24 kbps AAC; longer clips use a file transfer.
    static let maxBase64Characters = 60_000

    private var audioRecorder: AVAudioRecorder?
    private var recordTimer: Timer?
    private var transcriptTimer: Timer?
    private var sentResetTimer: Timer?
    private var quickReplyTimer: Timer?
    private var pendingAudioId: String?
    private var pendingPromptId: String?
    // The prompt happens on the first mic tap, never at launch.
    private var micPermissionRequested = false
    private var micPermissionGranted = false
}
