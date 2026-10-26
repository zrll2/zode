# Zode for Mac

## 1.4.1
- **Tell Claude Code.** Zode now tells Claude Code when a ZCode conversation finishes, fails, needs an answer or looks stuck, so a Claude Code session that delegated the work notices right away instead of being checked by hand. One switch in Settings (on by default) installs a small Claude Code skill and turns the feed on; turning it off removes the skill. Nothing but the project name and conversation title is shared, and only on your Mac.

## 1.4.0
- **A redesigned panel.** One queue with no headings: what needs you first, then what is running with how long each run has lasted, then a single "finished" row that opens in place. The top bar holds your phones, refresh and settings; the footer shows today's token use and Open Zode.
- **A smaller menu bar icon** with a status light (green while work runs, amber when something needs you) and the number of running conversations beside it.
- Settings is grouped, with switches and segmented choices instead of long labels.
- Notifications reach your phone: sealed end to end, they need the new phone build.

## 1.3.1
- **Notifications.** A macOS notification when a conversation finishes, fails, needs an answer or looks stuck. One switch in Settings (on by default), short bursts are grouped, and nothing about your commands or files is shown.
- **Cleaner text.** Settings, banners, toasts and the setup and pairing windows lost their explanatory sentences; the layout does the explaining.
- Fixed a rare break in the app's main file that is now covered by a test.

## 1.2.0
- **ZCode never waits for you (new default).** Zode now allows ZCode's permission requests automatically, the moment they appear. Questions that need a human answer are never answered for you. Turn it off in Settings: **Allow ZCode requests automatically**.
- **Keep asking for risky commands.** A second switch (off by default): even with automatic approval on, commands like `rm -rf`, `sudo`, `git push` and `curl` wait for you. The Mac and the phone now share one list of what counts as risky.
- **Note:** with automatic approval on, ZCode can run any command in the projects it works in, without asking. Use the risky-command switch if you want a safety net, or turn automatic approval off.
- The "Always allow" button on a pile of requests now matches the other buttons.
- Documentation brought up to date (README, security, phone and setup guides); the older Zode-in-ZCode app no longer clears the new app's settings.

## 1.1.1
- **Answer a pile of permission requests at once.** When a conversation keeps asking for the same permission, the card now offers Allow all, Deny all and Always allow this here (ZCode's own "always allow in this project" rule), plus Stop task.
- **Fixed:** the menu bar panel showed old conversations as "Just now"; it uses the real last-activity time again.
- **Fixed:** the older Zode-in-ZCode app no longer wipes the newer settings (setup, keep awake, voice) from the shared settings file.
- **Fixed:** a phone answering a permission request could crash the relay if ZCode had just closed.
- The refresh button no longer shows a permanent focus ring, and conversation summaries drop leading markdown marks.
- The relay now logs which address (Wi-Fi or Tailscale) a phone connects through, to make connection problems easy to diagnose.

## 1.1.0
- **Connects over Wi-Fi and Tailscale at once.** The phone now learns every address of your Mac and uses whichever works, so leaving the Wi-Fi no longer drops the connection. The Mac re-checks its network every 10 seconds. Choose a single address in Settings if you prefer.
- **Running work shows up.** Conversations that are mid-turn now appear under Working (the agent never reported this itself); stale "waiting" cards clear on their own.
- **Panel footer:** the phone chip opens a list of your phones (connected or last seen, with Remove and Pair a new phone), and the middle shows your token use today and over 7 days.
- **Working rows show the conversation summary** instead of the word "Working".
- **Loops are visible:** when a conversation keeps asking for the same permission, the card says how many more are waiting and offers Stop task.
- **A white menu bar icon** drawn to match the app logo, readable on any menu bar.
- **Voice, under the hood:** Zode can transcribe speech on your Mac (English and Chinese, Whisper) for upcoming phone and watch features. Settings has a Voice section to download the model.

## 1.0.2
- **A new menu bar panel.** Click the Z to see what needs you, what is running and what finished, with Allow, Deny, Nudge and Stop right there. Settings moved behind the gear. Right-click still opens the classic menu.
- **The icon shows state:** a green dot when work is running, an amber dot when something needs you.

## 1.0.1
- **Fixed:** conversations that ZCode had merely loaded no longer show as "Just now" in the menu (the status list and the phone's session list now use the real last-activity time).
- **Fixed:** the status lights and green ticks were missing from the menu.

Control ZCode from your phone. Zode for Mac is a menu bar app: it makes its own copy of ZCode (your original is never changed), lets your phone talk to it, and keeps both up to date.

- **Set up in a minute, no terminal:** a short window finds ZCode, builds the copy, waits for you to sign in and shows the QR code for your phone.
- **See everything ZCode is doing:** the menu shows each conversation with a status light, and lets you approve, deny, nudge or retry from the menu bar.
- **Stays awake for you:** optionally keeps your Mac awake while Zode is on, so the phone does not lose it.
- **Updates itself,** and updates ZCode when a new version is out.

Requires an Apple silicon Mac, macOS 13 or newer, and ZCode.
