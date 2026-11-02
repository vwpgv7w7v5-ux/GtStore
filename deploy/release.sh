#!/usr/bin/env bash
# Invoked by GitHub Actions from its verified source archive:
# bash release.sh /tmp/gtstore-upload.XXXX/gtstore-<sha>.tar.gz <full-sha>
set -euo pipefail
umask 077
[[ $# -eq 2 && $2 =~ ^[0-9a-f]{40}$ ]] || { echo 'Usage: release.sh <source.tar.gz> <full-commit-sha>' >&2; exit 2; }
archive=$1
commit=$2
root=${GTSTORE_ROOT:-/opt/gtstore}
state=${GTSTORE_STATE:-/var/lib/gtstore}
environment_file=${GTSTORE_ENV_FILE:-/etc/gtstore/gtstore.env}
health_url=${GTSTORE_HEALTH_URL:-http://127.0.0.1:4000/api/v6/health}
test_mode=${GTSTORE_DEPLOY_TEST_MODE:-0}
[[ $test_mode == 1 || $EUID -eq 0 ]] || { echo 'Run deployment as root.' >&2; exit 1; }
[[ -f "$archive" && ! -L "$archive" ]] || { echo 'Source archive is missing or is a symlink.' >&2; exit 1; }
[[ -f "$root/.gtstore-managed" && $(cat "$root/.gtstore-managed") == gtstore-v1 ]] || { echo 'Run the reviewed one-time setup before deployment.' >&2; exit 1; }
[[ -d "$state" && -f "$environment_file" ]] || { echo 'Persistent state or production environment file is missing.' >&2; exit 1; }
[[ $(node -p 'Number(process.versions.node.split(".")[0])') -eq 24 ]] || { echo 'Deployment requires Node.js 24 LTS.' >&2; exit 1; }
exec 9> "$root/.deploy.lock"
flock -w 300 9 || { echo 'Another deployment still holds the deployment lock.' >&2; exit 1; }

# Validate non-secret state paths without sourcing/printing the environment file.
python3 - "$environment_file" "$state" "$test_mode" "$health_url" <<'PY'
import pathlib, shlex, stat, sys
values = {}
environment = pathlib.Path(sys.argv[1])
metadata = environment.stat()
if environment.is_symlink() or metadata.st_mode & 0o077 or (sys.argv[3] != '1' and metadata.st_uid != 0):
    sys.exit('Production environment file must be root-owned, private (0600), and not a symlink.')
required = ('V6_DATABASE_FILE', 'V6_MEDIA_DIRECTORY', 'HOST', 'V6_PORT',
            'GTSTORE_TOKEN_SECRET', 'GTSTORE_CUSTOMER_SESSION_SECRET',
            'GTSTORE_PAYMENT_WEBHOOK_SECRET', 'GTSTORE_SCHEDULER_SECRET')
for line in environment.read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#'):
        continue
    key, separator, value = line.partition('=')
    if separator and key.strip() in required:
        words = shlex.split(value, comments=False)
        values[key.strip()] = words[0] if len(words) == 1 else ''
state = pathlib.Path(sys.argv[2]).resolve()
expected = {'V6_DATABASE_FILE': state / 'v6.json', 'V6_MEDIA_DIRECTORY': state / 'media'}
if any(not values.get(key) or pathlib.Path(values[key]).resolve() != path for key, path in expected.items()):
    sys.exit('Production env must explicitly point V6_DATABASE_FILE and V6_MEDIA_DIRECTORY to the managed persistent state paths.')
if values.get('HOST') != '127.0.0.1' or values.get('V6_PORT') != '4000' or sys.argv[4] != 'http://127.0.0.1:4000/api/v6/health':
    sys.exit('Production HOST, V6_PORT and readiness URL must target 127.0.0.1:4000 consistently.')
for key in required[4:]:
    value = values.get(key, '')
    if not value or value.startswith('REPLACE_'):
        sys.exit(f'{key} must be populated securely before deployment; preserve existing secrets during migration.')
PY

service() {
  if [[ $test_mode == 1 ]]; then "$GTSTORE_TEST_SERVICE" "$1"; else systemctl "$1" gtstore.service; fi
}
healthy() {
  local response
  if [[ $test_mode == 1 ]]; then
    response=$("$GTSTORE_TEST_HEALTH" "$root/current") || return 1
  else
    systemctl is-active --quiet gtstore.service || return 1
    response=$(curl --fail --silent --show-error --max-time 3 "$health_url") || return 1
  fi
  printf '%s' "$response" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const h=JSON.parse(s);if(h.ok!==true||h.commit!==process.argv[1])process.exit(1)}catch{process.exit(1)}})' "$commit"
}
switch_to() {
  local temporary
  temporary=$(mktemp -d "$root/.switch.XXXXXX")
  ln -s -- "$1" "$temporary/current"
  mv -Tf -- "$temporary/current" "$root/current"
  rmdir -- "$temporary"
}

previous=''
if [[ -e "$root/current" || -L "$root/current" ]]; then
  [[ -L "$root/current" ]] || { echo 'Refusing unmanaged current path.' >&2; exit 1; }
  previous=$(readlink -f "$root/current")
  [[ $previous == "$root/releases/"* && -f "$previous/.gtstore-release" ]] || { echo 'Refusing current link outside managed releases.' >&2; exit 1; }
fi
staging=$(mktemp -d "$root/releases/.incoming-$commit.XXXXXX")
stopped=0
switched=0
was_active=0
service is-active >/dev/null 2>&1 && was_active=1
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ $status -ne 0 && $stopped == 1 ]]; then
    if [[ $switched == 1 ]]; then
      if [[ -n $previous ]]; then switch_to "$previous"; else rm -f -- "$root/current"; fi
    fi
    if [[ $was_active == 1 && -n $previous ]]; then service restart; else service stop; fi
    echo 'Deployment failed; previous code link restored. Database and media were preserved; no automatic data rollback was performed.' >&2
  fi
  [[ -z $staging ]] || rm -rf -- "$staging"
  exit "$status"
}
trap cleanup EXIT

# Reject traversal, links, special files and uploaded runtime credentials/state.
python3 - "$archive" "$staging" "$commit" <<'PY'
import pathlib, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    if len(members) > 20000 or sum(item.size for item in members) > 200 * 1024 * 1024:
        sys.exit('Source archive exceeds the permitted size.')
    names = set()
    for item in members:
        name = pathlib.PurePosixPath(item.name)
        if name.is_absolute() or '..' in name.parts or not name.parts or not (item.isfile() or item.isdir()):
            sys.exit('Unsafe archive member.')
        if name.parts[0] in ('.git', 'node_modules', 'uploads') or any(part.startswith('.env') and part != '.env.example' for part in name.parts):
            sys.exit('Archive contains runtime files or credentials.')
        if name.as_posix() in names:
            sys.exit('Archive contains duplicate member paths.')
        names.add(name.as_posix())
    marker = archive.extractfile('DEPLOY_COMMIT')
    if not marker or marker.read().decode().strip() != sys.argv[3]:
        sys.exit('Source archive commit does not match the requested release.')
    # Only regular files/directories with safe paths were admitted; no archive
    # symlink can redirect extraction. Works with Ubuntu's Python 3.10+ as well.
    archive.extractall(sys.argv[2], members=members, **({'filter': 'data'} if hasattr(tarfile, 'data_filter') else {}))
PY
[[ -f "$staging/package-lock.json" && -f "$staging/apps/api-v6/src/server.js" && -f "$staging/apps/admin-v6/index.html" && -f "$staging/apps/storefront-v6/index.html" ]] || { echo 'Incomplete GtStore source archive.' >&2; exit 1; }
if [[ $test_mode == 1 ]]; then
  "$GTSTORE_TEST_INSTALL" "$staging"
else
  (cd "$staging" && npm ci --omit=dev --ignore-scripts --cache "$root/npm-cache" --no-audit --no-fund)
fi
node --check "$staging/apps/api-v6/src/server.js"
printf '%s\n' "$commit" > "$staging/.gtstore-release"
printf 'GTSTORE_DEPLOY_COMMIT=%s\n' "$commit" > "$staging/.release.env"
chmod -R u-s,g-s,go-w,a+rX "$staging"
if [[ $test_mode != 1 ]]; then chown -R root:root "$staging"; fi
release="$root/releases/$commit"
if [[ -e "$release" ]]; then
  [[ -d "$release" && ! -L "$release" && -f "$release/.gtstore-release" && $(cat "$release/.gtstore-release") == "$commit" ]] || { echo 'Refusing existing unmanaged release path.' >&2; exit 1; }
  # A SHA is immutable. Keep the previously installed release of that SHA.
  rm -rf -- "$staging"
else
  mv -- "$staging" "$release"
fi
staging=''

if [[ $test_mode != 1 && $was_active == 0 ]]; then
  python3 - "$health_url" <<'PY'
import socket, sys, urllib.parse
url = urllib.parse.urlsplit(sys.argv[1])
if url.hostname not in ('127.0.0.1', 'localhost') or url.scheme != 'http':
    sys.exit('Deployment readiness URL must be local HTTP.')
with socket.socket() as client:
    client.settimeout(1)
    if client.connect_ex(('127.0.0.1', url.port or 80)) == 0:
        sys.exit('API port is occupied by an unmanaged process. Inspect the existing site before migrating.')
PY
fi
stopped=1
service stop
backup="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-$commit-$$"
mkdir -m 0700 -- "$backup"
tar -czf "$backup/state.tar.gz" -C "$state" .
install -m 0600 "$environment_file" "$backup/gtstore.env"
echo "Persistent state backed up to $backup"
switch_to "$release"
switched=1
service restart
health_attempts=30
health_delay=1
if [[ $test_mode == 1 ]]; then health_attempts=2; health_delay=0; fi
for ((attempt=1; attempt<=health_attempts; attempt++)); do
  if healthy; then
    stopped=0
    echo "Deployed commit $commit; API health check passed."
    exit 0
  fi
  sleep "$health_delay"
done
echo 'New release did not become healthy.' >&2
exit 1
