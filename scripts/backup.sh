#!/usr/bin/env bash
#
# backup.sh — backs up the database **and** the uploaded files in one operation,
# encrypted, with a manifest.
#
# ## Why both in one archive
#
# The data lies in two places: rows in PostgreSQL, bytes in the volume
# `api-files`. A `pg_dump` alone restores responses whose attachments are
# missing. Two separate backups with two points in time would have the same
# problem, only more rarely.
#
# ## What is NOT in here
#
# **`SECRET_BOX_KEY`.** It belongs in a **different** place than the archive it
# unseals. The manifest therefore only records its **fingerprint**: a restore can
# thus say *beforehand* whether the key fits.
#
# ## Where the connection data comes from
#
# From the running stack, otherwise from the environment — `scripts/lib/stack.sh`
# describes the order. If the production stack is running, `pg_dump` and `psql`
# go through the `db` container; then the host needs neither a published port nor
# a client that is as new as the server.
#
# Usage:
#   scripts/backup.sh [--out DIR] [--keep-days N] [--no-encrypt]
#
# Environment:
#   DATABASE_URL     Optional — if set it wins over the stack.
#   FILE_STORAGE_DIR Optional — if set it wins over the volume of the stack.
#   BACKUP_KEY       Required, except with --no-encrypt (only for tests).
#   SECRET_BOX_KEY   Optional; only for the fingerprint in the manifest.
#   BACKUP_DIR       Default for --out.
#   BACKUP_KEEP_DAYS Default for --keep-days (default: 30).
#
# Exit: 0 = archive written, 1 = nothing written (with reason on stderr).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  printf '\033[31mbackup: %s\033[0m\n' "$1" >&2
  exit 1
}
note() { printf '==> %s\n' "$1"; }

# shellcheck source=lib/stack.sh
source "$ROOT/scripts/lib/stack.sh"

out_dir="${BACKUP_DIR:-$ROOT/var/backups}"
keep_days="${BACKUP_KEEP_DAYS:-30}"
encrypt=1

# ⚠️ `--out` and `--keep-days` **need** their value, and checking for it is not
# cosmetics: without it the script hangs. `shift 2` fails with only one
# remaining argument, `$#` stays 1 and `case` hits the same line —
# endlessly, without a single line of output. The real path there is a cron entry
# with an empty target variable, and there a backup fails that nobody
# misses.
while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      [ $# -ge 2 ] || die '--out braucht einen Pfad'
      out_dir="$2"; shift 2 ;;
    --keep-days)
      [ $# -ge 2 ] || die '--keep-days braucht eine Zahl'
      keep_days="$2"; shift 2 ;;
    # Only for the script tests: they check content and retention, and an
    # encrypted archive would be a wall for that. `restore.sh` demands the same
    # mode for playing it back.
    --no-encrypt) encrypt=0; shift ;;
    *) die "unbekannte Option: $1" ;;
  esac
done

resolve_database_access pg_dump
resolve_file_storage
if [ "$encrypt" -eq 1 ] && [ -z "${BACKUP_KEY:-}" ]; then
  die 'BACKUP_KEY fehlt (oder --no-encrypt für einen Testlauf)'
fi
[ "$encrypt" -eq 0 ] || command -v openssl >/dev/null || die 'openssl nicht gefunden'

mkdir -p "$out_dir" 2>/dev/null || die "Ziel nicht beschreibbar: $out_dir"
[ -w "$out_dir" ] || die "Ziel nicht beschreibbar: $out_dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- 1. The database -------------------------------------------------------
# `-Fc`: PostgreSQL's own format, because `pg_restore` makes a proper error
# message out of it where a truncated SQL text quietly runs half way
# through.
note "Datenbank sichern ($STACK_DB_MODE)"
stack_pg_dump > "$work/database.dump" \
  || die 'pg_dump ist gescheitert — es wurde nichts geschrieben'
[ -s "$work/database.dump" ] || die 'der Datenbankauszug ist leer'

# --- 2. The files ----------------------------------------------------------
# An empty directory is a valid state (an installation without an upload) and
# **not** an error.
note 'Dateien sichern'
if [ -d "$FILE_STORAGE_DIR" ]; then
  tar -czf "$work/files.tar.gz" -C "$FILE_STORAGE_DIR" . \
    || die 'die Dateien konnten nicht gepackt werden'
else
  printf 'kein Upload-Verzeichnis (%s) — leeres Archiv\n' "$FILE_STORAGE_DIR" >&2
  tar -czf "$work/files.tar.gz" -T /dev/null
fi

# --- 3. The manifest -------------------------------------------------------
# It answers the questions one asks **before** a restore:
# from when, which version, which migration state — and whether the key
# one is currently holding fits.
note 'Manifest schreiben'
# ⚠️ **An empty migration state is said out loud, not swallowed.** It is the
# question that counts before every restore, and it silently drops out as soon as
# `psql` is missing or `POSTGRES_USER` deviates — the real path there is a cron
# without a loaded `.env`. Even so it only warns, **it does not abort**: an
# archive without this line is worth infinitely more than no archive.
migration="$(
  stack_psql_value \
    'select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc limit 1' \
    2>"$work/psql.err" | tr -d '\r'
)"
if [ -z "$migration" ]; then
  reason="$(tail -n 1 "$work/psql.err" 2>/dev/null)"
  printf 'WARNUNG: der Migrationsstand ließ sich nicht ermitteln — das Manifest sagt „unbekannt". Grund: %s\n' \
    "${reason:-keine Zeile in _prisma_migrations}" >&2
fi
key_fingerprint='-'
if [ -n "${SECRET_BOX_KEY:-}" ]; then
  # The fingerprint, never the key: it allows the comparison and gives away
  # nothing from which the key could be obtained.
  key_fingerprint="$(printf '%s' "$SECRET_BOX_KEY" | sha256sum | cut -c1-16)"
fi
{
  printf 'created_at=%s\n' "$stamp"
  printf 'app_version=%s\n' "${APP_VERSION:-unbekannt}"
  printf 'migration=%s\n' "${migration:-unbekannt}"
  printf 'secret_box_key_fingerprint=%s\n' "$key_fingerprint"
  printf 'database_sha256=%s\n' "$(sha256sum "$work/database.dump" | cut -d' ' -f1)"
  printf 'files_sha256=%s\n' "$(sha256sum "$work/files.tar.gz" | cut -d' ' -f1)"
} > "$work/manifest.txt"

# --- 4. One archive --------------------------------------------------------
#
# ⚠️ **It is built in the work folder, not at the destination.** `mktemp -d`
# gives 0700; the destination often lies on foreign storage. The unencrypted tar
# must never lie there, not even for a moment — only the result goes to the
# destination.
name="formsache-backup-$stamp.tar.gz"
tar -czf "$work/$name" -C "$work" manifest.txt database.dump files.tar.gz \
  || die 'das Archiv konnte nicht geschrieben werden'

if [ "$encrypt" -eq 1 ]; then
  note 'verschlüsseln'
  # AES-256 with a key derived from `BACKUP_KEY` (PBKDF2). The
  # archive carries responses, addresses, attachments and password hashes.
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$work/$name" -out "$work/$name.enc" -pass env:BACKUP_KEY \
    || die 'die Verschlüsselung ist gescheitert'
  rm -f "$work/$name"
  name="$name.enc"
fi

archive="$out_dir/$name"
mv "$work/$name" "$archive" || die 'das Archiv konnte nicht abgelegt werden'

# --- 5. Cleaning up — only now, and that is the actual promise ---------------
#
# ⚠️ **The retention rule must never lead to the data loss it is meant to
# prevent.** The case that counts: an installation that nobody has backed up for
# four weeks — every existing archive lies beyond the retention period. If the
# run cleaned up first and then failed, it would stand there without a backup.
# This is protected by the **order**: this section only runs once the new archive
# is in place.
if [ "$keep_days" -gt 0 ]; then
  find "$out_dir" -maxdepth 1 -name 'formsache-backup-*' -type f -mtime "+$keep_days" \
    -delete 2>/dev/null
fi

# The belt to go with the braces: after this run at least one archive is there.
[ -f "$archive" ] || die 'nach dem Aufräumen ist das frische Archiv verschwunden'

note "fertig: $archive"
printf '%s\n' "$archive"
