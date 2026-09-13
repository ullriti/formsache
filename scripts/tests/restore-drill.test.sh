#!/usr/bin/env bash
#
# restore-drill.test.sh — holds the restore *instructions* and the restore
# *drill* together.
#
# ⚠️ **This checks no behavior.** It compares two texts: the steps that
# `docs/kb/09-betrieb.md` tells a human, and the steps that the CI's
# `restore` job really runs. In the marker language used here that is 📋,
# not 🧪 — the restore itself is evidenced by the job, not
# by this file.
#
# **What it is there for anyway.** Instructions that deviate from the drill are
# worse than none: they look checked. The expensive case is the
# **order** — `migrate deploy` belongs *after* the restore, and whoever runs it
# before that writes into a database that is about to be overwritten.
#
# Usage: scripts/tests/restore-drill.test.sh
# Exit: 0 = congruent, 1 = drifted apart.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANUAL="$ROOT/docs/kb/09-betrieb.md"
WORKFLOW="$ROOT/.github/workflows/ci.yml"
DRILL="$ROOT/scripts/restore-drill.sh"

failures=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

printf '\n== Die Anleitung nennt die Schritte der Probe ==\n'
# ⚠️ **The instructions name `compose run --rm migrate`, not
# `prisma migrate deploy`.** The latter presupposes a pnpm workspace which a
# production server per `docker-compose.prod.yml` does not have at all —
# instructions that name it send the operator down a path that does not
# exist there.
# As a pattern, not as a literal line: since the standalone production stack the
# instructions write out `docker compose -f docker-compose.prod.yml …`.
# What must not drift are the **steps**, not their spelling.
# ⚠️ **`stop api web`, not `down`.** The instructions once said „Stack aus",
# and after that the restore was impossible in exactly the moment it is there
# for: `restore.sh` runs next to the containers and without `db` finds
# neither the database (no published port) nor the upload volume.
for step in 'docker compose .*stop api web' 'docker compose .*up -d db' \
  'scripts/restore.sh' 'run --rm migrate' \
  'docker compose .*up -d' 'scripts/smoke.sh'; do
  if grep -qE "$step" "$MANUAL"; then
    ok "Anleitung nennt: $step"
  else
    bad "Anleitung nennt NICHT: $step"
  fi
done

printf '\n== Die Reihenfolge stimmt in beiden ==\n'
# The one order that something really hangs on.
manual_restore="$(grep -n 'scripts/restore.sh' "$MANUAL" | head -n 1 | cut -d: -f1)"
manual_migrate="$(grep -n 'run --rm migrate' "$MANUAL" | head -n 1 | cut -d: -f1)"
if [ -n "$manual_restore" ] && [ -n "$manual_migrate" ] \
  && [ "$manual_restore" -lt "$manual_migrate" ]; then
  ok 'Anleitung: erst einspielen, dann migrieren'
else
  bad 'Anleitung: die Reihenfolge Einspielen → Migrieren stimmt nicht'
fi

drill_restore="$(grep -n 'pg_restore' "$DRILL" | head -n 1 | cut -d: -f1)"
drill_migrate="$(grep -n 'run --rm migrate' "$DRILL" | head -n 1 | cut -d: -f1)"
if [ -n "$drill_restore" ] && [ -n "$drill_migrate" ] \
  && [ "$drill_restore" -lt "$drill_migrate" ]; then
  ok 'Probe: erst einspielen, dann migrieren'
else
  bad 'Probe: die Reihenfolge Einspielen → Migrieren stimmt nicht'
fi

printf '\n== Die Probe vernichtet wirklich ==\n'
# ⚠️ `down -v`, not `down`. Without `-v` the volume survives, and **every**
# check afterwards is green — including the one that restored nothing.
#
# ⚠️⚠️ **Two corrections are in the next lines, both from a reproduction that
# stayed green:**
#   1. The search happens in the **block of the `restore` job**, not in the
#      file — the first draft stayed green when `down -v` disappeared from the
#      restore job, because the `stack` job has its own.
#   2. The search happens in **`run:` lines**, not in the text — the second
#      draft stayed green because the comment of this job itself contains the
#      character sequence `down -v`. A guard that mistakes the explanation for
#      the thing guards nothing at all.
restore_job="$(awk '/^  restore:/{inside=1} /^  [a-z-]+:$/ && !/^  restore:/{if (inside) exit} inside' "$WORKFLOW" | grep -E '^\s*(run:|- run:|\s+docker |\s+scripts/)')"
if [ -z "$restore_job" ]; then
  bad 'der restore-Job steht nicht in der ci.yml'
elif printf '%s' "$restore_job" | grep -qE 'docker compose down -v'; then
  ok 'der restore-Job fährt `down -v`'
else
  bad 'der restore-Job fährt kein `down -v` — die Probe belegt dann nichts'
fi
# And the point of no return lies **before** the restoring.
destroy_line="$(printf '%s\n' "$restore_job" | grep -n 'down -v' | head -n 1 | cut -d: -f1)"
restore_line="$(printf '%s\n' "$restore_job" | grep -n 'restore-drill.sh restore' | head -n 1 | cut -d: -f1)"
if [ -n "$destroy_line" ] && [ -n "$restore_line" ] && [ "$destroy_line" -lt "$restore_line" ]; then
  ok 'vernichtet wird vor dem Wiederherstellen'
else
  bad 'die Vernichtung steht nicht vor dem Wiederherstellen'
fi

printf '\n== Die Probe prüft, was zurückkam ==\n'
for check in 'sha256sum' 'mail_log' 'login' 'Musterfux'; do
  if grep -qF "$check" "$DRILL"; then
    ok "die Probe prüft: $check"
  else
    bad "die Probe prüft NICHT: $check"
  fi
done

printf '\n== Die Anleitung nennt die drei Sicherungsgegenstände ==\n'
for item in 'SECRET_BOX_KEY' 'BACKUP_KEY' 'Datenbank'; do
  if grep -qF "$item" "$MANUAL"; then
    ok "Anleitung nennt: $item"
  else
    bad "Anleitung nennt NICHT: $item"
  fi
done

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf '\033[32mOK: Anleitung und Probe sind deckungsgleich.\033[0m\n'
  exit 0
fi
printf '\033[31m%d Abweichung(en).\033[0m\n' "$failures"
exit 1
