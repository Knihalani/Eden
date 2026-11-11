#!/usr/bin/env bash
# Daily backup of a machine's Eden state (docs/DEPLOY.md §7), run by eden-backup.timer:
# - the source map (entity names and counts, D8; one SQLite file per process), copied consistently with sqlite3's
#   online backup (safe while Eden writes, WAL included);
# - the persisted users (D991), only on a single box: files encrypted under EDEN_PERSIST_KEY (a backup is useless
#   without the key, which is NOT in it: keep the key in your password manager). In a cluster they are already in
#   the shared store.
# Kept 7 days locally (D428: nothing persisted outlives 7 days, its backups neither); with BACKUP_REMOTE set (an
# rclone remote such as "hetzner-box:eden"), each archive is also copied there and remote ones past 7 days deleted.
#
#   deploy/scripts/backup.sh /opt/eden/deploy/compose/single
set -euo pipefail
dir=${1:?usage: backup.sh <compose dir>}
keep_days=7
out=/var/backups/eden
mkdir -p "$out"
chmod 700 "$out"
cd "$dir"
project=$(docker compose config --format json | sed -n 's/^ *"name": "\(.*\)",$/\1/p' | head -1)
volume=$(docker volume inspect -f '{{.Mountpoint}}' "${project}_eden-data" 2>/dev/null || true)
if [ -z "$volume" ]; then
  echo "backup: no ${project}_eden-data volume (a router holds no state): nothing to do"
  exit 0
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for db in "$volume"/source-map*.db; do
  [ -e "$db" ] || continue
  sqlite3 "$db" ".backup '$work/$(basename "$db")'"
done
if [ -d "$volume/frozen" ] && ! grep -q '^EDEN_PERSIST_STORE=' .env 2>/dev/null; then
  cp -a "$volume/frozen" "$work/frozen"
fi
archive="$out/eden-$(hostname)-$stamp.tar.gz"
tar -C "$work" -czf "$archive" .
chmod 600 "$archive"
find "$out" -name 'eden-*.tar.gz' -mtime +"$keep_days" -delete
if [ -n "${BACKUP_REMOTE:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$archive" "$BACKUP_REMOTE/"
  rclone delete --min-age "${keep_days}d" "$BACKUP_REMOTE/"
fi
echo "backup: $archive ($(du -h "$archive" | cut -f1))"
