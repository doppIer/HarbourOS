#!/bin/sh
# Start HarbourOS as the unprivileged "node" user. Root is used only to hand
# the data folder over to that user (older installs created it as root).
set -e
DATA="${DATA_DIR:-/data}"
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA"
  [ "$(stat -c %U "$DATA")" = node ] && [ -z "$(find "$DATA" ! -user node -print -quit 2>/dev/null)" ] || chown -R node:node "$DATA"
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all env HOME=/home/node "$@"
fi
exec "$@"
