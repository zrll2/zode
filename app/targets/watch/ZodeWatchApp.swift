import SwiftUI

@main
struct ZodeWatchApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .onAppear {
                    PhoneLink.shared.activate()
                }
        }
    }
}
