#!/usr/bin/env bash
# Installs (or reinstalls) HarbourOS on this server. Run it from the HarbourOS
# folder as your normal user; it asks for sudo where it needs it.
#
#   ./install.sh              latest release, terminal on, asks about https
#   ./install.sh --https      also put HarbourOS on https://<machine>.ts.net
#   ./install.sh --no-https   don't ask about https
#   ./install.sh --no-terminal  skip the browser terminal (and one-click updates)
#   ./install.sh --main       run the newest code on main instead of the latest release
set -euo pipefail

# The checkout below can replace this very file while bash is still reading it,
# so run from a copy and work in the HarbourOS folder.
if [ -z "${HARBOUR_REPO:-}" ]; then
  export HARBOUR_REPO="$(cd "$(dirname "$0")" && pwd)"
  tmp="$(mktemp)"; cp "$0" "$tmp"
  exec bash "$tmp" "$@"
fi
trap 'rm -f "$0"' EXIT
cd "$HARBOUR_REPO"

HTTPS=ask TERMINAL=1 MAIN=0
for a in "$@"; do
  case "$a" in
    --https) HTTPS=1 ;; --no-https) HTTPS=0 ;;
    --no-terminal) TERMINAL=0 ;; --main) MAIN=1 ;;
    -h|--help) sed -n 2,9p "$HARBOUR_REPO/install.sh" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $a (see ./install.sh --help)"; exit 1 ;;
  esac
done

b=$'\e[1m' d=$'\e[2m' g=$'\e[32m' r=$'\e[31m' n=$'\e[0m'
[ -t 1 ] || b= d= g= r= n=
step() { echo; echo "${b}==> $*${n}"; }
die() { echo "${r}$*${n}" >&2; exit 1; }
ask() { [ -t 0 ] || return 1; read -r -p "$1 [y/N] " x; [[ "$x" =~ ^[YyEe] ]]; }

[ "$(id -u)" != 0 ] || die "Run it as your normal user, not with sudo: ./install.sh (it asks for sudo itself)."

# ---- what this needs ----
step "Checking the server"
command -v git >/dev/null || die "git isn't installed. Install it: sudo apt install git"
command -v docker >/dev/null || die "Docker isn't installed. See https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || sudo docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing. Install the docker-compose-plugin package."
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"
command -v tailscale >/dev/null || die "Tailscale isn't installed. Install it (curl -fsSL https://tailscale.com/install.sh | sh), run: sudo tailscale up, then run ./install.sh again."
IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
[ -n "$IP" ] || die "Tailscale isn't signed in on this machine. Run: sudo tailscale up, then ./install.sh again."
echo "Docker ok, Tailscale ok (${IP})."

# ---- .env with the Tailscale address ----
step "Writing .env"
[ -f .env ] || cp .env.example .env
if grep -q '^TAILSCALE_IP=' .env; then sed -i.bak "s/^TAILSCALE_IP=.*/TAILSCALE_IP=${IP}/" .env && rm -f .env.bak
else echo "TAILSCALE_IP=${IP}" >> .env; fi
echo "TAILSCALE_IP=${IP}: HarbourOS only listens on your tailnet address."

# ---- Tailscale details (devices, health) in the Tailscale widget ----
# tailscaled answers a process that isn't its operator read-only; HarbourOS only reads status.
if [ -S /var/run/tailscale/tailscaled.sock ] && [ ! -f docker-compose.override.yml ]; then
  cat > docker-compose.override.yml <<'YML'
# Written by install.sh: lets the Tailscale widget list your devices. Delete this file to turn it off.
services:
  harbor:
    volumes:
      - /var/run/tailscale/tailscaled.sock:/var/run/tailscale/tailscaled.sock
YML
  echo "Tailscale widget: showing your devices (docker-compose.override.yml)."
fi

# ---- which version ----
step "Picking the version"
git fetch --tags --quiet origin 2>/dev/null || echo "${d}(couldn't reach GitHub; using what's here)${n}"
if [ "$MAIN" = 1 ]; then
  VERSION="$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')-main"
  [ "$VERSION" != "-main" ] || VERSION=dev
  echo "Running main (${VERSION}). Settings → Updates moves you to the next release."
else
  TAG="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
  [ -n "$TAG" ] || die "No releases found. Run with --main to use the newest code."
  git -c advice.detachedHead=false checkout --quiet --force "$TAG"
  VERSION="${TAG#v}"
  echo "HarbourOS ${VERSION} (latest release)."
fi

# ---- build and start ----
# ---- port 7080 ----
# HarbourOS uses 7080 (and 7081-7090 for apps that refuse frames). Only an old HarbourOS may hold them.
mine="$($DOCKER ps -q --filter label=com.docker.compose.project=harbouros 2>/dev/null)$($DOCKER ps -q --filter label=com.docker.compose.project=harboros 2>/dev/null)"
if [ -z "$mine" ] && command -v ss >/dev/null && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq ':(708[0-9]|7090)$'; then
  die "Something else is already using port 7080-7090 on this server:
$(ss -ltnp 2>/dev/null | grep -E ':(708[0-9]|7090) ' || true)
HarbourOS needs these ports. Stop that service and run ./install.sh again."
fi

step "Building and starting (the first build takes a few minutes)"
HARBOR_VERSION="$VERSION" $DOCKER compose build
# Before 1.0.8 the compose project was "harboros"; its containers hold the ports the new ones need.
old="$($DOCKER ps -aq --filter label=com.docker.compose.project=harboros)"
[ -z "$old" ] || { echo "Removing containers from the old \"harboros\" project..."; $DOCKER rm -f $old >/dev/null; }
HARBOR_VERSION="$VERSION" $DOCKER compose up -d

URL="http://${IP}:7080"
printf "Waiting for HarbourOS to answer"
for _ in $(seq 1 90); do
  curl -fsS -o /dev/null "$URL/api/auth/config" 2>/dev/null && { echo " ${g}up${n}"; break; }
  printf "."; sleep 2
done
curl -fsS -o /dev/null "$URL/api/auth/config" 2>/dev/null || die "
HarbourOS didn't answer on $URL. See what happened: $DOCKER compose logs harbor"

# ---- terminal, Files and one-click updates ----
if [ "$TERMINAL" = 1 ]; then
  step "Setting up the browser terminal and one-click updates (needs sudo)"
  # HarbourOS already runs; a failure here only costs the terminal and one-click updates.
  sudo bash host/setup-terminal.sh || echo "${r}The terminal setup didn't finish. HarbourOS works without it; try again later: sudo bash host/setup-terminal.sh${n}"
fi

# ---- https (needed for passkeys) ----
if [ "$HTTPS" = ask ]; then
  echo
  echo "Passkeys (Face ID, Touch ID, Windows Hello) and some browser features need https."
  ask "Put HarbourOS on https://<this machine>.ts.net with Tailscale?" && HTTPS=1 || HTTPS=0
fi
if [ "$HTTPS" = 1 ]; then
  step "Turning on https (needs sudo)"
  if sudo bash host/setup-https.sh; then
    DNS="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
    [ -z "$DNS" ] || URL="https://${DNS}"
  else
    echo "${d}https didn't work out; you can try again later with: sudo bash host/setup-https.sh${n}"
  fi
fi

echo
echo "${g}${b}HarbourOS is running.${n}"
# A clickable link in terminals that support it (most do), plain text elsewhere.
link() { [ -t 1 ] && printf '\e]8;;%s\e\\%s\e]8;;\e\\' "$1" "$1" || printf '%s' "$1"; }
echo "Open ${b}$(link "$URL")${n} on any device in your tailnet and create the first account. It becomes the admin."
if command -v qrencode >/dev/null; then
  echo "Or scan this with your phone:"; qrencode -t ANSIUTF8 -m 2 "$URL"
fi
# Sitting at the server itself (not over SSH)? Open it right here.
if [ -z "${SSH_CONNECTION:-}" ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null; then
  xdg-open "$URL" >/dev/null 2>&1 &
fi
echo "${d}Port: 7080 (http). Updates: Settings → Updates. Uninstall: see the README.${n}"
