# Mario & Luigi

Super Mario Bros. together on two iPhones. Mario's phone runs both players' games (so the DS
link stays fast), and Luigi's phone gets its own screen streamed through a small server on Railway.

- `MarioLuigi/` — the iPhone app (SwiftUI shell + the game page in `MarioLuigi/Web/`).
  The game file `MarioLuigi/Web/nsmb-coop.nds` is NOT in GitHub; it lives only on the Mac.
- `relay/` — the server that connects the two phones by a 4-letter room code (Node, no packages).

## Server on Railway (once)
1. railway.com → New Project → Deploy from GitHub repo → `jradmac/tv-interface`.
2. Open the service → Settings → **Root Directory**: `mario-luigi/relay`.
3. Settings → Networking → **Generate Domain**. Copy the address (like `https://something.up.railway.app`).
4. Check it: open `https://<that address>/health` in Safari. It should say `ok`.
5. The app's default server address is set to it (or type it under "Server" on the app's start screen).

## App on the iPhones
Open `MarioLuigi.xcodeproj` in Xcode, pick your iPhone at the top, press ▶ Run. Do the same for the
second phone (any iPhone you plug into this Mac). Turn the phone sideways.
