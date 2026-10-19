# Publishing the app to the App Store and Google Play

The app is ready to build. Everything that needs **your** accounts is listed here. Run `cd app && npm run store:check` at any time: it must say `0 error(s)`.

Bundle id and package: `com.zode.app`. Change them in `app/app.json` if you publish your own build (they must be unique in each store).

## What you need once

| Item | Cost | Notes |
|---|---|---|
| Apple Developer Program | 99 USD per year | Needed for App Store Connect. |
| Google Play Console | 25 USD once | New personal accounts must run a **closed test with 12 testers for 14 days** before production. |
| Expo account (free) | | Builds run on EAS, so you do not need Android Studio. Xcode is not needed for the build either. |

## 1. Link the project to EAS

```bash
cd app
npm install
npx eas-cli login
npx eas-cli init            # writes extra.eas.projectId into app.json
```

## 2. App Store (iOS)

1. **Create the app** in App Store Connect: New App, platform iOS, name `Zode for ZCode`, bundle id `com.zode.app`, SKU `zode-app`.
2. **Fill in your review contact** in `app/store.config.json` (`apple.review`: name, email, phone). Replace every `REPLACE_ME`.
3. **Build and upload:**
   ```bash
   npx eas-cli build --platform ios --profile production
   npx eas-cli submit --platform ios --latest
   ```
   EAS asks for your Apple ID and manages certificates and profiles for you.
4. **Push the listing text:**
   ```bash
   npx eas-cli metadata:lint     # checks store.config.json
   npx eas-cli metadata:push     # uploads the English and Simplified Chinese listing
   ```
5. **Screenshots:** upload the files in `app/store/screenshots/ios/` (1320 x 2868, the 6.9-inch size; Apple scales them for smaller phones). The app is iPhone only, so no iPad screenshots are needed.
6. **In App Store Connect, answer these by hand:**
   - **Privacy:** Data collection = "Data Not Collected". Privacy policy URL is already in the listing.
   - **Age rating:** answer the questionnaire; Zode has no objectionable content, so it rates 4+.
   - **Export compliance:** already declared in the app (`ITSAppUsesNonExemptEncryption = false`), so the question does not appear.
   - **Pricing:** Free. **Availability:** your choice.
   - **App Review information:** the notes in `store.config.json` explain demo mode. Keep them.
7. Choose the build, press **Add for Review**.

### What App Review will look at

- **"I cannot connect to a Mac."** The app has a demo mode on the first screen ("Try the demo") with sample data. The review notes tell them so. If you ever remove demo mode, the app will be rejected under guideline 2.1 (a reviewer must be able to see the app work).
- **Local network permission.** The app asks only when it connects to your Mac; the purpose text is in the app.
- **App Transport Security.** The relay speaks plain `ws://` on a private network. The app declares only `NSAllowsLocalNetworking`, not a global exception. If you reach your Mac through a Tailscale **name** (not an IP address) over plain `ws://`, iOS may block it. Use the Tailscale IP, or put the relay behind HTTPS.
- **Unofficial notice.** The description says Zode is not affiliated with Z.AI or Anthropic. Keep it, and do not use their logos.

## 3. Google Play (Android)

1. **Create the app** in Play Console: name `Zode for ZCode`, default language English (United States), App, Free.
2. **Create a service account** for uploads (one time): Play Console, Setup, API access, create a service account, grant "Release manager". Download the JSON key and save it as `app/play-service-account.json`. It is already ignored by git. **Never commit it.**
3. **The first release must be uploaded by hand.** Google does not allow the API for a brand-new app:
   ```bash
   npx eas-cli build --platform android --profile production      # builds an .aab
   ```
   Download the `.aab` from the EAS link and upload it in Play Console under Testing, Internal testing, Create release. After that first upload you can use:
   ```bash
   npx eas-cli submit --platform android --latest      # goes to the internal track as a draft
   ```
4. **Store listing:** copy the text from `app/store/play/metadata/android/en-US/` and `zh-CN/`. Upload:
   - Icon: `images/icon.png` (512 x 512)
   - Feature graphic: `images/featureGraphic.png` (1024 x 500)
   - Phone screenshots: `images/phoneScreenshots/` (4 files, 1080 x 1920; Play requires exactly 16:9 or 9:16)
5. **App content forms** (all by hand in Play Console, Policy and programs, App content):
   - **Privacy policy:** `https://github.com/zrll2/zode/blob/main/docs/PRIVACY.md`
   - **Data safety:** "No data collected", "No data shared". Data in transit is encrypted: answer **No** (plain `ws://` on a private network), or **Yes** only if you front the relay with TLS.
   - **App access:** "All functionality is available without special access" (the demo mode needs no login).
   - **Ads:** No ads. **Content rating:** answer the questionnaire (no objectionable content). **Target audience:** 18 and over (developer tool). **News app, health, financial:** No.
   - **Government app, advertising ID:** No. The app does not use the advertising ID.
6. **Testing track:** a new personal account needs a closed test with 12 testers for 14 days before it can apply for production. Plan for this.

## 4. Releasing a new version

1. Raise `version` in `app/app.json` (for example `1.0.1`). Build numbers (`buildNumber`, `versionCode`) auto-increment on EAS.
2. Update the release notes (`store.config.json` and `store/play/.../changelogs/<versionCode>.txt`).
3. Build and submit as above.

## Files in `app/`

| File | Purpose |
|---|---|
| `app.json` | Name, version, ids, permissions, privacy manifest, splash, plugins |
| `eas.json` | EAS build and submit profiles |
| `store.config.json` | App Store listing, in EAS Metadata format (English and Simplified Chinese) |
| `store/play/metadata/android/` | Google Play listing text and graphics (fastlane layout) |
| `store/screenshots/ios/` | App Store screenshots, 1320 x 2868 |
| `scripts/store-check.mjs` | `npm run store:check`, the pre-flight |
| `../assets/make-store-graphics.py` | Re-renders the Play icon and feature graphic |

## Why the store name is "Zode for ZCode"

The name "Zode" alone was already taken in App Store Connect (names are unique worldwide). "for ZCode" states compatibility; it does not claim to be the ZCode app. Keep the "not affiliated with Z.AI or Anthropic" line in the description, and never use their logos.
