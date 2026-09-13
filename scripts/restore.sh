#!/usr/bin/env bash
#
# restore.sh — plays an archive from `backup.sh` back in.
#
# ## The order is part of the promise
#
#   `api`/`web` off, `db` on → database back → files back →
#   `migrate deploy` → stack up → smoke test
#
# **Not the whole stack off.** A `down` would take from this script both things
# it needs: the reachable database (the production file publishes no
# port) and the way to the upload volume. It therefore checks itself that `api`
# is stopped and `db` is running.
#
# `migrate deploy` stands **after** the playing in: the archive brings its own
# schema along, and a `migrate` that ran beforehand would write into a database
# that is about to be overwritten.
#
# ## What this script **cannot** do
#
# It does not fetch `SECRET_BOX_KEY` back — that one lies outside the archive.
# What it can do is say **beforehand** that the key in the environment does not
# fit this archive. Without this warning the loss of the key would be the
# quietest conceivable data loss: the application starts, every page renders,
# and only at the protected form is it over.
#
# It determines connection data and upload path like `backup.sh` — a variable
# that is set, otherwise the running stack (`scripts/lib/stack.sh`).
#
# Usage:
#   scripts/restore.sh ARCHIVE [--no-encrypt] [--force-key-mismatch]
#
# Environment: BACKUP_KEY · SECRET_BOX_KEY · optional DATABASE_URL, FILE_STORAGE_DIR
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  printf '\033[31mrestore: %s\033[0m\n' "$1" >&2
  exit 1
}
note() { printf '==> %s\n' "$1"; }

# shellcheck source=lib/stack.sh
source "$ROOT/scripts/lib/stack.sh"

archive="${1:-}"
[ -n "$archive" ] || die 'kein Archiv angegeben'
shift
encrypt=1
force_key=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-encrypt) encrypt=0; shift ;;
    --force-key-mismatch) force_key=1; shift ;;
    *) die "unbekannte Option: $1" ;;
  esac
done

[ -f "$archive" ] || die "Archiv nicht gefunden: $archive"
resolve_database_access pg_restore
# ⚠️ **The `api` container must not be running now.** `pg_restore --clean` pulls
# the tables out from under every open connection user; what stands in the
# database afterwards depends on what the running service wrote in
# between. `db` on the other hand **has to** run — otherwise there is nothing to
# fill and no way to the upload volume.
if [ "$STACK_DB_MODE" = 'compose' ] && stack_service_running api; then
  die "der api-Container läuft — erst \`docker compose -f $COMPOSE_PROD_FILE stop api web\`, dann erneut"
fi
resolve_file_storage
if [ "$encrypt" -eq 1 ] && [ -z "${BACKUP_KEY:-}" ]; then
  die 'BACKUP_KEY fehlt — ohne ihn ist das Archiv nicht lesbar'
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- 1. Decrypt ------------------------------------------------------------
# **Abort cleanly instead of unpacking halfway.** A wrong key has to end here,
# not three steps later at a file that nobody recognises as
# broken.
plain="$work/archive.tar.gz"
if [ "$encrypt" -eq 1 ]; then
  note 'entschlüsseln'
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "$archive" -out "$plain" -pass env:BACKUP_KEY 2>/dev/null \
    || die 'das Archiv ließ sich nicht entschlüsseln — falscher BACKUP_KEY?'
else
  cp "$archive" "$plain"
fi

note 'auspacken'
tar -xzf "$plain" -C "$work" || die 'das Archiv ist beschädigt'
for part in manifest.txt database.dump files.tar.gz; do
  [ -f "$work/$part" ] || die "im Archiv fehlt: $part"
done

# --- 2. Checksums and key fingerprint --------------------------------------
manifest_value() { grep -m1 "^$1=" "$work/manifest.txt" | cut -d= -f2-; }

for pair in "database.dump:database_sha256" "files.tar.gz:files_sha256"; do
  file="${pair%%:*}"; key="${pair##*:}"
  expected="$(manifest_value "$key")"
  actual="$(sha256sum "$work/$file" | cut -d' ' -f1)"
  [ "$expected" = "$actual" ] || die "$file stimmt nicht mit dem Manifest überein"
done

expected_key="$(manifest_value secret_box_key_fingerprint)"
if [ -n "${SECRET_BOX_KEY:-}" ] && [ "$expected_key" != '-' ]; then
  actual_key="$(printf '%s' "$SECRET_BOX_KEY" | sha256sum | cut -c1-16)"
  if [ "$expected_key" != "$actual_key" ]; then
    if [ "$force_key" -eq 0 ]; then
      die 'SECRET_BOX_KEY passt nicht zu diesem Archiv. Zugangswörter, SMTP- und
OIDC-Geheimnisse wären danach unlesbar — die Anwendung startete trotzdem und
scheiterte erst am ersten geschützten Formular. Den richtigen Schlüssel holen,
oder mit --force-key-mismatch bewusst weitermachen.'
    fi
    printf 'WARNUNG: SECRET_BOX_KEY passt nicht — auf Wunsch fortgesetzt\n' >&2
  fi
fi

migration="$(manifest_value migration)"
note "Archiv vom $(manifest_value created_at), Migrationsstand ${migration:-—}"
# The migration state is the one question that counts before a playing-in: it
# says which `migrate deploy` is necessary afterwards. If it is missing, that is
# a statement about the backup, not one about this archive.
if [ -z "$migration" ] || [ "$migration" = 'unbekannt' ]; then
  printf 'WARNUNG: dieses Archiv nennt keinen Migrationsstand — nach dem Einspielen zeigt ihn `docker compose … run --rm migrate`.\n' >&2
fi

# --- 3. Database -----------------------------------------------------------
# `--clean --if-exists`: the target state is that of the archive, not a
# mixture with what stood there before.
note "Datenbank einspielen ($STACK_DB_MODE)"
stack_pg_restore < "$work/database.dump" || die 'pg_restore ist gescheitert'

# --- 4. Files --------------------------------------------------------------
note 'Dateien einspielen'
mkdir -p "$FILE_STORAGE_DIR" || die "Zielverzeichnis nicht anlegbar: $FILE_STORAGE_DIR"
tar -xzf "$work/files.tar.gz" -C "$FILE_STORAGE_DIR" \
  || die 'die Dateien konnten nicht entpackt werden'

note "fertig — jetzt \`docker compose -f $COMPOSE_PROD_FILE run --rm migrate\`, dann \`up -d\` und scripts/smoke.sh"
