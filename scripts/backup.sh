#!/usr/bin/env bash
# Online backup of all platform SQLite databases.
#
# Backs up the central DB (data/v2.db) AND every per-session inbound/outbound
# DB under data/v2-sessions/. Uses `sqlite3 .backup`, which takes a consistent
# snapshot via the SQLite backup API while the host keeps running — it does NOT
# violate the three-DB single-writer invariant (it's a read-side snapshot, never
# a write). The previous guidance (RUNBOOK) backed up only v2.db, so every
# session's in-flight messages + delivery ledger were outside the backup set;
# this covers them.
#
# Usage:
#   DATA_DIR=./data BACKUP_DIR=./backups scripts/backup.sh
#   (cron, daily 03:00):  0 3 * * *  cd /srv/agentdesk && scripts/backup.sh >> /var/log/agentdesk-backup.log 2>&1
#
# Env:
#   DATA_DIR        source data dir (default ./data)
#   BACKUP_DIR      destination root (default ./backups)
#   BACKUP_RETAIN   how many timestamped snapshots to keep (default 14)
#
# RPO: snapshot-in-time. Run frequency = your RPO. Between runs, an unbacked
# crash loses changes since the last snapshot — pair with frequent runs or a
# streaming/volume-snapshot solution for tighter RPO.
set -euo pipefail

DATA_DIR="${DATA_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETAIN="${BACKUP_RETAIN:-14}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "backup: sqlite3 not found on PATH" >&2
  exit 1
fi
if [ ! -f "$DATA_DIR/v2.db" ]; then
  echo "backup: no central DB at $DATA_DIR/v2.db (is DATA_DIR correct?)" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"

# Consistent online snapshot of one DB file → mirror its path under DEST.
backup_one() {
  local src="$1" rel out
  rel="${src#"$DATA_DIR"/}"
  out="$DEST/$rel"
  mkdir -p "$(dirname "$out")"
  # .backup is safe against a live writer; quote for paths with spaces.
  sqlite3 "$src" ".backup '$out'"
}

count=0
backup_one "$DATA_DIR/v2.db"; count=$((count + 1))

# Every session inbound/outbound DB. find -print0 handles odd names.
if [ -d "$DATA_DIR/v2-sessions" ]; then
  while IFS= read -r -d '' db; do
    backup_one "$db"
    count=$((count + 1))
  done < <(find "$DATA_DIR/v2-sessions" -type f \( -name 'inbound.db' -o -name 'outbound.db' \) -print0)
fi

echo "backup: wrote $count databases → $DEST"

# Retention: keep the newest BACKUP_RETAIN snapshot dirs, prune the rest.
# Portable (no mapfile/bash4): number snapshots newest-first, rm past N.
if [ "$BACKUP_RETAIN" -gt 0 ]; then
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '*Z' | sort -r | {
    i=0
    while IFS= read -r snap; do
      i=$((i + 1))
      if [ "$i" -gt "$BACKUP_RETAIN" ]; then
        rm -rf "$snap"
        echo "backup: pruned old snapshot $snap"
      fi
    done
  }
fi
