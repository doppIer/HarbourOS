#!/usr/bin/env bash
# Run ON THE HOST, from the HarbourOS folder:  sudo bash host/setup-terminal.sh
# Creates a "harbor" user (or uses $TERMINAL_SSH_USER), installs tmux, and
# authorises a dedicated SSH key that only the HarbourOS container holds.
set -euo pipefail
USER_NAME="${TERMINAL_SSH_USER:-harbor}"
DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data"

apt-get install -y tmux openssh-server curl >/dev/null
id "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USER_NAME"
# The app store runs `docker compose` as this user, so it needs the docker group.
usermod -aG docker "$USER_NAME" || true

mkdir -p "$DATA_DIR/ssh"
# data/ is writable by the container: refuse links so root never touches another file through them.
for f in "$DATA_DIR/ssh" "$DATA_DIR/ssh/id_ed25519" "$DATA_DIR/ssh/id_ed25519.pub"; do
  [ ! -L "$f" ] || { echo "$f is a symlink; remove it and run this again."; exit 1; }
done
[ -f "$DATA_DIR/ssh/id_ed25519" ] || ssh-keygen -t ed25519 -N "" -C "harboros" -f "$DATA_DIR/ssh/id_ed25519" >/dev/null
chmod -h 600 "$DATA_DIR/ssh/id_ed25519" 2>/dev/null || chmod 600 "$DATA_DIR/ssh/id_ed25519"
[ "$(grep -c '' "$DATA_DIR/ssh/id_ed25519.pub")" = 1 ] && grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( [^[:cntrl:]]*)?$' "$DATA_DIR/ssh/id_ed25519.pub" || { echo "id_ed25519.pub isn't a single ed25519 key."; exit 1; }

HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
grep -qF "$(cat "$DATA_DIR/ssh/id_ed25519.pub")" "$HOME_DIR/.ssh/authorized_keys" 2>/dev/null || \
  cat "$DATA_DIR/ssh/id_ed25519.pub" >> "$HOME_DIR/.ssh/authorized_keys"
chown "$USER_NAME:$USER_NAME" "$HOME_DIR/.ssh/authorized_keys"; chmod 600 "$HOME_DIR/.ssh/authorized_keys"

# Nice defaults for browser terminals
[ -f "$HOME_DIR/.tmux.conf" ] || cat > "$HOME_DIR/.tmux.conf" <<'EOF'
set -g mouse on
set -g history-limit 20000
set -g default-terminal "xterm-256color"
set -g status-style "bg=#0f1011,fg=#8a8f98"
EOF
chown "$USER_NAME:$USER_NAME" "$HOME_DIR/.tmux.conf"

# Settings → Updates runs `git checkout` and `docker compose build` in this
# folder as $USER_NAME. When the folder belongs to someone else (say it lives in
# /home/you/HarbourOS), give $USER_NAME access to it, and a way through the
# folders above it, without changing who owns anything.
HARBOR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if ! sudo -u "$USER_NAME" test -w "$HARBOR_DIR" -a -x "$HARBOR_DIR" 2>/dev/null || ! sudo -u "$USER_NAME" test -w "$HARBOR_DIR/.git" 2>/dev/null; then
  command -v setfacl >/dev/null || apt-get install -y acl >/dev/null
  d="$HARBOR_DIR"
  while d="$(dirname "$d")"; [ "$d" != "/" ]; do setfacl -m "u:$USER_NAME:--x" "$d"; done
  # data/ is the container's own; leave it alone.
  find "$HARBOR_DIR" -path "$HARBOR_DIR/data" -prune -o -exec setfacl -m "u:$USER_NAME:rwX,d:u:$USER_NAME:rwX" {} +
  echo "Gave $USER_NAME access to $HARBOR_DIR for one-click updates."
fi
# git refuses to work in a repository someone else owns unless it's listed as safe.
sudo -u "$USER_NAME" git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$HARBOR_DIR" || \
  sudo -u "$USER_NAME" git config --global --add safe.directory "$HARBOR_DIR"

echo "Done. The container connects as $USER_NAME@host.docker.internal with data/ssh/id_ed25519."
echo "The Claude tab installs Claude Code for $USER_NAME on first open and shows its sign-in."
