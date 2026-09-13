#!/usr/bin/env bash
#
# env-sync.sh — the mechanics both setup scripts share.
#
# **Why this file exists.** `scripts/dev-setup.sh` and `scripts/prod-setup.sh`
# are deliberately two entry points: two templates, two sets of generated
# secrets, two closing messages. That decision is sound and it is written down
# at the top of `prod-setup.sh`. What it never justified was two copies of the
# *machinery* — 167 of 368 lines were identical, and the copy had already begun
# to drift: the same awk call named its line variable `TARGET_ENV_LINE` in one
# file and `SAMPLE_ENV_LINE` in the other. Two entry points, one mechanism.
#
# **This file is sourced, never executed.** It defines functions and nothing
# else; the shebang is there for editors and for `check-doc-links`, not for a
# caller.
#
# ---------------------------------------------------------------------------
# The contract
#
# Bash has no module boundary, so the boundary is written down instead. The
# caller sets these **before** calling anything here:
#
#   ENV_FILE             the file being written (`.env`, or `--env-file`)
#   EXAMPLE_FILE         the template it is synced against
#   ENV_FILE_IS_DEFAULT  1 if ENV_FILE is the repository's own `.env`, else 0
#   SYNC_ORIGIN          how the dated heading names the caller, e.g.
#                        `scripts/dev-setup.sh`
#
# And these are *written* here, in the caller's scope — they are results, not
# inputs:
#
#   changed              set to 1 whenever this file touched anything
#   added                keys carried over from the template, in order
#   orphans              keys in `ENV_FILE` the template does not know
#
# The caller declares `changed=0`, `added=()` and `orphans=()`; a function that
# appended to an array it had also created would make the two scripts' output
# depend on the order in which they call things.
# ---------------------------------------------------------------------------

# Matches the assignment a dotenv loader would see: optional leading space, an
# optional `export`, then the name. Read and write use the same pattern, so
# this never fills in a variable that is in fact set.
assignment_pattern() {
  printf '^[[:space:]]*(export[[:space:]]+)?%s=' "$1"
}

# The *effective* value: the last assignment wins, which is how the loader
# reads the file. Surrounding whitespace and an empty pair of quotes count as
# no value — `KEY=""` is as unset as `KEY=`.
env_value() {
  local pattern
  pattern="$(assignment_pattern "$1")"
  # `|| true`: no match is an answer here, not an error — and `pipefail` would
  # otherwise turn grep's exit code 1 into a failure of this function.
  { grep -E "$pattern" "$ENV_FILE" || true; } |
    tail -n 1 |
    sed -E "s|$pattern||; s/^[[:space:]]*//; s/[[:space:]]*\$//; s/^(\"\"|'')\$//"
}

# Replaces the last assignment of a key, or appends one if there is none.
# Deliberately the *last* one: that is the assignment the loader uses, so a
# file with duplicate keys keeps every line it had.
#
# The value travels through the environment rather than through a `sed`
# expression — base64 contains `/` and `+`, both of which would need escaping
# in a substitution and neither of which is escaped correctly by accident.
set_env_value() {
  local key="$1" value="$2" line tmp
  line="$({ grep -nE "$(assignment_pattern "$key")" "$ENV_FILE" || true; } |
    tail -n 1 | cut -d: -f1)"
  # A temporary file next to the target, so the move below is atomic and a
  # crash cannot leave a half-written `.env`. The name matches `.env.*` in
  # `.gitignore`; `mktemp` creates it readable by its owner only.
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  if ! SAMPLE_ENV_KEY="$key" SAMPLE_ENV_VALUE="$value" TARGET_ENV_LINE="${line:-0}" awk '
      BEGIN { target = ENVIRON["TARGET_ENV_LINE"] + 0 }
      NR == target { print ENVIRON["SAMPLE_ENV_KEY"] "=" ENVIRON["SAMPLE_ENV_VALUE"]; next }
      { print }
      END { if (target == 0) print ENVIRON["SAMPLE_ENV_KEY"] "=" ENVIRON["SAMPLE_ENV_VALUE"] }
    ' "$ENV_FILE" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$ENV_FILE"
}

# Is the key assigned at all — with a value, empty, does not matter? This is a
# different question from `env_value`: `KEY=` is *present* but *empty*, and the
# two cases are handled differently on purpose (see `sync_from_example`).
has_key() {
  grep -qE "$(assignment_pattern "$2")" "$1"
}

# Every key a file assigns, in the order the file assigns them, each one once —
# a file with a duplicate assignment must not produce a duplicate report.
keys_of() {
  sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$1" |
    awk '!seen[$0]++'
}

# The assignment of a key in the template *together with the comment that
# explains it*. A bare key carried over without its text is worth much less —
# both templates document every variable with its purpose and its readers.
#
# What counts as "its comment": the unbroken run of `#` lines directly above
# the assignment. A blank line ends the run, and that is exactly what separates
# a section banner (`# ---- / # Laufzeit / # ----`, followed by a blank line)
# from the variable underneath it — so the banner is not dragged along. Both
# `*-setup.test.sh` files check that, and both check it by *counter-proof*:
# take the blank line out of the template and the banners multiply.
example_block() {
  SAMPLE_ENV_KEY="$1" awk '
    { line[NR] = $0 }
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" ENVIRON["SAMPLE_ENV_KEY"] "=" { target = NR }
    END {
      if (!target) exit 1
      start = target
      while (start > 1 && line[start - 1] ~ /^[[:space:]]*#/) start--
      for (i = start; i <= target; i++) print line[i]
    }
  ' "$EXAMPLE_FILE"
}

# The template has to be there — for the sync just as much as for the initial
# copy, so this is checked up front rather than inside a branch.
require_example() {
  if [[ ! -f $EXAMPLE_FILE ]]; then
    echo "==> $EXAMPLE_FILE is missing — is this the repository root?" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# ⚠️ The wrong template on the wrong machine
#
# `AGENTS.md` and the operations documentation both say "run the setup script
# after every pull", and on a server that sentence is one autocompletion away
# from `dev-setup.sh`. Run there, against an `.env` that came from
# `.env.prod.example`, the sync did exactly what it promises: it carried the
# nine `SEED_*` variables over — `SEED_ADMIN_PASSWORD=change-me-locally` among
# them — plus `WEB_PORT`, `APP_PORT` and `POSTGRES_PORT`. Precisely what
# splitting the templates in two was meant to prevent. Nothing was breached,
# because the seed refuses to run under `NODE_ENV=production`; but a security
# property that holds only because a *second*, unrelated guard happens to be
# there is a property nobody should be relying on.
#
# So each script recognises the other template's **exclusive** keys in an
# existing `.env` and stops. Exclusive is the load-bearing word: `SECRET_BOX_KEY`
# and `POSTGRES_USER` stand in both templates and say nothing about which file
# this is. `IMAGE_PREFIX`, `BACKUP_KEY` and `BACKUP_DIR` exist only in the
# production template; `SEED_*` and `WEB_PORT` only in the development one.
#
# **Stop, not skip.** Syncing "only the keys that fit" would leave a file that is
# half of each and blame nobody. One sentence, exit 1, and the name of the
# script that belongs here.
# ---------------------------------------------------------------------------
refuse_foreign_env() {
  local sibling="$1" kind="$2" key found=()
  shift 2
  # A file that does not exist yet is about to be copied from the right
  # template — there is nothing foreign about it.
  [[ -f $ENV_FILE ]] || return 0
  for key in "$@"; do
    if has_key "$ENV_FILE" "$key"; then
      found+=("$key")
    fi
  done
  [[ ${#found[@]} -gt 0 ]] || return 0
  local names
  printf -v names '%s, ' "${found[@]}"
  echo "==> $ENV_FILE is a $kind .env (it assigns ${names%, }) — refusing to sync it against $EXAMPLE_FILE; run $sibling instead." >&2
  exit 1
}

# The initial copy. **Never overwrites** — an existing `.env` is the one file on
# a machine that cannot be regenerated from the repository.
create_env_from_example() {
  if [[ ! -f $ENV_FILE ]]; then
    cp "$EXAMPLE_FILE" "$ENV_FILE"
    echo "==> Created $ENV_FILE from $EXAMPLE_FILE"
    changed=1
  else
    echo "==> $ENV_FILE exists — existing values are kept"
  fi
}

# ---------------------------------------------------------------------------
# Sync with the template
#
# Four states, and telling them apart is the whole point — the middle two look
# alike and mean opposite things:
#
#   a) key in the template, **absent** from `.env`
#        → carried over, with the template's value and its comment. This is the
#          `git pull` case: a variable the branch added.
#   b) key in both, `.env` has a **value**
#        → untouched. Always. This is the rule everything else bends around.
#   c) key in both, `.env` **empty**, template **has** a value
#        → untouched as well, and this is the subtle one: the key is there, so
#          somebody put it there and then emptied it. Refilling it from the
#          template would silently undo a deliberate decision. Not the same as
#          (a), even though the effective value is "nothing" in both.
#   d) key in `.env`, **gone** from the template
#        → reported, never deleted. A rename, a removed variable and somebody's
#          own local addition look identical from here, and a script has no
#          business guessing which.
#
# The required secrets are handled by the caller afterwards and cut across this:
# a key that is empty in *both* files and required is generated, not copied.
# That is why a freshly carried-over `SECRET_BOX_KEY` (empty in every template)
# still ends up with a real value — case (a) puts the line and its documentation
# there, the caller's loop fills it.
# ---------------------------------------------------------------------------
sync_from_example() {
  local key block

  while read -r key; do
    # Already appended in this very run, or there all along — either way nothing
    # to do. Re-reading the file is what makes a duplicate in the template
    # harmless.
    has_key "$ENV_FILE" "$key" && continue

    block="$(example_block "$key")"

    if [[ ${#added[@]} -eq 0 ]]; then
      # One dated heading, once per run, before the first carried-over block.
      # Appending rather than inserting at the matching position: what matters
      # here is that the reader *sees what arrived*. A block sorted into the
      # middle of a 240-line file is invisible in exactly the moment it needs to
      # be read, and it makes the result depend on the order of the template.
      # Appended, the news is at the bottom and the rest of the file is
      # untouched, byte for byte.
      #
      # German, because the file it is written into is German throughout.
      {
        printf '\n'
        printf '# %s\n' "---------------------------------------------------------------------------"
        printf '# Aus %s nachgetragen am %s (%s)\n' "$EXAMPLE_FILE" "$(date +%F)" "$SYNC_ORIGIN"
        printf '# %s\n' "---------------------------------------------------------------------------"
      } >> "$ENV_FILE"
    fi

    printf '\n%s\n' "$block" >> "$ENV_FILE"
    added+=("$key")
    changed=1
  done < <(keys_of "$EXAMPLE_FILE")

  while read -r key; do
    has_key "$EXAMPLE_FILE" "$key" || orphans+=("$key")
  done < <(keys_of "$ENV_FILE")
}

# What the sync did, as **names only** — never values, neither a generated key
# nor anything that was already in the file. A name says what happened; a value
# would be the leak.
report_sync() {
  local names
  if [[ ${#added[@]} -gt 0 ]]; then
    printf -v names '%s, ' "${added[@]}"
    echo "==> ${#added[@]} new variable(s) carried over from $EXAMPLE_FILE: ${names%, }"
    echo "    Appended at the end of $ENV_FILE, with their comments — check the values."
  fi

  if [[ ${#orphans[@]} -gt 0 ]]; then
    printf -v names '%s, ' "${orphans[@]}"
    echo "==> ${#orphans[@]} variable(s) in $ENV_FILE that $EXAMPLE_FILE does not know: ${names%, }"
    echo "    Kept untouched — this may be a rename, a removed variable or your own addition."
  fi
}

# This file holds secrets, so a repository that would let it be committed is
# worth one loud line. Cheap to check, and the one mistake that cannot be taken
# back.
#
# Only for the repository's own `.env`: a file somewhere else was named by
# whoever called the script and is not on a path `git check-ignore` can even
# answer for — warning about it would be noise, and noise is how a warning that
# matters gets ignored.
warn_if_not_ignored() {
  if [[ $ENV_FILE_IS_DEFAULT -eq 1 ]] &&
    command -v git > /dev/null 2>&1 && git rev-parse --git-dir > /dev/null 2>&1; then
    if ! git check-ignore -q "$ENV_FILE"; then
      echo "==> WARNING: $ENV_FILE is not ignored by git — do not commit it." >&2
    fi
  fi
}

# "Nothing happened" said out loud. A run that produces no output at all reads
# like a run that did not happen, and the whole point of running this after every
# pull is that the boring case is the common one.
report_outcome() {
  if [[ $changed -eq 0 ]]; then
    echo "==> $ENV_FILE is complete and in step with $EXAMPLE_FILE — nothing changed."
  else
    echo "==> Done."
  fi
}
