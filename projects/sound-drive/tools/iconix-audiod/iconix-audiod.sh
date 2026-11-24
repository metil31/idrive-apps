#!/bin/sh
# Startet den Audio-Dienst von Sound Drive mit dem Node des Head Units.
# (BusyBox-sh-kompatibel; Datei muss LF-Zeilenenden haben.)
DIR="$(cd "$(dirname "$0")" && pwd)"

NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  for c in /usr/bin/node /bin/node /usr/local/bin/node /opt/node/bin/node /opt/*/bin/node /var/opt/*/current/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  echo "iconix-audiod: kein node gefunden" >&2
  exit 1
fi

exec "$NODE" "$DIR/iconix-audiod.js" "$@"
