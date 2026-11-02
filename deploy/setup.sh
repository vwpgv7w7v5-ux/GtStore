#!/usr/bin/env bash
# One-time preparation only. Does not stop the old site, migrate state, configure
# nginx, enable/start the API, or create/replace a production environment file.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run setup.sh as root on the VPS.' >&2; exit 1; }
root=/opt/gtstore
state=/var/lib/gtstore
config=/etc/gtstore
source_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node_binary=$(readlink -f "$(command -v node)")
case "$node_binary" in
  /usr/bin/*|/usr/local/*|/opt/*) ;;
  *) echo 'Node must be installed system-wide; home-directory version managers are unavailable to the hardened service.' >&2; exit 1 ;;
esac
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
[[ $node_major -eq 24 ]] || { echo 'Install Node.js 24 LTS before setup.' >&2; exit 1; }
for executable in python3 curl flock tar systemctl; do command -v "$executable" >/dev/null; done
for destination in "$root" "$state" "$config"; do
  if [[ -e "$destination" && ! -f "$root/.gtstore-managed" ]]; then
    echo "Refusing existing unmanaged path: $destination. Inspect and migrate the old deployment first." >&2
    exit 1
  fi
done
if [[ -e "$root/.gtstore-managed" ]] && [[ $(cat "$root/.gtstore-managed") != gtstore-v1 ]]; then
  echo 'Unrecognized deployment layout marker.' >&2
  exit 1
fi
unit=$(mktemp)
trap 'rm -f -- "$unit"' EXIT
sed "s|ExecStart=/usr/bin/node |ExecStart=$node_binary |" "$source_directory/gtstore.service" > "$unit"
if [[ -e /etc/systemd/system/gtstore.service ]] && ! cmp -s "$unit" /etc/systemd/system/gtstore.service; then
  echo 'Refusing to replace an existing different gtstore.service. Inspect it first.' >&2
  exit 1
fi
if ! id gtstore >/dev/null 2>&1; then
  useradd --system --home-dir "$state" --shell /usr/sbin/nologin gtstore
fi
runuser -u gtstore -- test -x "$node_binary" || { echo 'The service user cannot execute the selected system Node.js binary.' >&2; exit 1; }
install -d -m 0755 "$root" "$root/releases"
install -d -m 0700 "$root/backups" "$root/npm-cache" "$config"
install -d -m 0750 -o gtstore -g gtstore "$state" "$state/media"
printf '%s\n' gtstore-v1 > "$root/.gtstore-managed"
chmod 0644 "$root/.gtstore-managed"
install -m 0644 "$unit" /etc/systemd/system/gtstore.service
if [[ ! -e "$config/gtstore.env.example" ]]; then
  install -m 0600 "$source_directory/gtstore.env.example" "$config/gtstore.env.example"
fi
systemctl daemon-reload
echo 'Prepared /opt/gtstore, /var/lib/gtstore and gtstore.service; the live site was not restarted.'
echo 'Migrate the existing database/media and create /etc/gtstore/gtstore.env with the existing secrets before the first deployment.'
