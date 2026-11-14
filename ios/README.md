# TV Remote for iPhone

A real iPhone app for your TV box. It does everything the web remote does, and a few
things only an app can:

- **Finds the TV by itself** on your Wi-Fi (tv.local, plus Bonjour).
- **Pairs once.** Type the 6-letter code on the TV, or scan its QR code. The pairing is
  kept safely in the iPhone's Keychain.
- **Swipe, tap and touchpad**, the **Apps** grid, **Back / Home**, play/pause, ±10s, volume,
  the **browser bar** for Chrome, and the **keyboard** that pops up when the TV wants typing.
- **Hold to talk.** Apple's own speech recognition turns your words into text and sends
  them to the TV. No certificate setup needed (that was only a Safari limit).
- **"Claude is on it"** strip with **Stop** for the hands-free voice agent, and the screen
  for adding your Claude key.
- **Your iPhone's volume buttons turn the TV up and down** while the app is open
  (you can switch this off under •••).
- **Control Center and Lock Screen buttons:** Talk to TV, Play/Pause, Volume up/down.
- **Siri and the Action button:** "Hey Siri, tell TV Remote" then say "play jazz on YouTube".
- Gentle **haptics** on every press.

Nothing changes on the TV box. The app speaks the same language as the web remote.

---

## Run it on your iPhone (about 10 minutes, once)

You already have Xcode and your paid Apple developer account from FocusCount, so:

1. **Open the project.** In Finder go to **Desktop › Coding_Projects › TVRemote** and
   double-click **TVRemote.xcodeproj**. Xcode opens.
2. **Pick your team (if Xcode asks).** In the left sidebar click the blue **TVRemote**
   icon at the very top. In the middle, click **Signing & Capabilities**.
   - Under **Targets**, click **TVRemote** and choose your name in the **Team** menu.
   - Then click **TVRemoteWidgets** and choose the same team.
   - If the team is already filled in, skip this step. (A copy from GitHub always starts blank.)
3. **Plug in your iPhone** with its cable. Unlock it and tap **Trust** if it asks.
4. **Pick your iPhone** in the bar at the top middle of Xcode (it might say
   "Any iOS Device"). Click it and choose your iPhone's name.
5. **Developer Mode** (only if your iPhone asks): on the iPhone open
   **Settings › Privacy & Security › Developer Mode**, turn it on, and let the phone restart.
   (You likely did this already for FocusCount.)
6. **Press Run** (the ▶ triangle at the top left), or press **⌘R**.
   The first build takes a minute. The app opens on your phone.
7. **Allow the questions the app asks:** Local Network (to find the TV), then later
   Microphone and Speech Recognition (the first time you hold the mic).
8. **Pair:** the TV shows a 6-letter code. Type it in the app. Done.

After this the app stays on your phone like any other app. You don't need the cable again.

### Add the extra buttons (optional)

- **Control Center:** swipe down from the top right, tap **+** (top left), **Add a Control**,
  search **TV Remote**, and pick Talk to TV, Play/Pause or Volume.
- **Lock Screen:** touch and hold the Lock Screen, **Customize › Lock Screen**, tap the
  widget area under the clock, and add **TV Remote**.
- **Action button:** **Settings › Action Button**, swipe to **Shortcut**, choose
  **TV Remote › Talk to the TV**. Press it and just speak.
- **Siri:** say "Hey Siri, tell TV Remote", then what you want ("put on The Office").
  With your Claude key added, the TV does it by itself.

---

## If something's off

- **"Not paired" and no code on the TV:** make sure the phone is on the home Wi-Fi.
  The code shows in the corner of the TV when no phone is connected.
- **It can't find the TV:** on the pairing screen tap **TV address** and type
  `192.168.0.50` (the box's number on your network).
- **Xcode says "Failed to register bundle identifier":** in Signing & Capabilities change
  **Bundle Identifier** to something unique, like `com.yourname.tvremote` (and the widget's
  to the same plus `.widgets`), and change the **App Group** to match on both targets.
- **Control Center buttons say they can't reach the TV:** they work on the home Wi-Fi only,
  and the app needs to have been opened and paired once.

## For the developers

- `TVRemote/` app (SwiftUI, iOS 18+). `TVLink.swift` is the WebSocket link
  (heartbeat 10 s, 25 s silence = dead, backoff 0.4 s → 8 s, wake on foreground and network
  change, forget on close 4001 / `unpaired`, re-check pairing on 403/404).
- `Shared/` is in both the app and the widget extension: networking + trust (`Net.swift`),
  Keychain pairing in the App Group (`Keychain.swift`), one-shot sends (`QuickSend.swift`),
  App Intents (`Intents.swift`).
- `TVRemoteWidgets/` Control Center controls and the Lock Screen / Home Screen widget.
- **https:** the app prefers `https://tv.local` and trusts the box's own certificate, but only
  for `.local` names and private home-network addresses. It falls back to plain http on the
  home network (allowed by `NSAllowsLocalNetworking`). The Claude key is only ever sent over https.
- **Bonjour:** the app browses `_tvremote._tcp`. The box doesn't advertise that today, so
  discovery uses `tv.local` (which already works). Optional box change, if wanted later:
  an Avahi file `/etc/avahi/services/tvremote.service` advertising `_tvremote._tcp` on port 80.
  Not required.
- `Config/make-project.py` regenerates `project.pbxproj` (pass the Team ID as the 2nd argument).
