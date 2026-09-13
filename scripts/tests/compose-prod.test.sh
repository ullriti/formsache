#!/usr/bin/env bash
#
# compose-prod.test.sh — the shape of the production stack.
#
# **What is checked here, and what expressly is not.** Whether the stack *runs*
# is answered by the `stack` job of the CI alone. This file checks what can be
# **wrong** even without a Docker daemon and then stays quietly wrong: a
# `build:` that would let a production server build; a published port that
# nobody ordered; a `NODE_ENV` that switches no `Secure` on the session cookie;
# a seed variable with a default password. All four start up cheerfully.
#
# **Tool:** `docker compose config` (client-side, **needs no
# daemon**) plus `jq` — what is checked is the resolved truth, not the text.
#
# ⚠️ **`docker-compose.prod.yml` has been standalone since point 31**, no
# overlay any more. The test therefore measures it alone; the base file only
# appears as a counter-check („in development there very much is such a thing").
#
# Usage: scripts/tests/compose-prod.test.sh
# Exit: 0 = all scenarios matched, 1 = at least one not.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_FILE="$ROOT/docker-compose.yml"
PROD_FILE="$ROOT/docker-compose.prod.yml"
CI_FILE="$ROOT/.github/ci/docker-compose.ci.yml"
CADDYFILE="$ROOT/.github/ci/tls-proxy/Caddyfile"

# The four services of the production stack, written out. Read from the file
# would mean: the test agrees to every future state.
EXPECTED_SERVICES='api db migrate web'

failures=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

command -v docker >/dev/null 2>&1 || {
  printf 'docker fehlt — dieser Test braucht die CLI (keinen Daemon)\n' >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf 'jq fehlt\n' >&2
  exit 1
}

# Throwaway values, and **not** the `.env` of the machine: `--env-file /dev/null`
# cuts compose off from it, so that this test measures the same thing everywhere.
#
# `NODE_ENV=development` is deliberate: the counter-check below proves that
# `production` comes from the **file** and not from the environment.
export SECRET_BOX_KEY='nur-fuer-diesen-test'
export POSTGRES_USER='formsache' POSTGRES_PASSWORD='nur-fuer-diesen-test' POSTGRES_DB='formsache'
export NODE_ENV='development'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

compose_json() {
  docker compose --env-file /dev/null --project-directory "$ROOT" "$@" \
    config --format json 2>"$work/compose.err"
}

printf '\n== Die Produktionsdatei startet allein ==\n'
# ⚠️ The actual point of this section: **without** the base file. It used to be
# an overlay, and `-f prod.yml` alone gave a stack without networks,
# volumes and healthchecks.
if compose_json -f "$PROD_FILE" > "$work/prod.json"; then
  ok 'docker compose -f docker-compose.prod.yml config läuft durch'
else
  bad "die Konfiguration ist ungültig: $(tail -n 2 "$work/compose.err")"
  printf '\n\033[31mAbbruch: ohne gültige Konfiguration prüft der Rest nichts.\033[0m\n'
  exit 1
fi
compose_json -f "$BASE_FILE" > "$work/base.json" \
  || { printf 'die Basisdatei allein ist ungültig\n' >&2; exit 1; }

prod() { jq -r "$1" < "$work/prod.json"; }
base() { jq -r "$1" < "$work/base.json"; }

# The self-protection: a guard that runs over an empty set is green and
# worthless.
services="$(prod '.services | keys | sort | join(" ")')"
if [ "$services" = "$EXPECTED_SERVICES" ]; then
  ok "genau die vier Dienste: $services"
else
  bad "Dienste sind „$services“, erwartet „$EXPECTED_SERVICES“"
  exit 1
fi

printf '\n== Ein Produktionsserver baut nicht ==\n'
building="$(prod '[.services | to_entries[] | select(.value.build != null) | .key] | join(", ")')"
if [ -z "$building" ]; then
  ok 'kein Dienst trägt ein build:'
else
  bad "diese Dienste bauen: $building"
fi
# Counter-check: in development there **are** build instructions. Without them
# the line above would only check that something is missing that never existed anyway.
base_building="$(base '[.services | to_entries[] | select(.value.build != null) | .key] | sort | join(" ")')"
if [ -n "$base_building" ]; then
  ok "die Entwicklungsdatei baut weiterhin: $base_building"
else
  bad 'die Entwicklungsdatei baut nichts mehr — dann belegt „kein build“ nichts'
fi

printf '\n== Die Images kommen aus der Registry, mit Präfix und Version ==\n'
# Without variables set: the defaults have to give a complete, pullable
# image. That is exactly point 33/34 — no `${VAR:?}` any more that turns away a
# fresh installation before the first start.
for service in api migrate web; do
  image="$(prod ".services[\"$service\"].image")"
  case "$image" in
    ghcr.io/*/formsache-"$service":latest) ok "$service: $image (Vorgaben greifen)" ;;
    *) bad "$service trägt „$image“ — erwartet <praefix>/formsache-$service:latest" ;;
  esac
done
# And with variables set those win: a default that cannot be
# overridden would be none.
pinned="$(IMAGE_PREFIX='registry.example/team' APP_VERSION='1.2.3' \
  compose_json -f "$PROD_FILE" | jq -r '.services.api.image')"
if [ "$pinned" = 'registry.example/team/formsache-api:1.2.3' ]; then
  ok "gesetzte Werte gewinnen: $pinned"
else
  bad "mit IMAGE_PREFIX und APP_VERSION ergibt sich „$pinned“"
fi

printf '\n== Kein Dienst veröffentlicht einen Port ==\n'
# TLS and reachability are the operator's business; the reverse proxy comes
# before `web`. A port here would be an unencrypted entrance that every scanner
# finds first.
published="$(prod '[.services | to_entries[] | select((.value.ports // []) | length > 0) | .key] | join(", ")')"
if [ -z "$published" ]; then
  ok 'kein einziger veröffentlichter Port'
else
  bad "diese Dienste veröffentlichen Ports: $published"
fi
# Counter-check: in development the front door does lie on a port.
if [ "$(base '(.services.web.ports // []) | length')" -ge 1 ]; then
  ok 'die Entwicklungsdatei veröffentlicht den Frontdoor weiterhin'
else
  bad 'die Entwicklungsdatei veröffentlicht nichts mehr — dann belegt die Prüfung darüber nichts'
fi
# And the operator finds the way: a commented-out example at the `web` service.
if grep -q "^    # ports:" "$PROD_FILE" && grep -q "^    # networks:" "$PROD_FILE"; then
  ok 'der web-Dienst zeigt beide Wege für den eigenen Reverse-Proxy'
else
  bad 'am web-Dienst fehlt der auskommentierte Beispielblock (Port oder externes Netz)'
fi

printf '\n== NODE_ENV=production, und es kommt aus der Datei ==\n'
for service in api migrate; do
  if [ "$(prod ".services.$service.environment.NODE_ENV")" = 'production' ]; then
    ok "$service: NODE_ENV=production"
  else
    bad "$service: NODE_ENV ist „$(prod ".services.$service.environment.NODE_ENV")“"
  fi
  # ⚠️ The counter-check counts: this test runs with `NODE_ENV=development` in
  # the environment. The development file passes the value through, the
  # production file does not — otherwise the `production` above would come from
  # here instead of from the file.
  if [ "$(base ".services.$service.environment.NODE_ENV")" = 'development' ]; then
    ok "$service: die Entwicklungsdatei übernimmt weiterhin den Umgebungswert"
  else
    bad "$service: die Entwicklungsdatei liefert nicht den Umgebungswert — die Prüfung darüber wäre zufällig grün"
  fi
done

printf '\n== Keine Seed-Variablen in der Produktion ==\n'
# `prisma db seed` creates a superadministrator. A password filled with a
# default in the process environment of a server is exactly the secret that
# nobody misses until somebody uses it.
seeds="$(prod '[.services | to_entries[] | .key as $s | (.value.environment // {}) | keys[] | select(startswith("SEED_")) | $s + "." + .] | join(", ")')"
if [ -z "$seeds" ]; then
  ok 'kein Dienst trägt eine SEED_-Variable'
else
  bad "Seed-Variablen in der Produktion: $seeds"
fi
base_seeds="$(base '[.services | to_entries[] | (.value.environment // {}) | keys[] | select(startswith("SEED_"))] | length')"
if [ "${base_seeds:-0}" -ge 1 ]; then
  ok "die Entwicklungsdatei trägt weiterhin $base_seeds Seed-Variable(n) — es gab also etwas wegzulassen"
else
  bad 'die Entwicklungsdatei hat keine Seed-Variablen mehr — dann belegt die Zeile darüber nichts'
fi

printf '\n== TRUST_PROXY_HOPS ist in beiden Gestalten dieselbe Zahl ==\n'
# ⚠️ Not „one hop more in production": the nginx front door *replaces*
# `X-Forwarded-For` instead of appending — at the API a chain of length 1
# always arrives. The caller is resolved in the front door (`set_real_ip_from`),
# not in the number. Two numbers for two shapes would be two opportunities
# to get it wrong.
base_hops="$(base '.services.api.environment.TRUST_PROXY_HOPS')"
prod_hops="$(prod '.services.api.environment.TRUST_PROXY_HOPS')"
if [ "$prod_hops" = "$base_hops" ]; then
  ok "Entwicklung $base_hops → Produktion $prod_hops"
else
  bad "Entwicklung $base_hops, Produktion $prod_hops — die Zahl darf sich nicht unterscheiden"
fi

printf '\n== Der Frontdoor löst den Aufrufer auf ==\n'
# Without this check the number above would be a number without a reason: `1` is
# only right **because** the front door runs `real_ip`.
template="$ROOT/apps/web/docker/default.conf.template"
# ⚠️ `off`, not `on` — with `on` nginx would take the last *not* trusted
# address, and an entry handed in could win.
if grep -qE '^\s*set_real_ip_from' "$template" \
  && grep -qE '^\s*real_ip_recursive\s+off' "$template"; then
  ok 'der Frontdoor fährt set_real_ip_from mit real_ip_recursive off'
else
  bad 'der Frontdoor löst den Aufrufer nicht auf, oder er tut es rekursiv'
fi

base_cidr="$(base '.services.web.environment.TRUSTED_PROXY_CIDR')"
prod_cidr="$(prod '.services.web.environment.TRUSTED_PROXY_CIDR')"
# In development the front door is the outermost thing there is, so an
# `X-Forwarded-For` reaching it comes from the internet: `127.0.0.1/32` is the
# effective off state.
if [ "$base_cidr" = '127.0.0.1/32' ]; then
  ok "die Entwicklung vertraut praktisch niemandem ($base_cidr)"
else
  bad "die Entwicklung vertraut „$base_cidr“ — gefälschte Header würden geglaubt"
fi
if [ -n "$prod_cidr" ] && [ "$prod_cidr" != 'null' ] && [ "$prod_cidr" != "$base_cidr" ]; then
  ok "die Produktion vertraut dem Netz ihres Reverse-Proxys ($prod_cidr)"
else
  bad 'die Produktion setzt kein eigenes TRUSTED_PROXY_CIDR — der Frontdoor sähe den Proxy als Aufrufer'
fi

# ⚠️ **This file cannot check the counting, only the shape.** Whether the API
# behind two proxies really counts the address of the caller is measured by the
# `stack` job with two callers with different addresses.

printf '\n== Der TLS-Proxy ist reines CI-Beiwerk ==\n'
# It stood in the production path until point 1/35. Now TLS belongs to the
# operator, and the proxy only exists any more so that the `stack` job can
# measure the `__Host-` cookie and the counting of `X-Forwarded-For` at all.
if [ ! -e "$ROOT/docker" ]; then
  ok 'docker/ gibt es nicht mehr'
else
  bad 'docker/ steht noch im Repository'
fi
if [ -f "$CI_FILE" ] && [ -f "$CADDYFILE" ]; then
  ok 'die CI-Gestalt liegt unter .github/ci/'
else
  bad 'unter .github/ci/ fehlt das Overlay oder der Caddyfile'
fi
if compose_json -f "$PROD_FILE" -f "$CI_FILE" > "$work/ci.json"; then
  ci() { jq -r "$1" < "$work/ci.json"; }
  if [ "$(ci '.services["tls-proxy"] // "fehlt"')" != 'fehlt' ]; then
    ok 'das CI-Overlay legt den tls-proxy dazu'
  else
    bad 'das CI-Overlay legt keinen tls-proxy an'
  fi
  if [ "$(ci '[.services["tls-proxy"].ports[].target] | sort | join(",")')" = '80,443' ]; then
    ok 'und veröffentlicht 80 und 443 — nur dort'
  else
    bad "der tls-proxy nimmt „$(ci '[.services["tls-proxy"].ports[].target] | join(",")')“"
  fi
  # The Caddyfile is mounted read-only, and the path really points to the
  # file — a wrongly resolved relative path would otherwise create a directory.
  mount="$(ci '[.services["tls-proxy"].volumes[] | select(.target == "/etc/caddy/Caddyfile")] | first')"
  if [ "$(printf '%s' "$mount" | jq -r '.read_only')" = 'true' ] \
    && [ "$(printf '%s' "$mount" | jq -r '.source')" = "$CADDYFILE" ]; then
    ok 'der Caddyfile ist read-only und unter dem erwarteten Pfad eingehängt'
  else
    bad "der Caddyfile ist falsch eingehängt: $mount"
  fi
  if grep -qF 'reverse_proxy web:8080' "$CADDYFILE"; then
    ok 'der Proxy reicht an den nginx-Frontdoor weiter'
  else
    bad 'der Caddyfile reicht nicht an web:8080 weiter'
  fi
else
  bad "Produktionsdatei + CI-Overlay ergeben keine gültige Konfiguration: $(tail -n 2 "$work/compose.err")"
fi

printf '\n== Der Umgebungsvertrag der Produktion, Tabelle B ==\n'
# ⚠️ **Measured, not read.** Which variable production *really*
# needs cannot be seen from any line: `${X:-vorgabe}` is optional,
# `${X:?…}` is mandatory, and a value that the file fixes is not even asked
# for. Therefore every interpolated variable is taken out of the environment
# once, and `docker compose config` says whether it works without it.
CONTRACT_DOC="$ROOT/docs/kb/09-betrieb.md"

candidates="$(grep -ho '\${[A-Z_][A-Z0-9_]*' "$PROD_FILE" | sed 's/\${//' | sort -u)"
if [ "$(printf '%s\n' "$candidates" | wc -l)" -ge 10 ]; then
  ok "$(printf '%s\n' "$candidates" | wc -l) Kandidaten aus der Produktionsdatei gelesen"
else
  bad 'zu wenige Kandidaten gelesen — der Rest dieses Abschnitts misst nichts'
  candidates=''
fi

doc_rows="$(sed -n '/<!-- env-contract:host -->/,/<!-- \/env-contract:host -->/p' \
  "$CONTRACT_DOC")"
doc_required="$(printf '%s\n' "$doc_rows" \
  | sed -n 's/^| `\([A-Z_][A-Z0-9_]*\)` *| *Pflicht.*/\1/p' | sort -u)"
doc_all="$(printf '%s\n' "$doc_rows" \
  | sed -n 's/^| `\([A-Z_][A-Z0-9_]*\)`.*/\1/p' | sort -u)"
if [ -n "$doc_required" ]; then
  ok "die Tabelle nennt $(printf '%s\n' "$doc_required" | wc -l) Pflichtvariablen"
else
  bad "in $CONTRACT_DOC ist der Block env-contract:host leer oder fehlt"
fi

measured=''
for name in $candidates; do
  # `env -u NAME`: exactly this one is missing, all the others stay standing.
  if env -u "$name" docker compose --env-file /dev/null \
      --project-directory "$ROOT" -f "$PROD_FILE" config > /dev/null 2>&1; then
    continue
  fi
  measured="$measured$name
"
done
measured="$(printf '%s' "$measured" | sort -u)"
printf '   gemessen als Pflicht: %s\n' "$(printf '%s' "$measured" | tr '\n' ' ')"

# ⚠️ **Mandatory is now only what is a secret.** Everything else has a
# default with which a fresh installation starts — that is point 32/33/34.
if [ "$(printf '%s' "$measured" | tr '\n' ' ')" = 'POSTGRES_PASSWORD SECRET_BOX_KEY' ]; then
  ok 'Pflicht sind genau die beiden echten Geheimnisse'
else
  bad "Pflicht sind „$(printf '%s' "$measured" | tr '\n' ' ')“ — erwartet nur POSTGRES_PASSWORD und SECRET_BOX_KEY"
fi

missing="$(comm -23 <(printf '%s\n' "$measured") <(printf '%s\n' "$doc_required"))"
if [ -z "$missing" ]; then
  ok 'die Tabelle nennt jede Variable, ohne die die Produktion nicht startet'
else
  bad "in der Tabelle fehlen als Pflicht: $(printf '%s' "$missing" | tr '\n' ' ')"
fi

invented="$(comm -13 <(printf '%s\n' "$measured") <(printf '%s\n' "$doc_required"))"
if [ -z "$invented" ]; then
  ok 'und keine, die in Wahrheit einen Vorgabewert hat'
else
  bad "die Tabelle führt als Pflicht, was ohne sie durchläuft: $(printf '%s' "$invented" | tr '\n' ' ')"
fi

unknown="$(comm -23 <(printf '%s\n' "$doc_all") <(printf '%s\n' "$candidates"))"
if [ -z "$unknown" ]; then
  ok 'jede Zeile der Tabelle kommt in der Produktionsdatei vor'
else
  bad "die Tabelle nennt Variablen, die die Produktionsdatei nicht interpoliert: $(printf '%s' "$unknown" | tr '\n' ' ')"
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf '\033[32mOK: alle Szenarien passten.\033[0m\n'
  exit 0
fi
printf '\033[31m%d Szenario(s) fehlgeschlagen.\033[0m\n' "$failures"
exit 1
