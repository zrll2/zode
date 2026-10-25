import Foundation
import WatchConnectivity

// One row on the watch: project name plus a state dot.
struct WatchSessionRow: Identifiable, Equatable {
    let id: String
    let project: String
    let title: String
    let state: String // "needs" | "working" | "idle"
}

// Owns the WCSession: activates on launch, fires hello at the phone, and
// absorbs the snapshot the phone replies with (or pushes on its own).
final class PhoneLink: NSObject, ObservableObject, WCSessionDelegate {
    @Published var activated = false
    @Published var reachable = false
    @Published var answered = false
    @Published var serverCount = 0
    @Published var rows: [WatchSessionRow] = []

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

    // MARK: parsing

    private func absorb(snapshot: [String: Any]) {
        guard (snapshot["ok"] as? Bool) == true else { return }
        DispatchQueue.main.async {
            if let servers = snapshot["servers"] as? Int, servers >= 0 {
                self.serverCount = servers
            }
            self.answered = true
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

    // MARK: WCSessionDelegate

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        DispatchQueue.main.async {
            self.activated = activationState == .activated
            self.reachable = session.isReachable
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.reachable = session.isReachable
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        absorb(snapshot: applicationContext)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        absorb(snapshot: message)
    }
}
