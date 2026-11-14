# Setting up your TV box

Everything runs on the box itself. Your phone talks to it over your home Wi-Fi, and only Netflix, YouTube and the other services come from the internet. There are no accounts to make.

**What you need:** the Chromebox on your TV (HDMI), a USB keyboard and mouse for the first setup, your Wi-Fi password, and your iPhone on the same Wi-Fi.

---

## 1. Get the box online

Log in on the box. If it's not on Wi-Fi yet, click the network icon at the top right of the desktop and pick your Wi-Fi, or type `sudo nmtui` in Terminal.

## 2. Install the TV software

Download **install-tv.sh** to the box's Downloads folder. Then open **Terminal** and type:

```
sudo bash ~/Downloads/install-tv.sh
```

Type your password when it asks. Nothing shows while you type it, and that's normal. It takes 5–10 minutes and ends with **All set**. Then type `sudo reboot`.

After the restart, the box goes straight into the TV screen. It names itself **tv**, so your phone finds it at **tv.local**.

## 3. Pair your iPhone

1. The TV shows a code and a QR code. Point the iPhone **Camera** at the QR code and tap the link.
   *No luck? In Safari, go to `tv.local` and type the code.*
2. Keep the remote on your Home Screen: in Safari, tap **Share**, then **Add to Home Screen**.

## 4. Turn on voice (one time)

iPhones only let a web page use the microphone on a secure connection, so your phone needs to trust the box once. Press the mic button in the remote and follow the sheet:
1. Tap **Get the TV box certificate**, then **Allow**.
2. Go to **Settings › General › VPN & Device Management**, tap **TV box**, then **Install**.
3. Go to **Settings › General › About › Certificate Trust Settings** and turn on **TV box**.
4. Back in the remote, tap **Done**, then **Switch to the secure remote**. Add it to your Home Screen again, and delete the old icon.

Simple asks work right away: "open Netflix", "play The Office on Netflix", "pause", "turn it up". For smarter search ("that new show with Adam Scott"), you can add an Anthropic API key later. Ask me and I'll show you where it goes.

## 5. Sign in to your services

Swipe to each service and tap to open it. When a sign-in box is selected on the TV, a keyboard pops up on your phone. You can type there, or let iCloud Keychain fill in your password.
- **YouTube:** pick the sign-in option that shows a code, then on your phone go to **youtube.com/activate** and enter it.
- Press **Home** on the phone to come back.

---

## Updates

New versions come as a new **install-tv.sh**. Updating just the app needs no password:

```
bash install-tv.sh --update
```

The TV reloads by itself within a few seconds. A full `sudo bash install-tv.sh` is only needed when I say so, for example to add a system package.

## If something's wrong

| What you see | What to do |
|---|---|
| The phone says it can't connect | Make sure the phone is on your home Wi-Fi, not mobile data. Then reopen the remote. |
| `tv.local` doesn't open | Wait a minute after the box starts, then try again. |
| No sound | Turn up the TV volume first. Then tell me, and I'll check which output the box is using. |
| Netflix or Prime looks a bit soft | Expected: on Linux they top out at 720p. |
| You need the desktop back for a while | Press Ctrl+Alt+F3, log in, and type `sudo systemctl stop tv-kiosk && sudo systemctl start gdm`. A restart puts the TV back. |
