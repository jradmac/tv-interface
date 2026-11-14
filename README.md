# TV Interface

A home-made TV system in two parts:

| Folder | What it is | Where it runs |
|---|---|---|
| [`tv-box/`](tv-box/) | The TV screen interface, the phone web remote, and the small server that ties them together | The HP Chromebox plugged into the TV (Debian Linux) |
| [`ios/`](ios/) | The native iPhone remote app (SwiftUI, with Control Center and Lock Screen buttons) | Your iPhone, built with Xcode on the Mac |

## tv-box

- `tv/` is the screen you see on the TV: the floating service cards, themes, ambient sounds and voice results.
- `remote/` is the web remote you open on a phone at `tv.local`.
- `server/` is the Node server (no extra packages) that serves everything and passes messages between the phone and the TV.
- `agent/` drives the Chrome kiosk on the TV (opening services, clicking, typing) and the optional Claude voice helper.
- `shared/` holds code both sides use, like the list of services.
- `term/` and `termd/` are the Claude Code terminal card.
- `games/` and `games-bin/src/` are the game screen and controller pad. The emulator binaries, game files and box art are **not** in this repo.
- `box/` has the installer. `box/build.sh` packs everything into one `install-tv.sh` file.
- `tests/` are the automated checks (Playwright).

Setup steps for the box are in [`tv-box/SETUP.md`](tv-box/SETUP.md).

## ios

Open `ios/TVRemote.xcodeproj` in Xcode. The signing team is left blank on purpose, so pick your own team under **Signing & Capabilities** for both the `TVRemote` and `TVRemoteWidgets` targets. Full steps are in [`ios/README.md`](ios/README.md).

## Not included

No API keys, pairing secrets, certificates or box settings are stored here. The Claude key is typed in from the phone and lives only on the box.
