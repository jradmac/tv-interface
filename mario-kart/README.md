# Kart Party

Mario Kart DS for up to 4 players. The host's iPhone (in this app) runs all four racers' Nintendo DS
consoles, linked inside the phone so the game's wireless play works. Friends join from anywhere:
with a link in any browser (`<server>/kart/ABCD`), or with the code in this app. Their buttons and tilt
go to the host through the relay server, and their own screens and sound come back.

- `MarioKart/` — the iPhone app (SwiftUI shell + the game page in `MarioKart/Web/`).
- The relay server is the Mario & Luigi one (`mario-luigi/relay/relay.mjs`): it also has Kart Party rooms.
- The game file is NOT in GitHub and is never served to friends. Either put it in `MarioKart/Web/mkds.nds`
  before building, or tap "Choose the game file" in the app once (it's kept inside the app).

## Controls
Tilt the phone to steer (or the left stick), GAS (A), DRIFT (R), BRAKE (B), ITEM (L). The gauge button
turns on auto gas so you only steer. Tap the small screen to swap the map and the race.

## To race
1. Everyone opens the game, picks **Multiplayer**, and the host's player makes the group; the others join it.
2. Works best on a recent iPhone, plugged in: the host's phone runs all four consoles.
