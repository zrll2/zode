# Zode for Mac

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
