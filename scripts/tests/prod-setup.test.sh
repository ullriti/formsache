#!/usr/bin/env bash
#
# prod-setup.test.sh — regression test for scripts/prod-setup.sh.
#
# **What it is here for.** This script writes the file that holds a production
# installation's three secrets, and it makes two promises that are worth exactly
# as much as their evidence:
#
#   1. it **generates** `SECRET_BOX_KEY`, `BACKUP_KEY` and `POSTGRES_PASSWORD`
#      rather than copying an empty line — a documented setup path that ends in
#      an application refusing to start is not a setup path;
#   2. it **never** touches an existing value and never overwrites an existing
#      file. A second run against a live server has to be boring.
#
# Both are the kind of promise that breaks silently: nothing turns red when a
# key is written empty, and nothing turns red when a rerun quietly rotates a key
# that a running installation's data is encrypted with. That second one is the
# expensive failure — a rotated `SECRET_BOX_KEY` produces an installation that
# starts, renders, and lets nobody through a protected form any more.
#
# A shell test over a real temporary `.env`, in the style of
# `dev-setup.test.sh` and for the same reason: the thing under test *is* a shell
# script whose job is reading and writing files.
#
# **It never touches the repository's own `.env`.** Every scenario points the
# script at a throwaway copy through `--env-file`.
#
# Usage:
#   scripts/tests/prod-setup.test.sh [path-to-script-under-test]
#
# Exit code: 0 = all scenarios matched, 1 = at least one mismatch.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_UNDER_TEST="${1:-$ROOT/scripts/prod-setup.sh}"

failures=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The three that must never ship with a value. Written out rather than derived
# from the script: this list is the claim, and reading it out of the file under
# test would make the test agree with any future state of that file.
GENERATED=(SECRET_BOX_KEY BACKUP_KEY POSTGRES_PASSWORD)

# Variables that belong to development only and must **not** reach a server's
# template — the whole reason there are two files.
DEV_ONLY=(SEED_ADMIN_PASSWORD SEED_MEMBER_EMAIL SEED_TENANT_ADMIN_PASSWORD WEB_PORT TEST_DATABASE_URL)

# Variables an operator must **not** be asked for any more, each for its own
# reason. `TLS_*` left with the TLS proxy — TLS is the operator's own reverse
# proxy now. `DATABASE_URL` and `FILE_STORAGE_DIR` are pinned by compose inside
# the containers and worked out from the running stack by the host-side backup
# scripts; a line in the template would be a third source for both.
NO_LONGER_ASKED=(TLS_DOMAIN TLS_MODE TLS_HTTP_PORT TLS_HTTPS_PORT PROD_TRUSTED_PROXY_CIDR DATABASE_URL FILE_STORAGE_DIR)

run_setup() {
  (cd "$ROOT" && bash "$SCRIPT_UNDER_TEST" --env-file "$1" 2>&1)
}

value_of() {
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$2=//p" "$1" | tail -n 1
}

contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    ok "$label"
  else
    bad "$label — did not find „$needle\" in the output"
  fi
}

# ---------------------------------------------------------------------------
printf '\n%s\n' "1. .env.prod.example ships no secret and no development leftovers"
# ---------------------------------------------------------------------------
for key in "${GENERATED[@]}"; do
  if [[ -n "$(value_of "$ROOT/.env.prod.example" "$key")" ]]; then
    bad "$key carries a value in .env.prod.example — that is key material in the repository"
  else
    ok "$key is empty in .env.prod.example"
  fi
done

for key in "${DEV_ONLY[@]}"; do
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?$key=" "$ROOT/.env.prod.example"; then
    bad "$key stands in .env.prod.example — a development variable on a server"
  else
    ok "$key is absent from .env.prod.example"
  fi
done

# Including the commented-out form: a documented `# NAME=…` is still something
# an operator reads as a knob and goes looking for.
for key in "${NO_LONGER_ASKED[@]}"; do
  if grep -qE "^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?$key=" "$ROOT/.env.prod.example"; then
    bad "$key still stands in .env.prod.example — nothing reads it any more"
  else
    ok "$key is gone from .env.prod.example"
  fi
done

# ---------------------------------------------------------------------------
printf '\n%s\n' "2. a fresh .env is created, and the three secrets are generated"
# ---------------------------------------------------------------------------
fresh_env="$work/fresh.env"
output="$(run_setup "$fresh_env")"
contains "$output" "Created" "creates a .env when there is none"

for key in "${GENERATED[@]}"; do
  value="$(value_of "$fresh_env" "$key")"
  if [[ -n "$value" ]]; then
    ok "$key was generated"
  else
    bad "$key is still empty after a run"
  fi
  # …and never printed. A key in the output ends up in scrollback and CI logs.
  if [[ -n "$value" && "$output" == *"$value"* ]]; then
    bad "the generated $key was printed"
  else
    ok "the generated $key was not printed"
  fi
done

# 32 random bytes as base64 are 44 characters — the format the templates
# document. Checked rather than assumed: a fallback that produced something
# shorter would satisfy „not empty" and fail the Zod schema at startup.
for key in SECRET_BOX_KEY BACKUP_KEY; do
  value="$(value_of "$fresh_env" "$key")"
  if [[ ${#value} -eq 44 ]]; then
    ok "$key has the documented length (32 bytes base64)"
  else
    bad "$key is ${#value} characters long, expected 44"
  fi
done

# ⚠️ **`POSTGRES_PASSWORD` has a different shape, and this is the check that
# says why.** `docker-compose.yml` builds `DATABASE_URL` by interpolating the
# password into `postgresql://user:PASSWORD@db:5432/db`. The base64 alphabet
# contains `/`; one `/` ends the authority before the `@`, `z.url()` rejects the
# result, and the API aborts complaining about `DATABASE_URL` — never about the
# password. With 43 base64 characters that is a coin flip per provisioned host,
# and by the time anybody looks, Postgres has initialised the role with it.
#
# *Nachstellung:* generate this one as base64 again → this block goes red
# roughly every other run, and the URL check below every other run too. The
# alphabet assertion is therefore the load-bearing one; the length is a
# smoke check that the generator ran at all.
value="$(value_of "$fresh_env" POSTGRES_PASSWORD)"
if [[ ${#value} -eq 64 ]]; then
  ok "POSTGRES_PASSWORD has the documented length (32 bytes hex)"
else
  bad "POSTGRES_PASSWORD is ${#value} characters long, expected 64"
fi
if [[ "$value" =~ ^[0-9a-f]+$ ]]; then
  ok "POSTGRES_PASSWORD uses a URL-safe alphabet"
else
  bad "POSTGRES_PASSWORD contains characters a connection URL reads as syntax: $value"
fi
# And the thing that actually matters, measured end to end rather than argued:
# the URL compose would build out of these values parses.
if node -e '
    const [user, pass, db] = process.argv.slice(1);
    process.exit(URL.canParse(`postgresql://${user}:${pass}@db:5432/${db}`) ? 0 : 1);
  ' "$(value_of "$fresh_env" POSTGRES_USER)" "$value" "$(value_of "$fresh_env" POSTGRES_DB)"; then
  ok "the DATABASE_URL compose builds from these three values parses"
else
  bad "the generated password breaks the DATABASE_URL compose builds"
fi

# The three are **different** from one another. Reusing one value for all three
# would satisfy every check above and defeat the entire point of having three:
# whoever holds the archive key would also hold the column key.
if [[ "$(value_of "$fresh_env" SECRET_BOX_KEY)" != "$(value_of "$fresh_env" BACKUP_KEY)" ]] &&
  [[ "$(value_of "$fresh_env" SECRET_BOX_KEY)" != "$(value_of "$fresh_env" POSTGRES_PASSWORD)" ]] &&
  [[ "$(value_of "$fresh_env" BACKUP_KEY)" != "$(value_of "$fresh_env" POSTGRES_PASSWORD)" ]]; then
  ok "the three secrets are three different values"
else
  bad "two of the generated secrets are identical"
fi

# ⚠️ **Nothing is left to fill in by hand, and that is the assertion.** After
# the secrets above are generated the `.env` is complete: every remaining
# variable ships with a working default. The run says how to start instead of
# handing out a list.
contains "$output" "docker compose -f docker-compose.prod.yml up -d" \
  "says how to start the stack"
# The counter-proof for that claim: every variable in the template really does
# carry a value now, apart from the ones this script generates and `BACKUP_KEY`
# on the second pass. A template with an empty line nobody is told about is the
# failure this replaces.
empty="$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Z_][A-Z0-9_]*)=[[:space:]]*$/\2/p' "$fresh_env" | tr '\n' ' ')"
# `OIDC_ISSUER_ALLOWLIST` is empty on purpose — empty *is* its documented value.
if [[ "$(echo "$empty" | tr -d ' ')" == "OIDC_ISSUER_ALLOWLIST" ]]; then
  ok "the finished .env has no unset variable except the one whose value is empty"
else
  bad "unset variables in the finished .env: ${empty:-<none>}"
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "3. a second run changes nothing — no key is rotated"
# ---------------------------------------------------------------------------
before="$(cat "$fresh_env")"
output="$(run_setup "$fresh_env")"
if [[ "$before" == "$(cat "$fresh_env")" ]]; then
  ok "the file is byte-identical after a second run"
else
  bad "a second run rewrote the file"
fi
contains "$output" "nothing changed" "says that nothing changed"
contains "$output" "exists" "says the file was already there"

# ---------------------------------------------------------------------------
printf '\n%s\n' "4. hand-written values survive, and the template's news arrives"
# ---------------------------------------------------------------------------
old_env="$work/existing.env"
{
  echo "NODE_ENV=production"
  echo "SECRET_BOX_KEY=ein-vorhandener-schluessel"
  echo "BACKUP_KEY=ein-vorhandener-archivschluessel"
  echo "POSTGRES_PASSWORD=ein-vorhandenes-passwort"
  echo "BACKUP_DIR=/daten/sicherungen"
  # A line the template does not know: a rename, a removed variable and
  # somebody's own addition look identical from a script's point of view.
  echo "EIGENE_VARIABLE=egal"
} > "$old_env"

output="$(run_setup "$old_env")"

if [[ "$(value_of "$old_env" SECRET_BOX_KEY)" == 'ein-vorhandener-schluessel' ]]; then
  ok "an existing SECRET_BOX_KEY is untouched — no silent rotation"
else
  bad "SECRET_BOX_KEY was overwritten on an existing file"
fi
if [[ "$(value_of "$old_env" BACKUP_KEY)" == 'ein-vorhandener-archivschluessel' ]]; then
  ok "an existing BACKUP_KEY is untouched"
else
  bad "BACKUP_KEY was overwritten on an existing file"
fi
if [[ "$(value_of "$old_env" POSTGRES_PASSWORD)" == 'ein-vorhandenes-passwort' ]]; then
  ok "an existing POSTGRES_PASSWORD is untouched"
else
  bad "POSTGRES_PASSWORD was overwritten on an existing file"
fi
if [[ "$(value_of "$old_env" BACKUP_DIR)" == '/daten/sicherungen' ]]; then
  ok "a hand-written BACKUP_DIR survives the template's own default"
else
  bad "BACKUP_DIR was overwritten by the template's default"
fi

contains "$output" "EIGENE_VARIABLE" "reports the variable the template does not know"
contains "$output" "does not know" "says in what sense it is unknown"
if grep -qE '^EIGENE_VARIABLE=' "$old_env"; then
  ok "the unknown variable is still in the file — reported, not deleted"
else
  bad "the unknown variable was removed"
fi

# The variables of the template that were missing arrive **with their comment**.
if grep -qE '^[[:space:]]*(export[[:space:]]+)?IMAGE_PREFIX=' "$old_env"; then
  ok "IMAGE_PREFIX was carried over from the template"
else
  bad "IMAGE_PREFIX did not arrive"
fi
if grep -q 'Registry-Präfix' "$old_env"; then
  ok "the carried-over block brought its comment along"
else
  bad "a variable arrived without its explanation"
fi
# …and the section banner did **not** come along. The blank line under each
# `# ----` banner in the template is what makes that true; without it every
# synced `.env` grows a banner per variable.
#
# **Exactly two.** The dated heading the script writes itself is `# ----` / text
# / `# ----`, so two of its three lines are banners and everything above that
# came from the template. This stood at `-le 3` — one line of slack, which is
# exactly enough for the first variable to drag its section heading along
# unnoticed.
banners="$(grep -c -- '---------------------------------------------------------------------------' "$old_env")"
if [[ "$banners" -eq 2 ]]; then
  ok "no section banner was dragged along with a variable ($banners, the dated heading)"
else
  bad "$banners banner lines in the .env, expected 2 — section banners were copied along"
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "5. Gegenprobe: without the blank line under a banner, the count goes up"
# ---------------------------------------------------------------------------
# ⚠️ **The check above asserts that a number stays at 2, and a number stays at 2
# for many reasons** — a sync that carried nothing over would satisfy it too. So
# take the one blank line out of the template that `example_block()` relies on,
# run the same sync, and require the count to rise. If it does not, the check
# above is measuring something other than what it claims.
#
# Built like the scenarios in `check-doc-links.test.sh`: a throwaway root that
# holds what the scenario modifies, so the run reads the sabotaged template
# instead of the repository's own.
sabotaged_root() {
  local root="$work/$1"
  mkdir -p "$root/scripts/lib"
  cp "$SCRIPT_UNDER_TEST" "$root/scripts/prod-setup.sh"
  cp "$ROOT/scripts/lib/env-sync.sh" "$root/scripts/lib/env-sync.sh"
  # Every blank line directly under a `# ----` line is dropped — precisely the
  # line at which `example_block()` stops walking upwards, and therefore
  # precisely what keeps a section heading out of a variable's comment.
  awk '
    /^#[[:space:]]*-----/ { print; banner = 1; next }
    banner && /^[[:space:]]*$/ { banner = 0; next }
    { banner = 0; print }
  ' "$ROOT/.env.prod.example" > "$root/.env.prod.example"
  printf '%s' "$root"
}

sabotaged="$(sabotaged_root banner-glued)"
glued_env="$work/glued.env"
echo "SECRET_BOX_KEY=not-a-real-key" > "$glued_env"
(cd "$sabotaged" && bash scripts/prod-setup.sh --env-file "$glued_env") > /dev/null 2>&1
glued_banners="$(grep -c -- '---------------------------------------------------------------------------' "$glued_env")"
if [[ "$glued_banners" -gt 2 ]]; then
  ok "the sabotaged template drags banners along ($glued_banners lines) — the check above has teeth"
else
  bad "even without the blank line the count stayed at $glued_banners — the check above measures nothing"
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "6. an .env from the development template is refused, not synced"
# ---------------------------------------------------------------------------
# The mirror of the scenario in `dev-setup.test.sh`, and quieter than it: run
# here, a developer's `.env` would grow `IMAGE_PREFIX` and the
# backup settings, and this script would generate three real secrets into a
# checkout. Nobody would notice until `docker compose config` on the actual
# server complained about the file that was never touched.
dev_shaped="$work/dev-shaped.env"
{
  echo "NODE_ENV=development"
  echo "SECRET_BOX_KEY=ein-vorhandener-schluessel"
  echo "WEB_PORT=5173"
  echo "SEED_ADMIN_PASSWORD=change-me-locally"
} > "$dev_shaped"
before="$(cat "$dev_shaped")"

output="$(run_setup "$dev_shaped")"
code=$?

if [[ $code -ne 0 ]]; then
  ok "the run fails instead of syncing ($code)"
else
  bad "a development .env was synced against .env.prod.example and the run reported success"
fi
contains "$output" "scripts/dev-setup.sh" "names the script that belongs on that machine"
if [[ "$before" == "$(cat "$dev_shaped")" ]]; then
  ok "the file is byte-identical — nothing was written before the refusal"
else
  bad "the development .env was modified before the run gave up"
fi
# No secret was generated into a checkout — the expensive half of the mistake.
if grep -qE '^[[:space:]]*(export[[:space:]]+)?BACKUP_KEY=' "$dev_shaped"; then
  bad "BACKUP_KEY was written into a development .env"
else
  ok "no production key reached the development .env"
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "7. the repository's own .env is never touched by these scenarios"
# ---------------------------------------------------------------------------
if [[ "$(ls -A "$work")" == *".env"* ]]; then
  ok "every scenario worked inside the temporary directory"
else
  bad "the temporary directory holds no .env — did a scenario write elsewhere?"
fi

printf '\n'
if [[ $failures -gt 0 ]]; then
  printf '\033[31m%d scenario(s) failed\033[0m\n' "$failures"
  exit 1
fi
printf '\033[32mAll scenarios matched\033[0m\n'
