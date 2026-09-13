#!/usr/bin/env bash
#
# create-superadmin.test.sh — regression test for scripts/create-superadmin.sh.
#
# **What it is there for.** The script under test creates the first
# superadministrator of an installation. What it promises while doing so is not
# „it works", but two things that break quietly:
#
#   1. **the password never reaches the command line.** What stands in `argv`
#      stands in `ps` and in the shell history — and nobody sees from a
#      working setup that the password has run through three
#      logs on the way;
#   2. **the variable has the same name on both sides.** The script exports
#      `FORMSACHE_ADMIN_PASSWORD`, the Node command reads `PASSWORD_ENV_VAR`.
#      Two spellings would give a „kein Passwort angegeben" for an
#      entered password, and the error message would point in the wrong
#      direction.
#
# A shell test over the real script, in the style of `prod-setup.test.sh` and for
# the same reason: what is checked here **is** shell — argument checking,
# environment and the command that is built in the end.
#
# **It creates nothing and needs no database.** Every case ends before the
# `exec`, either at a rejection or at `--dry-run`. What the Node part does
# is measured by `apps/api/test/setup/create-superadmin.spec.ts` against a real
# database.
#
# Usage:
#   scripts/tests/create-superadmin.test.sh [path-to-script-under-test]
#
# Exit code: 0 = all cases matched, 1 = at least one not.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_UNDER_TEST="${1:-$ROOT/scripts/create-superadmin.sh}"
CLI_SOURCE="$ROOT/apps/api/src/setup/create-superadmin.main.ts"

failures=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

# A password that must turn up nowhere in the test where it does not belong.
SECRET='geheim-nur-fuer-diesen-test-9x'

run() {
  # `env -u`, so that a password from the environment of the caller does not
  # distort a case: the interactive prompt and the way over the variable are two
  # different cases, and both are meant to establish the state they mean.
  (cd "$ROOT" && env -u FORMSACHE_ADMIN_PASSWORD bash "$SCRIPT_UNDER_TEST" "$@" 2>&1)
}

printf '\n== Angaben ==\n'

out="$(run --help)"; code=$?
if [[ $code -eq 0 && "$out" == *'--email'* && "$out" == *'--tenant-short'* ]]; then
  ok '--help zeigt die Bedienung und endet mit 0'
else
  bad "--help: code=$code out=${out:0:120}"
fi

# ⚠️ **`--dry-run` is the *last* usage line of the header comment, and that is
# why it stands here on its own.** `usage()` used to cut the header to a fixed
# line range (`sed -n '3,31p'`); one line more in the comment above, and
# the last line fell out at the bottom — `--help` quietly kept silent about an
# option that exists. A case that only checks `--email` would never have seen
# that: it stands far enough up to survive every cut. What this assurance
# measures is the **end** of the block.
if [[ "$out" == *'--dry-run'* ]]; then
  ok '--help nennt auch die letzte Bedienzeile (--dry-run)'
else
  bad "--help verschluckt das Ende des Kopfkommentars: out=${out: -160}"
fi

out="$(run --name 'Ohne Adresse')"; code=$?
if [[ $code -ne 0 && "$out" == *'--email fehlt'* ]]; then
  ok 'ohne --email: Abbruch mit Hinweis'
else
  bad "ohne --email: code=$code out=${out:0:120}"
fi

out="$(run --email a@b.example)"; code=$?
if [[ $code -ne 0 && "$out" == *'--name fehlt'* ]]; then
  ok 'ohne --name: Abbruch mit Hinweis'
else
  bad "ohne --name: code=$code out=${out:0:120}"
fi

out="$(run --email a@b.example --name A --tenant-short KURZ --dry-run)"; code=$?
if [[ $code -ne 0 && "$out" == *'nur zusammen'* ]]; then
  ok 'halbe Organisationsangabe: Abbruch mit Hinweis'
else
  bad "halbe Organisationsangabe: code=$code out=${out:0:120}"
fi

# An argument without a value. The case is here because it broke **mutely**: `shift 2`
# with only one argument returns an error code under `set -e`, and the
# script ended without a line of output with code 1 — that is, with the same code
# that the header provides for „nicht angelegt" (a review finding).
out="$(run --email)"; code=$?
if [[ $code -ne 0 && "$out" == *'braucht einen Wert'* ]]; then
  ok 'Angabe ohne Wert: Abbruch mit Meldung, nicht stumm'
else
  bad "--email ohne Wert: code=$code out='${out:0:120}'"
fi

out="$(run --email a@b.example --name)"; code=$?
if [[ $code -ne 0 && "$out" == *'braucht einen Wert'* ]]; then
  ok '… auch als letzte von mehreren Angaben'
else
  bad "--name ohne Wert: code=$code out='${out:0:120}'"
fi

out="$(run --email a@b.example --name A --tempo schnell)"; code=$?
if [[ $code -ne 0 && "$out" == *'Unbekannte Angabe'* ]]; then
  ok 'vertippte Angabe: Abbruch, statt sie zu übergehen'
else
  bad "vertippte Angabe: code=$code out=${out:0:120}"
fi

printf '\n== Das Passwort ==\n'

# The core promise: `--password` is **rejected**, not passed through.
out="$(run --email a@b.example --name A --password "$SECRET")"; code=$?
if [[ $code -ne 0 && "$out" == *'nie von der Kommandozeile'* ]]; then
  ok '--password wird abgewiesen und nicht durchgereicht'
else
  bad "--password: code=$code out=${out:0:160}"
fi
if [[ "$out" != *"$SECRET"* ]]; then
  ok '… und der übergebene Wert steht in keiner Meldung'
else
  bad 'die Zurückweisung von --password gibt den Wert wieder aus'
fi

# The built command — with the password set in the environment, so that the case
# goes exactly the way an operator goes.
out="$(cd "$ROOT" && FORMSACHE_ADMIN_PASSWORD="$SECRET" bash "$SCRIPT_UNDER_TEST" \
        --email a@b.example --name 'Erste Person' \
        --tenant-short DACH --tenant-name Dachorganisation --dry-run 2>&1)"; code=$?
if [[ $code -eq 0 && "$out" == *'--email a@b.example'* && "$out" == *'--tenant-short DACH'* ]]; then
  ok '--dry-run zeigt den Befehl mit allen Angaben'
else
  bad "--dry-run: code=$code out=${out:0:160}"
fi
if [[ "$out" != *"$SECRET"* ]]; then
  ok '… und **ohne** das Passwort'
else
  bad 'der gezeigte Befehl enthält das Passwort'
fi
# The container path passes the variable on **by name** (`-e NAME`), not
# with its value (`-e NAME=wert`) — otherwise the password would stand in the
# command line of `docker`, that is, exactly where it must not stand.
if [[ "$out" == *"-e FORMSACHE_ADMIN_PASSWORD "* ]]; then
  ok '… und gibt die Variable benannt an den Container weiter, nicht ihren Wert'
else
  bad "der Container-Weg reicht die Variable nicht benannt weiter: ${out:0:160}"
fi
# ⚠️ **The `-f` argument, and the one of production at that.** Without it
# `docker compose` takes the `docker-compose.yml` on a host with a
# checked-out repo — the development stack, with `build:` services and
# a different `DATABASE_URL`. The first superadministrator would come into being
# in the wrong database or not at all, and the manual names exactly this command
# as a step of the production commissioning. A case that only reads back the
# arguments would have waved the missing line through.
if [[ "$out" == *'docker compose -f '*'docker-compose.prod.yml run --rm'* ]]; then
  ok '… und ruft den Produktions-Stack, nicht den Entwicklungs-Stack'
else
  bad "der Container-Weg nennt die Produktionsdatei nicht: ${out:0:160}"
fi

# And the file comes from `scripts/lib/stack.sh`, so it is not written down here a
# second time: a `COMPOSE_PROD_FILE` that is set wins.
out="$(cd "$ROOT" && COMPOSE_PROD_FILE=/tmp/anderer-stack.yml \
        FORMSACHE_ADMIN_PASSWORD="$SECRET" bash "$SCRIPT_UNDER_TEST" \
        --email a@b.example --name A --dry-run 2>&1)"
if [[ "$out" == *'-f /tmp/anderer-stack.yml '* ]]; then
  ok 'die Compose-Datei kommt aus stack.sh und ist überschreibbar'
else
  bad "COMPOSE_PROD_FILE wirkt nicht: ${out:0:160}"
fi

out="$(cd "$ROOT" && FORMSACHE_ADMIN_PASSWORD="$SECRET" bash "$SCRIPT_UNDER_TEST" \
        --email a@b.example --name A --local --dry-run 2>&1)"
if [[ "$out" == *'@formsache/api create-superadmin'* ]]; then
  ok '--local ruft den Arbeitsbereich statt des Containers'
else
  bad "--local: ${out:0:160}"
fi

printf '\n== Beide Seiten nennen dieselbe Variable ==\n'

script_var="$(grep -oE 'PASSWORD_VAR=[A-Z_]+' "$SCRIPT_UNDER_TEST" | head -1 | cut -d= -f2)"
cli_var="$(grep -oE "PASSWORD_ENV_VAR = '[A-Z_]+'" "$CLI_SOURCE" | head -1 | cut -d\' -f2)"
if [[ -n "$script_var" && "$script_var" == "$cli_var" ]]; then
  ok "beide nennen $script_var"
else
  bad "Skript nennt '$script_var', der Befehl '$cli_var'"
fi

printf '\n'
if [[ $failures -eq 0 ]]; then
  printf '\033[32mAlle Fälle passten.\033[0m\n'
  exit 0
fi
printf '\033[31m%d Fall/Fälle passten nicht.\033[0m\n' "$failures"
exit 1
