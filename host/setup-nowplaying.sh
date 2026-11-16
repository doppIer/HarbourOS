#!/usr/bin/env bash
# Shows what the server's speaker is playing on HarbourOS wall tablets.
# Hooks into what is already on this machine:
#   - shairport-sync (AirPlay): turns on its metadata pipe; a small service reads it.
#   - raspotify (Spotify Connect, librespot): runs a script on every player event.
# Both send title / artist / cover / play state to HarbourOS with a private token.
#
#   sudo bash host/setup-nowplaying.sh          install or update
#   sudo bash host/setup-nowplaying.sh off      remove the hooks
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run it with sudo: sudo bash $0 ${1:-}"; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${HARBOR_PORT:-7080}"
ENVF=/etc/harbour-nowplaying.env
READER=/usr/local/bin/harbour-nowplaying-airplay
HOOK=/usr/local/bin/harbour-nowplaying-spotify
UNIT=/etc/systemd/system/harbour-nowplaying.service
PIPE_DIR=/var/lib/harbour-nowplaying
SP_CONF=/etc/shairport-sync.conf
RS_CONF=/etc/raspotify/conf
MARK="// harbour-nowplaying"

if [ "${1:-}" = "off" ]; then
  systemctl disable --now harbour-nowplaying 2>/dev/null || true
  rm -f "$UNIT" "$READER" "$HOOK" "$ENVF"
  [ -f "$SP_CONF" ] && sed -i "/$MARK begin/,/$MARK end/d" "$SP_CONF" && systemctl restart shairport-sync || true
  [ -f "$RS_CONF" ] && sed -i '/^LIBRESPOT_ONEVENT=.*harbour-nowplaying/d' "$RS_CONF" && systemctl restart raspotify || true
  systemctl daemon-reload
  echo "Now-playing hooks removed."
  exit 0
fi

TOKEN_FILE="$HERE/data/nowplaying.token"
[ -s "$TOKEN_FILE" ] || { echo "No $TOKEN_FILE yet. Update HarbourOS and start it first (git pull && docker compose up -d --build)."; exit 1; }
# data/ is writable by the container: never follow a link planted there, and accept only a token-shaped value.
if [ -L "$TOKEN_FILE" ] || [ ! -f "$TOKEN_FILE" ]; then echo "$TOKEN_FILE must be a plain file."; exit 1; fi
TOKEN="$(head -c 200 "$TOKEN_FILE" | tr -d '\n')"
printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9_-]{16,128}$' || { echo "$TOKEN_FILE doesn't look like a HarbourOS token."; exit 1; }
IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
URL="http://${IP:-127.0.0.1}:$PORT/api/nowplaying/push"
curl -s -o /dev/null -m 5 "http://${IP:-127.0.0.1}:$PORT/" || { echo "HarbourOS doesn't answer on ${IP:-127.0.0.1}:$PORT."; exit 1; }

# Readable by root (AirPlay reader) and the raspotify service user only.
umask 077
printf 'HARBOUR_URL=%s\nHARBOUR_TOKEN=%s\n' "$URL" "$TOKEN" > "$ENVF"
RS_USER="$(systemctl show -p User --value raspotify 2>/dev/null || true)"
RS_DYN="$(systemctl show -p DynamicUser --value raspotify 2>/dev/null || true)"
if [ -n "$RS_USER" ] && [ "$RS_USER" != root ] && id "$RS_USER" >/dev/null 2>&1; then chgrp "$(id -gn "$RS_USER")" "$ENVF"; chmod 640 "$ENVF"
elif [ -z "$RS_USER" ] && [ "$RS_DYN" != yes ]; then chmod 600 "$ENVF"   # raspotify runs as root
else chmod 644 "$ENVF"; echo "Note: raspotify runs as a temporary user, so $ENVF stays readable by all local users."; fi
umask 022

# ---------- AirPlay ----------
if command -v shairport-sync >/dev/null && [ -f "$SP_CONF" ]; then
  SP_USER="$(systemctl show -p User --value shairport-sync 2>/dev/null)"; SP_USER="${SP_USER:-shairport-sync}"
  install -d -m 755 -o "$SP_USER" "$PIPE_DIR"
  if ! grep -q "$MARK begin" "$SP_CONF"; then
    cp "$SP_CONF" "$SP_CONF.before-harbour"
    if grep -qE '^\s*metadata\s*=' "$SP_CONF"; then
      echo "Note: $SP_CONF already has a metadata block; make sure it has enabled=\"yes\", include_cover_art=\"yes\", pipe_name=\"$PIPE_DIR/metadata\"."
    else
      cat >> "$SP_CONF" <<EOF
$MARK begin
metadata = {
    enabled = "yes";
    include_cover_art = "yes";
    pipe_name = "$PIPE_DIR/metadata";
    pipe_timeout = 5000;
};
$MARK end
EOF
    fi
  fi

  cat > "$READER" <<'PY'
#!/usr/bin/env python3
# Reads shairport-sync's metadata pipe and forwards it to HarbourOS.
import base64, json, os, re, sys, time, urllib.request
env = os.environ  # systemd passes /etc/harbour-nowplaying.env (EnvironmentFile)
URL, TOKEN = env["HARBOUR_URL"], env["HARBOUR_TOKEN"]
PIPE = sys.argv[1]

def send(**body):
    body["source"] = "airplay"
    req = urllib.request.Request(URL, json.dumps(body).encode(), {"content-type": "application/json", "x-harbour-token": TOKEN})
    try: urllib.request.urlopen(req, timeout=5).read()
    except Exception as e: print("send failed:", e, file=sys.stderr, flush=True)

item = re.compile(r"<item><type>(\w{8})</type><code>(\w{8})</code><length>(\d+)</length>")
meta, last_title = {}, None
while True:
    if not os.path.exists(PIPE): time.sleep(2); continue
    with open(PIPE, "r", errors="replace") as f:
        buf = ""
        for line in f:
            buf += line
            if "</item>" not in buf: continue
            m = item.search(buf)
            data = re.search(r'<data encoding="base64">\s*(.*?)\s*</data>', buf, re.S)
            buf = ""
            if not m: continue
            typ, code = bytes.fromhex(m.group(1)).decode(errors="replace"), bytes.fromhex(m.group(2)).decode(errors="replace")
            raw = data.group(1).replace("\n", "") if data else ""
            text = lambda: base64.b64decode(raw).decode("utf-8", "replace") if raw else ""
            if typ == "core" and code in ("minm", "asar", "asal"):
                meta[{"minm": "title", "asar": "artist", "asal": "album"}[code]] = text()
            elif typ == "ssnc":
                if code == "mden" and meta:
                    ev = "track" if meta.get("title") != last_title else "meta"
                    last_title = meta.get("title")
                    send(event=ev, state="playing", **meta); meta = {}
                elif code == "PICT" and raw and len(raw) > 200: send(coverData=raw)
                elif code in ("pbeg", "prsm"): send(state="playing")
                elif code == "pfls": send(state="paused")
                elif code == "pend": send(state="stopped"); last_title = None
                elif code == "snam": send(device=text())
                elif code == "prgr":
                    try:
                        s, c, e = (int(x) for x in text().split("/"))
                        send(position=max(0, (c - s) * 1000 // 44100), duration=max(0, (e - s) * 1000 // 44100))
                    except ValueError: pass
PY
  chmod 755 "$READER"

  cat > "$UNIT" <<EOF
[Unit]
Description=HarbourOS now playing (AirPlay)
After=shairport-sync.service

[Service]
# Not root: the shairport user owns the pipe; systemd reads the token file for it.
User=$SP_USER
EnvironmentFile=$ENVF
NoNewPrivileges=yes
ExecStart=$READER $PIPE_DIR/metadata
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl restart shairport-sync
  systemctl enable --now harbour-nowplaying
  systemctl restart harbour-nowplaying
  echo "AirPlay: on"
else
  echo "AirPlay: shairport-sync not found, skipped"
fi

# ---------- Spotify Connect ----------
if [ -f "$RS_CONF" ]; then
  cat > "$HOOK" <<'SH'
#!/bin/sh
# librespot --onevent hook: forwards Spotify Connect events to HarbourOS.
. /etc/harbour-nowplaying.env
post() { curl -s -m 4 -o /dev/null -H "content-type: application/json" -H "x-harbour-token: $HARBOUR_TOKEN" --data-binary @- "$HARBOUR_URL"; }
case "$PLAYER_EVENT" in
  track_changed)
    jq -n --arg t "$NAME" --arg a "$ARTISTS" --arg al "$ALBUM" --arg c "$(printf '%s\n' "$COVERS" | head -n1)" --arg d "${DURATION_MS:-0}" \
      '{source:"spotify",event:"track",title:$t,artist:($a|gsub("\n";", ")),album:$al,cover:$c,duration:($d|tonumber)}' | post ;;
  playing)  jq -n --arg p "${POSITION_MS:-0}" '{source:"spotify",state:"playing",position:($p|tonumber)}' | post ;;
  paused)   jq -n --arg p "${POSITION_MS:-0}" '{source:"spotify",state:"paused",position:($p|tonumber)}' | post ;;
  seeked|position_correction) jq -n --arg p "${POSITION_MS:-0}" '{source:"spotify",position:($p|tonumber)}' | post ;;
  stopped|session_disconnected) printf '{"source":"spotify","state":"stopped"}' | post ;;
esac
exit 0
SH
  chmod 755 "$HOOK"
  sed -i '/^LIBRESPOT_ONEVENT=/d' "$RS_CONF"
  echo "LIBRESPOT_ONEVENT=$HOOK" >> "$RS_CONF"
  systemctl restart raspotify
  echo "Spotify Connect: on"
else
  echo "Spotify Connect: raspotify not found, skipped"
fi

# ---------- volume ----------
# HarbourOS reaches the host as this user (TERMINAL_SSH_USER); it needs the sound card for the volume slider.
HUSER="${TERMINAL_SSH_USER:-harbor}"
if id "$HUSER" >/dev/null 2>&1 && command -v amixer >/dev/null; then
  usermod -aG audio "$HUSER" && echo "Volume: $HUSER can use the sound card"
else
  echo "Volume: skipped (no '$HUSER' user or no amixer)"
fi

echo
echo "Done. Play something to the server from your phone; the wall shows it."
