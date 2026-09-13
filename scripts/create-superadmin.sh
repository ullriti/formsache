#!/usr/bin/env bash
#
# create-superadmin.sh — der **zweite Weg** zum ersten Administrator einer
# Installation (ADR-0022 Nr. 4).
#
# Der erste Weg ist die Einrichtungsseite: solange eine Installation null
# Nutzerkonten hat, zeigt die Anwendung statt der Anmeldung eine Einrichtung.
# Dieser Befehl ist für Betreiber, die diese Seite nie freigeben wollen — hinter
# einem Proxy, in einer Umgebung, in der die Anwendung erst erreichbar sein darf,
# wenn sie eingerichtet **ist**. Beide Wege enden in derselben Transaktion mit
# derselben Bedingung (`apps/api/src/setup/first-superadmin.ts`); dieses Skript
# ist Bedienung, kein zweiter Anlegepfad.
#
# **Das Passwort steht nie in der Kommandozeile.** Nicht als Bequemlichkeit
# weggelassen, sondern absichtlich unmöglich gemacht: was in `argv` steht, steht
# in `ps`, in der Shell-Historie und in jedem Prozessprotokoll, das mitschreibt
# — für ein Kennwort, das ab dem nächsten Moment die ganze Installation
# aufsperrt. Es kommt aus `FORMSACHE_ADMIN_PASSWORD` oder wird hier verdeckt und
# zweimal abgefragt.
#
# Die Organisation ist **überspringbar**: ohne `--tenant-short`/`--tenant-name`
# entsteht ein Superadministrator ohne Mitgliedschaft, und das ist ein gültiger
# Endzustand — `user` trägt keine `tenant_id`.
#
# Usage:
#   scripts/create-superadmin.sh --email A --name N [--tenant-short S --tenant-name T]
#                                [--local] [--dry-run]
#
#   --local     im Arbeitsbereich statt im Container (Entwicklung)
#   --dry-run   nur zeigen, was liefe — ohne das Passwort
#
# Exit-Code: 0 = angelegt, sonst der des Befehls (1 = nicht angelegt).
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The variable the Node command reads the password from. Must match
# `PASSWORD_ENV_VAR` in `apps/api/src/setup/create-superadmin.main.ts`;
# `scripts/tests/create-superadmin.test.sh` holds both against each other,
# because a typo here would be a „kein Passwort angegeben" for a password that
# was actually entered.
PASSWORD_VAR=FORMSACHE_ADMIN_PASSWORD

# Because of `COMPOSE_PROD_FILE`: the file is the only place that knows which
# stack is production.
# shellcheck source=lib/stack.sh
source "$ROOT/scripts/lib/stack.sh"

# The usage help **is** the header comment of this file — written once, read in
# two places.
#
# ⚠️ **The cut is made on a marker, not on line numbers.** `sed -n '3,31p'` stood
# here, and with that `--help` hung on a number that nobody keeps up to date: one
# line more in the header, and the last usage line (`--dry-run`) silently fell
# out of the output — without anything having turned red.
# `scripts/tests/create-superadmin.test.sh` demands it explicitly ever since.
#
# The marker is the **start of the code**: what gets printed is the contiguous
# comment block below the shebang, up to the first line that is no longer a
# comment. However long the header gets, `--help` shows all of it.
usage() {
  awk '
    NR == 1 { next }
    /^#/ {
      text = $0
      sub(/^# ?/, "", text)
      # Leave out leading blank lines of the block, keep later ones — those
      # separate the paragraphs that make the text readable.
      if (started || text != "") { started = 1; print text }
      next
    }
    { exit }
  ' "${BASH_SOURCE[0]}"
}

die() {
  printf 'create-superadmin: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

email=''
name=''
tenant_short=''
tenant_name=''
mode=compose
dry_run=0

# A value that is really there.
#
# ⚠️ **`shift 2` with only one remaining argument is, under `set -e`, the end of
# the script** — `shift` then returns an error code, and the shell aborts before
# any message has been written (a review finding).
# `scripts/create-superadmin.sh --email` thus printed nothing at all and ended
# with 1, which the header of this file documents as „nicht angelegt". Therefore
# the count is checked before shifting.
need_value() {
  [[ $# -ge 2 ]] || die "$1 braucht einen Wert."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)        need_value "$@"; email="$2"; shift 2 ;;
    --name)         need_value "$@"; name="$2"; shift 2 ;;
    --tenant-short) need_value "$@"; tenant_short="$2"; shift 2 ;;
    --tenant-name)  need_value "$@"; tenant_name="$2"; shift 2 ;;
    --local)        mode=local; shift ;;
    --dry-run)      dry_run=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    # Explicitly rejected instead of passed through: `--password geheim` would be
    # the one piece of input this script must not accept, and „unbekannt"
    # would be too quiet an answer for it.
    --password|--password=*)
      die "Das Passwort kommt aus $PASSWORD_VAR oder aus der Eingabe — nie von der Kommandozeile." ;;
    *)              die "Unbekannte Angabe: $1" ;;
  esac
done

[[ -n "$email" ]] || die '--email fehlt.'
[[ -n "$name"  ]] || die '--name fehlt.'

args=(--email "$email" --name "$name")
if [[ -n "$tenant_short" || -n "$tenant_name" ]]; then
  # Both or neither. The Node command checks this once more — it stands here so
  # that a `--dry-run` says it too.
  [[ -n "$tenant_short" && -n "$tenant_name" ]] \
    || die '--tenant-short und --tenant-name gelten nur zusammen.'
  args+=(--tenant-short "$tenant_short" --tenant-name "$tenant_name")
fi

if [[ "$mode" == local ]]; then
  cmd=(pnpm --filter @formsache/api create-superadmin --)
else
  # The shipped image carries `dist/`, no source code — the command there is the
  # same compiled file as the application next to it.
  #
  # ⚠️ **With `-f`.** Without the file, `docker compose` would take the
  # `docker-compose.yml` on a host with a checked-out repo — the development
  # stack, with `build:` services and a different `DATABASE_URL`. The first
  # superadministrator would then come into being in the wrong database or not at
  # all.
  cmd=(docker compose -f "$COMPOSE_PROD_FILE" run --rm -e "$PASSWORD_VAR" api
       node dist/setup/create-superadmin.main.js)
fi

if [[ "$dry_run" == 1 ]]; then
  # Without the password and without its value — the line is there to be shown.
  printf '%s\n' "${cmd[*]} ${args[*]}"
  exit 0
fi

if [[ -z "${!PASSWORD_VAR:-}" ]]; then
  # Hidden and twice over: a typo in the password of the first account of an
  # installation is an installation that nobody gets into — and the way back
  # would again be manual work in the database.
  read -r -s -p 'Passwort: ' first; echo
  read -r -s -p 'Passwort wiederholen: ' second; echo
  [[ "$first" == "$second" ]] || { echo 'create-superadmin: Die Eingaben stimmen nicht überein.' >&2; exit 2; }
  [[ -n "$first" ]] || { echo 'create-superadmin: Kein Passwort eingegeben.' >&2; exit 2; }
  export "$PASSWORD_VAR=$first"
  unset first second
fi

exec "${cmd[@]}" "${args[@]}"
