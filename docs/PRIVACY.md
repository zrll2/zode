# Privacy policy

**Effective date:** 19 October 2026

Zode is an open-source phone companion for the ZCode desktop app. This policy explains what the Zode phone app does with your data. The short version: **it collects nothing.**

## What Zode collects

Nothing. Zode has no accounts, no analytics, no advertising, no crash reporting service and no tracking. The developers cannot see your data, because it never reaches us.

## What stays on your devices

- **Your conversations** travel only between your phone and the Zode relay that runs on **your own Mac**, over your local network or a private network that you choose (for example Tailscale). We do not operate any server that stores or relays them.
- **Pairing token.** When you pair, the relay gives your phone a random token. The phone stores it in the iOS Keychain (the system secure store). The Mac stores only a hash of it. You can remove a phone at any time on the Mac (`./zode revoke <id>`) or by choosing "Unpair this phone" in the app.
- **Relay address.** The address of your Mac is stored on the phone so the app can reconnect.

## Permissions

- **Camera.** Used only to scan the pairing QR code that the relay shows on your Mac. Images are not saved or sent anywhere.
- **Local network.** Used to connect to the relay on your Mac. Zode connects only to the address you paired with.

## Third parties

Zode does not include third-party analytics or advertising SDKs. It does not share data with anyone.

## Demo mode

Demo mode shows built-in sample data. It makes no network connections.

## Children

Zode is a developer tool and is not directed at children.

## Changes

If this policy changes, the new version will be published in this repository with a new effective date.

## Contact

Open an issue at https://github.com/zrll2/zode/issues. For a security problem, use the private vulnerability reporting described in [SECURITY.md](../SECURITY.md).
