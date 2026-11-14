#!/usr/bin/env bash
# Turns this Debian 13 box into the TV. Everything runs on the box:
#   full-screen Chrome showing the TV home, a small server for the phone remote, and the box agent.
# Run it with:   sudo bash install-tv.sh
# Safe to run again: it keeps the box's pairing and settings.
# App-only update, no password needed:   bash install-tv.sh --update
set -euo pipefail

TV_USER=tv
APP="${TV_APP:-/opt/tv}"
STATE_DIR=/var/lib/tv-agent
TV_HOSTNAME="${TV_HOSTNAME:-tv}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }

# The app files are packed at the end of this script.
PAYLOAD_LINE=$(awk '/^__PAYLOAD__$/ { print NR + 1; exit }' "$0")
[ -n "$PAYLOAD_LINE" ] || fail "this installer file is incomplete. Download it again."

# The Claude Code terminal (termd) runs as the box's main user, never as root.
# The full install makes it a system service (tv-term). An update without a password keeps
# it running as a user service instead, or, if that isn't possible, starts it for now.
TERM_NOTE=""
term_update() {
  local me unit node
  me=$(id -un); node=$(command -v node)
  if [ -f /etc/systemd/system/tv-term.service ]; then
    [ "$TERMD_CHANGED" = 1 ] && date > "$APP/RELOAD-TERM"   # tv-term-reload.path restarts it
    return 0
  fi
  if systemctl --user show-environment >/dev/null 2>&1; then
    unit="$HOME/.config/systemd/user/tv-term.service"
    mkdir -p "$(dirname "$unit")"
    cat > "$unit" <<EOF
[Unit]
Description=Claude Code terminal for the TV
[Service]
Environment=TV_SERVER=http://127.0.0.1
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$HOME
ExecStart=$node $APP/termd/termd.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable tv-term.service >/dev/null 2>&1 || true
    if [ "$TERMD_CHANGED" = 1 ] || ! systemctl --user is-active --quiet tv-term.service; then systemctl --user restart tv-term.service || TERM_NOTE="Claude Code didn't start. See: journalctl --user -u tv-term -n 30"; fi
    if [ "$(loginctl show-user "$me" -p Linger --value 2>/dev/null)" != yes ] && ! loginctl enable-linger "$me" 2>/dev/null; then
      TERM_NOTE="Claude Code is on. To keep it on after the box restarts, run once:  sudo bash $0"
    fi
    return 0
  fi
  # No user services here: start it in the background for now.
  if [ "$TERMD_CHANGED" = 1 ]; then pkill -u "$me" -f "$APP/termd/termd.mjs" 2>/dev/null || true; sleep 1; fi
  if ! pgrep -u "$me" -f "$APP/termd/termd.mjs" >/dev/null; then
    mkdir -p "$HOME/.cache"
    ( cd "$HOME" && TV_SERVER=http://127.0.0.1 PATH="$HOME/.local/bin:$PATH" exec setsid -f "$node" "$APP/termd/termd.mjs" ) > "$HOME/.cache/tv-term.log" 2>&1 < /dev/null
  fi
  TERM_NOTE="Claude Code is on. To keep it on after the box restarts, run once:  sudo bash $0"
}

# --update: swap in the new app files and restart the TV software. Needs no password, because
# /opt/tv belongs to the box's main user and a small root service does the restart.
if [ "${1:-}" = "--update" ]; then
  [ -w "$APP" ] || fail "$APP isn't writable by $(id -un). Run the full install once:  sudo bash $0"
  rm -rf "$APP/.new" && mkdir -p "$APP/.new"
  tail -n +"$PAYLOAD_LINE" "$0" | base64 -d | tar -xz -C "$APP/.new"
  if ! node --check "$APP/.new/server/server.mjs" || ! node --check "$APP/.new/agent/agent.mjs"; then
    rm -rf "$APP/.new"; fail "the new app files look broken; nothing was changed."
  fi
  OLD_TERMD=$(cat "$APP"/termd/* 2>/dev/null | sha256sum || true)
  for d in "$APP/.new"/*; do n=$(basename "$d"); rm -rf "${APP:?}/$n"; mv "$d" "$APP/$n"; done
  rm -rf "$APP/.new"
  node "$APP/box/nature.mjs" "$APP" || echo "(Nature theme photos skipped; the theme uses painted scenes.)"
  date > "$APP/RELOAD"   # tv-reload.path sees this and restarts tv-server + tv-agent
  TERMD_CHANGED=0; [ "$(cat "$APP"/termd/* 2>/dev/null | sha256sum || true)" = "$OLD_TERMD" ] || TERMD_CHANGED=1
  term_update
  echo "Updated. The TV reloads in a few seconds."
  [ -z "$TERM_NOTE" ] || echo "$TERM_NOTE"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || fail "run it with sudo:  sudo bash $0"
# The box's main user (the one who ran sudo) owns the app files, so later updates need no password.
OWNER="${SUDO_USER:-}"
if [ -z "$OWNER" ] || [ "$OWNER" = root ]; then OWNER=$(getent passwd 1000 | cut -d: -f1 || true); fi
[ -n "$OWNER" ] || OWNER=root
OWNER_HOME=$(getent passwd "$OWNER" | cut -d: -f6)
[ "$(dpkg --print-architecture)" = amd64 ] || fail "this script is for a 64-bit Intel/AMD box."
. /etc/os-release
[ "${VERSION_CODENAME:-}" = trixie ] || echo "Note: made for Debian 13 (trixie); this is ${PRETTY_NAME:-unknown}. Carrying on."
curl -fsS -o /dev/null https://deb.debian.org/ 2>/dev/null || ping -c1 -W3 deb.debian.org >/dev/null 2>&1 || fail "the box isn't online. Connect Wi-Fi first."

export DEBIAN_FRONTEND=noninteractive

say "1/7  Installing system packages (a few minutes)"
# The box has a small disk (16 GB): make room first. Old downloaded packages, old logs, and
# Chrome's caches all grow back on their own if needed.
apt-get clean
journalctl --vacuum-size=50M >/dev/null 2>&1 || true
TV_HOME=$(getent passwd "$TV_USER" | cut -d: -f6)
# Chrome can't have its caches pulled out from under it: stop the screen (it restarts at the end).
KIOSK_STOPPED=""
if [ -n "$TV_HOME" ] && systemctl is-active --quiet tv-kiosk.service 2>/dev/null; then systemctl stop tv-kiosk.service || true; KIOSK_STOPPED=1; fi
[ -n "$TV_HOME" ] && for d in "$TV_HOME/.config/tv-chrome/Default" "$TV_HOME/.cache/google-chrome/Default" "$TV_HOME/.config/tv-chrome"; do
  [ -d "$d" ] || continue
  rm -rf "$d/Cache" "$d/Code Cache" "$d/GPUCache" "$d/Service Worker/CacheStorage" "$d/GrShaderCache" "$d/ShaderCache" 2>/dev/null || true
done
apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl openssl kbd python3 \
  cage xwayland fonts-noto-core fonts-noto-color-emoji \
  pipewire pipewire-pulse wireplumber pulseaudio-utils dbus-user-session \
  i965-va-driver vainfo \
  nodejs avahi-daemon libnss-mdns \
  network-manager openssh-server unattended-upgrades
apt-get clean
# Real key presses for Chrome's own bubbles ("Save password?"). Optional: the TV works without it.
apt-get install -y -q --no-install-recommends wtype || echo "  (wtype isn't available; Chrome's bubbles can't be answered from the phone)"

say "2/7  Installing Google Chrome (it has the video licences Netflix and Prime need)"
if ! command -v google-chrome-stable >/dev/null; then
  TMP=$(mktemp -d)
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$TMP/chrome.deb"
  apt-get install -y -q "$TMP/chrome.deb"   # also adds Google's update source
  rm -rf "$TMP"
fi

# Chrome rules for the TV: never ask to show notifications or for the location, and never offer
# to translate (nothing on a TV should need answering). Other Chrome bubbles, like "Save password?",
# take real key presses from the phone (wtype, above).
install -d -m 0755 /etc/opt/chrome/policies/managed
cat > /etc/opt/chrome/policies/managed/tv.json <<'EOF'
{
  "DefaultNotificationsSetting": 2,
  "DefaultGeolocationSetting": 2,
  "TranslateEnabled": false
}
EOF
# Optional: stop Chrome Sync from installing his computer's extensions on the TV (their welcome
# tabs take over the screen). sudo bash install-tv.sh --block-extensions turns it on,
# --allow-extensions turns it off; with neither, the last choice stays.
case " $* " in
  *" --block-extensions "*) cat > /etc/opt/chrome/policies/managed/tv-extensions.json <<'EOF'
{
  "SyncTypesListDisabled": ["extensions", "apps"],
  "ExtensionInstallBlocklist": ["*"]
}
EOF
    echo "  Extensions from Chrome Sync are blocked on the TV" ;;
  *" --allow-extensions "*) rm -f /etc/opt/chrome/policies/managed/tv-extensions.json; echo "  Extensions are allowed on the TV" ;;
esac

say "3/7  Naming the box '$TV_HOSTNAME' so your phone can find it at $TV_HOSTNAME.local"
OLD_HOST=$(hostname)
if [ "$OLD_HOST" != "$TV_HOSTNAME" ]; then
  hostnamectl set-hostname "$TV_HOSTNAME"
  sed -i "s/^127\.0\.1\.1\s.*/127.0.1.1\t$TV_HOSTNAME/" /etc/hosts
  grep -q "^127\.0\.1\.1" /etc/hosts || printf '127.0.1.1\t%s\n' "$TV_HOSTNAME" >> /etc/hosts
fi
systemctl enable --now avahi-daemon >/dev/null 2>&1 || true
systemctl restart avahi-daemon || true

say "4/7  Creating the '$TV_USER' user and copying the TV app"
id "$TV_USER" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$TV_USER"
for g in video render audio input; do getent group "$g" >/dev/null && usermod -aG "$g" "$TV_USER"; done
loginctl enable-linger "$TV_USER" || true
TV_UID=$(id -u "$TV_USER")
rm -rf "$APP.new" && mkdir -p "$APP.new"
tail -n +"$PAYLOAD_LINE" "$0" | base64 -d | tar -xz -C "$APP.new"
node --check "$APP.new/server/server.mjs" && node --check "$APP.new/agent/agent.mjs" || fail "the app files look broken. Download the installer again."
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"; mv "$APP.new" "$APP"
[ -d "$APP.old/themes" ] && mv "$APP.old/themes" "$APP/themes"   # keep downloaded theme photos
rm -rf "$APP.old"
chown -R "$OWNER:$OWNER" "$APP"
chmod -R go-w "$APP"
# Photos for the Nature theme (skipped quietly if they can't be downloaded).
runuser -u "$OWNER" -- node "$APP/box/nature.mjs" "$APP" || true
# An invisible mouse pointer for the TV screen (the phone's touchpad draws its own dot).
node "$APP/box/blank-cursor.mjs" /usr/share/icons/tv-blank >/dev/null
# Cage loads the cursor theme named "default" whatever XCURSOR_THEME says, so give the screen its
# own cursor folder where "default" is the blank one. (The rest of the system keeps its arrow.)
rm -rf /usr/share/tv-cursors/default
node "$APP/box/blank-cursor.mjs" /usr/share/tv-cursors/default >/dev/null
install -d -m 0700 -o "$TV_USER" -g "$TV_USER" "$STATE_DIR"
[ -f "$STATE_DIR/settings.json" ] || { echo '{ "anthropicKey": "" }' > "$STATE_DIR/settings.json"; }
chown "$TV_USER:$TV_USER" "$STATE_DIR/settings.json"; chmod 600 "$STATE_DIR/settings.json"
# If the box was renamed, Chrome's home address changes with it.
rm -f "$STATE_DIR/home-url"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_FLAGS=""; [ "$NODE_MAJOR" -lt 22 ] && NODE_FLAGS="--experimental-websocket"

say "5/7  Setting up the services"
cat > /etc/systemd/system/tv-server.service <<EOF
[Unit]
Description=TV box server (TV home, phone remote, pairing, voice)
After=network-online.target avahi-daemon.service
Wants=network-online.target

[Service]
User=$TV_USER
Environment=TV_STATE_DIR=$STATE_DIR
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/bin/node $APP/server/server.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/tv-agent.service <<EOF
[Unit]
Description=TV box agent (drives Chrome for the remote)
After=tv-server.service
Wants=tv-server.service

[Service]
User=$TV_USER
Environment=XDG_RUNTIME_DIR=/run/user/$TV_UID
Environment=TV_AGENT_DIR=$STATE_DIR
Environment=TV_SERVER=http://127.0.0.1
ExecStart=/usr/bin/node $NODE_FLAGS $APP/agent/agent.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/bin/tv-chrome <<'EOF'
#!/bin/sh
# Starts Chrome full screen on the TV home. The agent writes the home address when it starts.
HOME_FILE=/var/lib/tv-agent/home-url
PROFILE="$HOME/.config/tv-chrome"
i=0
while [ ! -s "$HOME_FILE" ] && [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done
URL=$(cat "$HOME_FILE" 2>/dev/null || echo about:blank)
# After a power cut, don't show "Chrome didn't shut down correctly".
PREFS="$PROFILE/Default/Preferences"
[ -f "$PREFS" ] && sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$PREFS"
exec /usr/bin/google-chrome-stable \
  --kiosk --start-fullscreen --ozone-platform=wayland \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=9222 \
  --enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,VaapiIgnoreDriverChecks \
  --disable-features=Translate,MediaRouter \
  --autoplay-policy=no-user-gesture-required \
  --noerrdialogs --disable-infobars --no-first-run --no-default-browser-check \
  --hide-crash-restore-bubble --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --password-store=basic \
  --disk-cache-size=134217728 --media-cache-size=67108864 \
  "$URL"
EOF
chmod 755 /usr/local/bin/tv-chrome

cat > /etc/systemd/system/tv-kiosk.service <<EOF
[Unit]
Description=TV screen (Chrome full screen in Cage)
After=systemd-user-sessions.service plymouth-quit-wait.service getty@tty1.service tv-agent.service
Conflicts=getty@tty1.service

[Service]
User=$TV_USER
PAMName=login
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
StandardOutput=journal
StandardError=journal
UtmpIdentifier=tty1
UtmpMode=user
Environment=XDG_SESSION_TYPE=wayland
Environment=XCURSOR_THEME=default
Environment=XCURSOR_SIZE=24
Environment=XCURSOR_PATH=/usr/share/tv-cursors
# The screen only starts on the visible console: switch to it first (as root, hence the +),
# so a restart works even while someone is logged in on another console (Ctrl+Alt+F3).
ExecStartPre=+-/bin/chvt 1
ExecStart=/usr/bin/cage -d -s -- /usr/local/bin/tv-chrome
Restart=always
RestartSec=2

[Install]
WantedBy=graphical.target
EOF

# Restart Chrome early each morning so Chrome updates take effect.
cat > /etc/systemd/system/tv-refresh.service <<'EOF'
[Unit]
Description=Restart the TV screen to pick up Chrome updates
[Service]
Type=oneshot
ExecStart=/bin/systemctl restart tv-kiosk.service
EOF
cat > /etc/systemd/system/tv-refresh.timer <<'EOF'
[Unit]
Description=Restart the TV screen daily at 4:45
[Timer]
OnCalendar=*-*-* 04:45
[Install]
WantedBy=timers.target
EOF

# Watchdog: if the screen is "running" but Chrome isn't answering, restart the screen.
cat > /usr/local/sbin/tv-watchdog <<'EOF'
#!/bin/sh
# Runs every 30 seconds as root (tv-watchdog.timer).
systemctl is-active --quiet tv-kiosk.service || exit 0      # stopped on purpose: leave it
since=$(systemctl show -p ActiveEnterTimestampMonotonic --value tv-kiosk.service)
now=$(awk '{ printf "%d", $1 * 1000000 }' /proc/uptime)
[ $((now - ${since:-0})) -gt 90000000 ] || exit 0           # give a fresh start 90 seconds
curl -fsS -m 4 -o /dev/null http://127.0.0.1:9222/json/version && exit 0
logger -t tv-watchdog "Chrome isn't answering; restarting the TV screen"
chvt 1 || true
systemctl restart tv-kiosk.service
EOF
chmod 755 /usr/local/sbin/tv-watchdog
cat > /etc/systemd/system/tv-watchdog.service <<'EOF'
[Unit]
Description=Restart the TV screen if Chrome stops answering
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/tv-watchdog
EOF
cat > /etc/systemd/system/tv-watchdog.timer <<'EOF'
[Unit]
Description=Check the TV screen every 30 seconds
[Timer]
OnBootSec=2min
OnUnitActiveSec=30s
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF

# App updates without a password: writing /opt/tv/RELOAD restarts the TV software (and nothing else).
cat > /etc/systemd/system/tv-reload.path <<EOF
[Unit]
Description=Restart the TV software when the app is updated
[Path]
PathChanged=$APP/RELOAD
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/tv-reload.service <<'EOF'
[Unit]
Description=Restart the TV software after an app update
[Service]
Type=oneshot
ExecStart=/bin/systemctl restart tv-server.service
ExecStart=/bin/sleep 1
ExecStart=/bin/systemctl restart tv-agent.service
EOF

# The Claude Code terminal on the TV. It runs as $OWNER (never root), listens only on the box
# itself, and only the TV's own screen can reach it (the TV server checks that).
if [ "$OWNER" != root ]; then
  # Replace the user service an earlier password-free update may have set up.
  pkill -u "$OWNER" -f "$APP/termd/termd.mjs" 2>/dev/null || true
  systemctl --user -M "$OWNER@" disable --now tv-term.service >/dev/null 2>&1 || true
  rm -f "$OWNER_HOME/.config/systemd/user/tv-term.service"
  cat > /etc/systemd/system/tv-term.service <<EOF
[Unit]
Description=Claude Code terminal for the TV (runs as $OWNER)
After=tv-server.service

[Service]
User=$OWNER
WorkingDirectory=$OWNER_HOME
Environment=HOME=$OWNER_HOME
Environment=TV_SERVER=http://127.0.0.1
Environment=PATH=$OWNER_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node $APP/termd/termd.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  # An app update that changes the terminal itself restarts it (other updates leave the session alone).
  cat > /etc/systemd/system/tv-term-reload.path <<EOF
[Unit]
Description=Restart the Claude Code terminal when it is updated
[Path]
PathChanged=$APP/RELOAD-TERM
[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/tv-term-reload.service <<'EOF'
[Unit]
Description=Restart the Claude Code terminal after an update
[Service]
Type=oneshot
ExecStart=/bin/systemctl restart tv-term.service
EOF
  TERM_UNITS="tv-term.service tv-term-reload.path"
else
  TERM_UNITS=""
fi

# Keep Claude's Remote Control connection to the box, if it was set up (~/tv-setup/claude-remote.service).
CLAUDE_UNIT=""
if [ -n "$OWNER_HOME" ] && [ -f "$OWNER_HOME/tv-setup/claude-remote.service" ]; then
  install -m 0644 "$OWNER_HOME/tv-setup/claude-remote.service" /etc/systemd/system/claude-remote.service
  CLAUDE_UNIT=claude-remote.service
fi

say "6/7  Housekeeping: no sleep, small logs, automatic security updates"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/tv.conf
cat > /etc/apt/apt.conf.d/51tv-unattended <<'EOF'
Unattended-Upgrade::Origins-Pattern { "origin=Google LLC"; };
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable ssh >/dev/null 2>&1 || true

say "7/7  Starting the TV server and agent"
systemctl daemon-reload
systemctl enable tv-server.service tv-agent.service tv-kiosk.service tv-refresh.timer tv-reload.path tv-watchdog.timer $CLAUDE_UNIT $TERM_UNITS >/dev/null
systemctl restart tv-reload.path tv-watchdog.timer
# Leave a running claude-remote alone (restarting it would cut off the session doing this install).
if [ -n "$CLAUDE_UNIT" ] && ! systemctl is-active --quiet claude-remote.service; then systemctl start claude-remote.service || true; fi
systemctl restart tv-server.service
sleep 2
systemctl restart tv-agent.service
[ -z "$TERM_UNITS" ] || systemctl restart $TERM_UNITS
for i in $(seq 1 30); do [ -s "$STATE_DIR/home-url" ] && break; sleep 1; done
[ -s "$STATE_DIR/home-url" ] || fail "the agent didn't start. See: journalctl -u tv-agent -u tv-server -n 50"
# Already in TV mode (a re-install): restart the screen so its new settings apply.
if [ -n "$KIOSK_STOPPED" ] || systemctl is-active --quiet tv-kiosk.service; then chvt 1 || true; systemctl restart tv-kiosk.service; fi

# The desktop's login screen would fight Chrome for the TV. Turn it off, so after a restart the box is just the TV.
DESKTOP=""
if [ -e /etc/systemd/system/display-manager.service ]; then
  DESKTOP=$(basename "$(readlink -f /etc/systemd/system/display-manager.service)" .service)
  systemctl disable display-manager.service >/dev/null 2>&1 || true
fi
systemctl set-default graphical.target >/dev/null

cat <<EOF

All set. The box is now named "$TV_HOSTNAME".

Last step: restart the box.     sudo reboot

After about a minute the TV shows a pairing code and a QR code.
Point your iPhone camera at it, or open http://$TV_HOSTNAME.local on your phone and type the code.
EOF
if [ -n "$DESKTOP" ]; then cat <<EOF

Note: after the restart the box starts straight into the TV, not the desktop.
To get the desktop back for a while:   sudo systemctl stop tv-kiosk && sudo systemctl start $DESKTOP
EOF
fi
cat <<EOF

If something looks wrong:
  journalctl -u tv-server -u tv-agent -n 50      the TV software's log
  journalctl -u tv-kiosk -n 50                   the screen's log
EOF
exit 0
__PAYLOAD__
