# Privacy policy

**Effective date:** 19 October 2026

Zode is an open-source phone companion for the ZCode desktop app. This policy explains what the Zode phone app does with your data. The short version: **it collects no personal data and has no accounts, analytics or tracking.** If you turn on push notifications, a small Zode service passes encrypted alerts to Apple's push service (details below).

## What Zode collects

Nothing about you. Zode has no accounts, no analytics, no advertising, no crash reporting service and no tracking. The developers cannot read your conversations, because they never reach us.

## What stays on your devices

- **Your conversations** travel only between your phone and the Zode relay that runs on **your own Mac**, over your local network or a private network that you choose (for example Tailscale). We do not operate any server that stores or relays them. The only server we run is the push service described below, and it never sees them.
- **Pairing token.** When you pair, the relay gives your phone a random token. The phone stores it in the iOS Keychain (the system secure store). The Mac stores only a hash of it. You can remove a phone at any time on the Mac (`./zode revoke <id>`) or by choosing "Unpair this phone" in the app.
- **Relay address.** The address of your Mac is stored on the phone so the app can reconnect.

## Push notifications

If you allow notifications, your phone gives Apple's push service a device token, and the app hands it to the Zode push service (a small stateless function on Vercel, source in `push-service/`). The service encrypts the token into an opaque id and keeps nothing: no database, no files, no logs of tokens. Your Mac sends it alerts that are end-to-end encrypted with a key made when you paired, so the service sees only the alert type (for example "needs an answer"), a size and the opaque id. It forwards them to Apple, which delivers them to your phone. The text of an alert is decrypted on your phone only. You can turn notifications off in iOS Settings or unpair the phone.

## Permissions

- **Camera.** Used only to scan the pairing QR code that the relay shows on your Mac. Images are not saved or sent anywhere.
- **Notifications.** Optional, for the alerts above.
- **Microphone** (voice replies, optional). Audio goes from your phone to your own Mac, which turns it into text on the Mac itself, and is not kept.
- **Local network.** Used to connect to the relay on your Mac. Zode connects only to the address you paired with.

## Third parties

Zode does not include third-party analytics or advertising SDKs and does not share data with anyone. Notifications are delivered through Apple's push service (APNs), and the push service runs on Vercel.

## Demo mode

Demo mode shows built-in sample data. It makes no network connections.

## Children

Zode is a developer tool and is not directed at children.

## Changes

If this policy changes, the new version will be published in this repository with a new effective date.

## Contact

Open an issue at https://github.com/zrll2/zode/issues. For a security problem, use the private vulnerability reporting described in [SECURITY.md](../SECURITY.md).
