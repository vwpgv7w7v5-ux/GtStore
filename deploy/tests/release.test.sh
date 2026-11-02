#!/usr/bin/env bash
set -euo pipefail
project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
export GTSTORE_ROOT="$temporary/managed"
export GTSTORE_STATE="$temporary/state"
export GTSTORE_ENV_FILE="$temporary/production.env"
export GTSTORE_DEPLOY_TEST_MODE=1
export GTSTORE_TEST_SERVICE="$temporary/service"
export GTSTORE_TEST_HEALTH="$temporary/health"
export GTSTORE_TEST_INSTALL="$temporary/install"
export GTSTORE_TEST_ACTIVITY="$temporary/activity"
export GTSTORE_TEST_SERVICE_STATE="$temporary/service-state"
mkdir -p "$GTSTORE_ROOT/releases" "$GTSTORE_ROOT/backups" "$GTSTORE_STATE/media/.import-cache"
printf '%s\n' gtstore-v1 > "$GTSTORE_ROOT/.gtstore-managed"
printf 'V6_DATABASE_FILE=%s/v6.json\nV6_MEDIA_DIRECTORY=%s/media\n' "$GTSTORE_STATE" "$GTSTORE_STATE" > "$GTSTORE_ENV_FILE"
printf 'HOST=127.0.0.1\nV6_PORT=4000\n' >> "$GTSTORE_ENV_FILE"
for name in GTSTORE_TOKEN_SECRET GTSTORE_CUSTOMER_SESSION_SECRET GTSTORE_PAYMENT_WEBHOOK_SECRET GTSTORE_SCHEDULER_SECRET; do
  printf '%s=fixture-secret-used-only-by-local-tests-1234567890\n' "$name" >> "$GTSTORE_ENV_FILE"
done
chmod 0600 "$GTSTORE_ENV_FILE"
printf '{"users":["existing-owner"]}\n' > "$GTSTORE_STATE/v6.json"
printf 'original-photo\n' > "$GTSTORE_STATE/media/photo.png"
printf 'original-mapping\n' > "$GTSTORE_STATE/media/.import-cache/photo.json"

cat > "$GTSTORE_TEST_SERVICE" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case $1 in
  is-active) [[ -f $GTSTORE_TEST_SERVICE_STATE ]] && [[ $(cat "$GTSTORE_TEST_SERVICE_STATE") == active ]] ;;
  stop) printf 'stop\n' >> "$GTSTORE_TEST_ACTIVITY"; printf 'stopped\n' > "$GTSTORE_TEST_SERVICE_STATE" ;;
  restart)
    printf 'restart\n' >> "$GTSTORE_TEST_ACTIVITY"
    printf 'active\n' > "$GTSTORE_TEST_SERVICE_STATE"
    if [[ -f "$GTSTORE_ROOT/current/FAIL_HEALTH" ]]; then
      printf '{"users":["existing-owner"],"newWrite":true}\n' > "$GTSTORE_STATE/v6.json"
    fi
    ;;
  *) exit 2 ;;
esac
SH
cat > "$GTSTORE_TEST_HEALTH" <<'SH'
#!/usr/bin/env bash
[[ ! -f $1/FAIL_HEALTH ]] || exit 1
commit=$(cat "$1/DEPLOY_COMMIT")
if [[ -f $1/STALE_HEALTH ]]; then commit=0000000000000000000000000000000000000000; fi
printf '{"ok":true,"commit":"%s"}\n' "$commit"
SH
cat > "$GTSTORE_TEST_INSTALL" <<'SH'
#!/usr/bin/env bash
mkdir "$1/node_modules"
printf 'installed\n' > "$1/node_modules/marker"
SH
chmod 0700 "$GTSTORE_TEST_SERVICE" "$GTSTORE_TEST_HEALTH" "$GTSTORE_TEST_INSTALL"

archive() {
  local sha=$1 mode=${2:-good}
  python3 - "$temporary/$sha.tar.gz" "$sha" "$mode" <<'PY'
import io, sys, tarfile
files = {
    'DEPLOY_COMMIT': sys.argv[2] + '\n',
    'package.json': '{"name":"fixture","version":"1.0.0"}',
    'package-lock.json': '{"lockfileVersion":3}',
    'apps/api-v6/src/server.js': 'console.log("fixture");',
    'apps/admin-v6/index.html': '<html>admin</html>',
    'apps/storefront-v6/index.html': '<html>storefront</html>',
}
if sys.argv[3] == 'bad-health':
    files['FAIL_HEALTH'] = 'unhealthy'
if sys.argv[3] == 'stale-health':
    files['STALE_HEALTH'] = 'wrong running commit'
if sys.argv[3] == 'unsafe':
    files['../../escape'] = 'unsafe'
if sys.argv[3] == 'wrong-sha':
    files['DEPLOY_COMMIT'] = '0' * 40
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    for name, content in files.items():
        data = content.encode()
        item = tarfile.TarInfo(name)
        item.size = len(data)
        item.mode = 0o644
        archive.addfile(item, io.BytesIO(data))
PY
}
deploy() { bash "$project/deploy/release.sh" "$temporary/$1.tar.gz" "$1"; }
success=1111111111111111111111111111111111111111
failure=2222222222222222222222222222222222222222
unsafe=3333333333333333333333333333333333333333
wrong=4444444444444444444444444444444444444444
stale=5555555555555555555555555555555555555555
archive "$success"
deploy "$success"
[[ $(readlink -f "$GTSTORE_ROOT/current") == "$GTSTORE_ROOT/releases/$success" ]]
[[ $(cat "$GTSTORE_ROOT/current/.gtstore-release") == "$success" ]]
[[ $(cat "$GTSTORE_ROOT/current/.release.env") == "GTSTORE_DEPLOY_COMMIT=$success" ]]
[[ $(cat "$GTSTORE_STATE/v6.json") == '{"users":["existing-owner"]}' ]]
[[ $(cat "$GTSTORE_STATE/media/photo.png") == original-photo ]]
[[ $(cat "$GTSTORE_STATE/media/.import-cache/photo.json") == original-mapping ]]
backup=$(find "$GTSTORE_ROOT/backups" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[[ -f $backup/state.tar.gz && -f $backup/gtstore.env ]]
tar -tzf "$backup/state.tar.gz" | grep -Fxq './media/.import-cache/photo.json'
[[ $(stat -c '%a' "$backup/gtstore.env") == 600 ]]
echo 'Successful deployment preserves persistent state and creates a private backup.'

archive "$failure" bad-health
if deploy "$failure"; then echo 'Unhealthy deployment unexpectedly succeeded.' >&2; exit 1; fi
[[ $(readlink -f "$GTSTORE_ROOT/current") == "$GTSTORE_ROOT/releases/$success" ]]
[[ $(cat "$GTSTORE_TEST_SERVICE_STATE") == active ]]
[[ $(cat "$GTSTORE_STATE/v6.json") == '{"users":["existing-owner"],"newWrite":true}' ]]
[[ $(cat "$GTSTORE_STATE/media/photo.png") == original-photo ]]
echo 'Health failure rolls code back and restarts the previous release without rolling data back.'

archive "$stale" stale-health
if deploy "$stale"; then echo 'A stale API commit unexpectedly passed readiness.' >&2; exit 1; fi
[[ $(readlink -f "$GTSTORE_ROOT/current") == "$GTSTORE_ROOT/releases/$success" ]]
[[ $(cat "$GTSTORE_TEST_SERVICE_STATE") == active ]]
echo 'A healthy response for a different commit fails readiness and rolls code back.'

before=$(wc -l < "$GTSTORE_TEST_ACTIVITY")
archive "$unsafe" unsafe
if deploy "$unsafe"; then echo 'Unsafe source archive unexpectedly succeeded.' >&2; exit 1; fi
archive "$wrong" wrong-sha
if deploy "$wrong"; then echo 'Wrong source SHA unexpectedly succeeded.' >&2; exit 1; fi
[[ $(wc -l < "$GTSTORE_TEST_ACTIVITY") == "$before" ]]
[[ ! -e "$temporary/escape" ]]
[[ $(readlink -f "$GTSTORE_ROOT/current") == "$GTSTORE_ROOT/releases/$success" ]]
echo 'Unsafe archives and mismatched commit markers fail before touching the running service.'

rm "$GTSTORE_ROOT/current"
ln -s "$GTSTORE_STATE" "$GTSTORE_ROOT/current"
if deploy "$success"; then echo 'Unmanaged current link unexpectedly accepted.' >&2; exit 1; fi
[[ $(wc -l < "$GTSTORE_TEST_ACTIVITY") == "$before" ]]
echo 'An unmanaged deployment path is preserved and rejected.'
echo 'Deployment regression tests passed.'
