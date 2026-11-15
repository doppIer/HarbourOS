#!/usr/bin/env bash
# Puts HarborOS on https://<this-machine>.<tailnet>.ts.net with a real
# certificate, using Tailscale Serve. Only devices on your tailnet can reach it.
#
#   sudo bash host/setup-https.sh          # HarborOS on port 7080 (default)
#   sudo bash host/setup-https.sh off      # stop serving it over https
set -euo pipefail

PORT="${HARBOR_PORT:-7080}"
command -v tailscale >/dev/null || { echo "Tailscale isn't installed on this machine."; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Run it with sudo: sudo bash $0 ${1:-}"; exit 1; }

if [ "${1:-}" = "off" ]; then
  tailscale serve --https=443 off || true
  echo "HarborOS is no longer served over https."
  exit 0
fi

IP="$(tailscale ip -4 | head -n1)"
DNS="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
[ -n "$DNS" ] || { echo "MagicDNS is off. Turn it on at https://login.tailscale.com/admin/dns and run this again."; exit 1; }

# HarborOS listens on the Tailscale address only (TAILSCALE_IP in .env).
if ! curl -fsS -o /dev/null "http://$IP:$PORT/"; then
  echo "HarborOS doesn't answer on http://$IP:$PORT. Start it first: docker compose up -d"
  exit 1
fi

echo "Serving http://$IP:$PORT as https://$DNS ..."
# If HTTPS certificates are off for your tailnet, Tailscale prints a link to turn them on.
tailscale serve --bg --https=443 "http://$IP:$PORT"
tailscale serve status
echo
echo "Done. Open https://$DNS"
echo "Old address http://$IP:$PORT keeps working too."
