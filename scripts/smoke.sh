#!/usr/bin/env bash
#
# smoke.sh — the smoke test against a **running** installation
# .
#
#   scripts/smoke.sh https://formulare.example.org
#   scripts/smoke.sh http://127.0.0.1:8080          # the local stack
#
# **What it is there for.** After a release, after a restore and at go-live the
# question is never „is the container running", but „does the installation do
# what it is there for". Between the two lies everything that can go wrong
# without a container dying: a database without migration, an upload volume
# that belongs to the wrong user, a mail worker that is not running, an export
# that delivers nonsense.
#
# **Seven promises, and each one is a promise that has already been broken on
# its own:**
#
#   1. Readiness      — `/api/health/ready`: 200 means „database there".
#   2. Login          — an account gets through the door.
#   3. Form           — a public form is retrievable **and
#                       submittable**. „Retrievable" alone would be a page, not
#                       a path.
#   4. Mail           — the submission creates a `mail_log` row, and that row
#                       goes to `sent`. A row that stays on `queued` is a mail
#                       worker that is not running — a case that no container
#                       status shows.
#                       ⚠️ **For this the smoke test creates a notification.**
#                       A submission does **not** create a mail by itself:
#                       what goes out is a policy on the form
#                       (`submission-mail.ts`), not a side effect of
#                       submitting. Without this step promise 4 would ask for
#                       a row that would never exist on **any** installation
#                       — red forever, without ever saying anything about the
#                       mail path.
#                       ⚠️ **And the organisation needs its own mail
#                       server** (ADR-0023). Form mail goes over theirs, never
#                       over the installation's; if it is missing, the row
#                       stays held back on `queued`, and this promise reports a
#                       worker error that does not exist.
#   5. Attachment     — uploaded and back **with the same checksum**. The file
#                       path is the half of the data that does not live in the
#                       database (ADR-0014).
#   6. Export         — a file that a spreadsheet program would open.
#   7. Schema state   — the database is at the state of the code (review
#                       finding, 2026-08-12). The case behind it is measured: a
#                       restore whose `migrate deploy` **fails to happen**
#                       leaves behind an installation that runs on an old
#                       schema — `/api/health/ready` still reports 200, the
#                       login works, and nothing turns red. That was exactly
#                       the result of a second reproduction, and not one of
#                       the other six promises found it.
#
# ⚠️ **Promise 6 checks the file signature, not the status.** Once the Excel
# export went out as JSON: status 200, every header right, 34 KB in size —
# and it opened in no spreadsheet program, because Nest serialised the buffer as
# `{"type":"Buffer","data":[80,75,3,4,…]}`. A step that shortens this to
# „status 200" stays green in exactly this case. What is checked are therefore
# the first two bytes: `PK` is what distinguishes a workbook from a JSON array
# of its bytes.
#
# **What the smoke test leaves behind: nothing.** It creates a form of its own
# and clears it away again at the end (trash). A smoke test that leaves traces
# in the response table of a real installation is not run any more after the
# second time.
#
# **Credentials** come from the environment, never from a file in the repo:
#   SMOKE_EMAIL / SMOKE_PASSWORD   (default: the seed credentials)
#   SMOKE_MAIL_TO                  (default: SMOKE_EMAIL)
# On a production installation the operator sets an account of their own —
# `09-betrieb.md` says which rights it needs: build forms, see responses,
# export **and `canManageSettings`**, because promise 4 creates a notification
# and the route demands exactly this right.
#
# Exit: 0 = all promises kept, 1 = at least one not.
set -uo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  printf 'Aufruf: scripts/smoke.sh <basis-url>\n' >&2
  exit 2
fi
BASE="${BASE%/}"

EMAIL="${SMOKE_EMAIL:-admin@example.org}"
PASSWORD="${SMOKE_PASSWORD:-change-me-locally}"
# Where the one smoke-test mail goes. **The default is the account that runs
# the smoke test** — not an invented address: that one ended up at a real mail
# server as a delivery failure, and promise 4 would be red although the mail
# path does what it should.
MAIL_TO="${SMOKE_MAIL_TO:-$EMAIL}"
# Self-signed certificates: the smoke test also runs against an installation
# with `tls internal`. Whoever wants to check the chain checks it with a tool
# that is made for it — here it is about the application.
CURL_OPTS=(-sS --max-time 30)
[ "${SMOKE_INSECURE:-0}" = '1' ] && CURL_OPTS+=(-k)

failures=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}
die() {
  printf '\033[31msmoke: %s\033[0m\n' "$1" >&2
  exit 1
}

work="$(mktemp -d)"
cleanup() {
  # Clean up, even if something above failed: a half-created form is exactly
  # the leftover that the next run cannot use.
  if [ -n "${FORM_ID:-}" ]; then
    api DELETE "/forms/$FORM_ID" > /dev/null 2>&1
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# ⚠️ **The CSRF token, and why this script got a 403 without it.**
#
# Every mutating route sits behind the global `CsrfGuard`. The
# server sets the token as a **second cookie** (`formsache_csrf`, under TLS
# `__Host-formsache_csrf`), and the caller sends it back in the header
# `x-csrf-token` — the usual double-submit pattern that a browser can do by
# itself and a script cannot.
#
# The first CI run of this script failed on exactly that: `POST /api/forms`
# answered **403**, and that reads like a rights error. The helper of the
# test suite carries the sentence verbatim: *„forgetting the second one produces
# a 403 that reads like an authorisation bug and is not."* It was there before
# this script was written.
csrf_token() {
  # Netscape cookie jar: field 6 is the name, field 7 the value. The last
  # hit wins — after a login the fresh token is at the bottom.
  awk '$6 == "formsache_csrf" || $6 == "__Host-formsache_csrf" { value = $7 } END { print value }' \
    "$work/cookies"
}

# A call with a session — cookie jar as with a browser, plus the token.
api() {
  local method="$1" path="$2"
  shift 2
  curl "${CURL_OPTS[@]}" -X "$method" -b "$work/cookies" -c "$work/cookies" \
    -H 'content-type: application/json' \
    -H "x-csrf-token: $(csrf_token)" "$@" "$BASE/api$path"
}
status_of() {
  local method="$1" path="$2"
  shift 2
  curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' -X "$method" \
    -b "$work/cookies" -c "$work/cookies" \
    -H "x-csrf-token: $(csrf_token)" "$@" "$BASE/api$path"
}
# ⚠️ **If the value is missing, nothing comes back — not the word „undefined".**
#
# `String(undefined)` is `"undefined"`, and that is a **non-empty**
# string: `[ -n "$file_ref" ]` was thereby true although the upload had
# been rejected. The smoke test reported „die Anlage ist angenommen" and
# afterwards fetched `/api/responses/files/undefined` — a 404 which it read as
# „changed attachment". A helper that turns absence into a value makes every
# `-n` check behind it meaningless.
json() {
  node -e "const d=require('fs').readFileSync(0,'utf8');const v=JSON.parse(d)$1;process.stdout.write(v === undefined || v === null ? '' : String(v))" 2>/dev/null
}

# A real PNG, 70 bytes, 1×1 — see the comment at promise 4.
ATTACHMENT_NAME='anlage.png'
ATTACHMENT_BASE64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

printf '\033[1mRauchtest gegen %s\033[0m\n' "$BASE"

# ---------------------------------------------------------------------------
step '1/6 Bereitschaft'
# ⚠️ `/api/health/ready` and **not** `/api/health`: liveness
# answers 200 as long as the process is alive — even with a dead database.
# A smoke test that asks liveness is green in exactly the case it was
# built for.
ready="$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/health/ready")"
if [ "$ready" = '200' ]; then
  ok "/api/health/ready antwortet 200"
else
  bad "/api/health/ready antwortet $ready"
  die 'ohne Bereitschaft ist der Rest dieses Laufs bedeutungslos'
fi
version="$(curl "${CURL_OPTS[@]}" "$BASE/api/health" | json '.version')"
ok "die Installation läuft auf Fassung ${version:-unbekannt}"

# ---------------------------------------------------------------------------
step '2/6 Anmeldung'
# ⚠️ **The body goes through a file, not through `-d`** (review finding).
# The header comment explicitly provides for a **real** account of the
# production installation, and `09-betrieb.md` runs this script after every
# release: a password in the argument would stand in `/proc/<pid>/cmdline` for
# the duration of the call, readable by every local user. `$work` comes from
# `mktemp -d` with 0700.
printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD" > "$work/login-body.json"
login_status="$(curl "${CURL_OPTS[@]}" -o "$work/login.json" -w '%{http_code}' \
  -c "$work/cookies" -H 'content-type: application/json' \
  --data @"$work/login-body.json" \
  "$BASE/api/auth/login")"
rm -f "$work/login-body.json"
if [ "$login_status" = '200' ] && grep -q 'formsache_session' "$work/cookies" \
  && [ -n "$(csrf_token)" ]; then
  ok "Anmeldung als $EMAIL, Sitzungs- und CSRF-Cookie gesetzt"
else
  bad "Anmeldung antwortete $login_status"
  die 'ohne Anmeldung sind die Zusagen 3 bis 6 nicht prüfbar'
fi

# ---------------------------------------------------------------------------
step '3/6 Ein öffentliches Formular ist abrufbar und absendbar'
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
api POST /forms -d "{\"title\":\"Rauchtest $stamp\"}" > "$work/form.json"
FORM_ID="$(json '.id' < "$work/form.json")"
[ -n "$FORM_ID" ] || die "das Formular ließ sich nicht anlegen: $(head -c 200 "$work/form.json")"
revision="$(json '.revision' < "$work/form.json")"
slug="$(json '.publicSlug' < "$work/form.json")"

# Two questions, and the second one is a **file** question: without it the
# uploaded attachment would stay unclaimed, and promise 5 would check an
# orphaned file instead of one that belongs to the data.
api PUT "/forms/$FORM_ID" -d "$(cat <<JSON
{"title":"Rauchtest $stamp","revision":$revision,
 "definition":{"pages":[{"id":"019ff400-0000-7000-8000-0000000000d0","title":"Seite",
 "questions":[
   {"id":"019ff400-0000-7000-8000-0000000000d1","type":"text","label":"Zuname",
    "hint":null,"required":true,"width":"full","minLength":null,"maxLength":null,"pattern":null},
   {"id":"019ff400-0000-7000-8000-0000000000d2","type":"file","label":"Nachweis",
    "hint":null,"required":true,"width":"full","maxFiles":1}
 ]}]}}
JSON
)" > "$work/saved.json"
saved_revision="$(json '.revision' < "$work/saved.json")"
[ -n "$saved_revision" ] || die "das Formular ließ sich nicht speichern: $(head -c 200 "$work/saved.json")"
# ⚠️ **The notification, without which promise 4 can measure nothing.** A
# submission does not create a mail by itself; `mail_log` rows arise from
# the notifications of the form (`submission-mail.ts`). The smoke test
# therefore creates exactly one — trigger `submit` is the default.
api POST "/forms/$FORM_ID/notifications" -d "$(cat <<JSON
{"name":"Rauchtest","subject":"Rauchtest $stamp",
 "body":"Diese Mail belegt, dass die Warteschlange arbeitet.",
 "recipients":[{"kind":"literal","address":"$MAIL_TO"}],
 "replyTo":null}
JSON
)" > "$work/notification.json"
if [ -n "$(json '.id' < "$work/notification.json")" ]; then
  ok "eine Benachrichtigung an $MAIL_TO ist angelegt"
else
  bad "die Benachrichtigung ließ sich nicht anlegen: $(head -c 200 "$work/notification.json")"
  die 'ohne Benachrichtigung entsteht keine mail_log-Zeile — Zusage 4 wäre unmessbar'
fi

api POST "/forms/$FORM_ID/publish" -d "{\"revision\":$saved_revision}" > "$work/published.json"
if [ "$(json '.status' < "$work/published.json")" = 'active' ]; then
  ok "Formular „Rauchtest $stamp“ ist veröffentlicht"
else
  bad "das Formular wurde nicht aktiv: $(head -c 200 "$work/published.json")"
  die 'ohne veröffentlichtes Formular sind die Zusagen 4 bis 6 nicht prüfbar'
fi

# Retrievable — **without login**, the way a participant does it. Hence a
# curl call of its own without cookie jar: checked with a session it would not
# be a public path, but a logged-in one.
public_status="$(curl "${CURL_OPTS[@]}" -o "$work/public.json" -w '%{http_code}' \
  "$BASE/api/public/forms/$slug")"
if [ "$public_status" = '200' ]; then
  ok "öffentlich abrufbar (ohne Anmeldung): /public/forms/$slug"
else
  bad "das öffentliche Formular antwortet $public_status"
fi

# ---------------------------------------------------------------------------
step '4/6 Anlage hochladen und absenden'
# ⚠️ **Raw bytes, no multipart — and a real image.**
#
#   * The upload route takes **only** `application/octet-stream` and answers
#     415 to everything else (ADR-0014 Nr. 14). That is not a formality: a
#     foreign HTML form can send urlencoded, multipart or plain text —
#     and with that the route is grammatically unreachable for a foreign
#     sender. A `curl -F` sends exactly the one thing it does not take.
#   * The file name travels percent-encoded in `x-file-name`, because a header
#     line is latin-1 by the writing of the protocol.
#   * The positive list (PDF, PNG, JPEG) is checked against the **signature of
#     the content**, never against the extension or the sent content type
#     (ADR-0014 Nr. 5). A text file with `;type=image/png` is rejected, and
#     rightly so.
#
# Hence a real, valid PNG (1×1, 70 bytes) instead of a text file with a
# timestamp. The stamp is thereby **no longer in the content** — what the
# checksum proves is the unchanged way back *within this run*, and for that no
# unique content is needed. A PNG with appended text would have been the price
# for that, and a smoke test that uploads broken files is a smoke test one does
# not run against the production installation.
printf '%s' "$ATTACHMENT_BASE64" | base64 -d > "$work/$ATTACHMENT_NAME"
expected_sum="$(sha256sum "$work/$ATTACHMENT_NAME" | cut -d' ' -f1)"
curl "${CURL_OPTS[@]}" -X POST \
  -H 'content-type: application/octet-stream' \
  -H "x-file-name: $ATTACHMENT_NAME" \
  --data-binary "@$work/$ATTACHMENT_NAME" \
  "$BASE/api/public/forms/$slug/files" > "$work/upload.json"
file_ref="$(json '.ref' < "$work/upload.json")"
if [ -n "$file_ref" ]; then
  ok 'die Anlage ist angenommen'
else
  bad "der Upload wurde abgelehnt: $(head -c 200 "$work/upload.json")"
  # Without a reference there is nothing to claim: the submission would fail,
  # the waiting loop of promise 4 would run into the void for a minute, and the
  # checksum would compare an error page. Abort here, where the reason stands.
  die 'ohne angenommene Anlage sind die Zusagen 4 bis 6 nicht prüfbar'
fi

# The name is a **copy** of the stored `file_name`, and the server
# checks it: `claimAttachments` rejects a submission whose name does not match
# the one it measured at upload time.
# ⚠️ **What is checked is the status and the confirmation — not an `"id"`.**
#
# This route answers with the **confirmation document**
# (`confirmationTitle`, `confirmationMessage`, `redirect`, `editUrl`) and has
# never carried an `id`: the identifier of the response is none of the
# participant's business. The old check looked for it anyway — and reported
# „the submission was rejected" while it **printed out** the acceptance along
# with it. A touchstone that looks for a field the contract never had is red in
# the long run and says the opposite of what has happened while doing so.
#
# ⚠️⚠️ **200, not 201 — and that is measured, not guessed.** The route
# carries `@HttpCode(HttpStatus.OK)`; a `POST` otherwise gives 201 in NestJS,
# and exactly this default was what I had put in here. The run said 200, and
# next to the same confirmation document at that. The number no longer stands
# only here: `apps/api/test/public/script-upload-shape.spec.ts` reads it **from
# this line** and holds it against the answer of the shipped route.
submit_status="$(curl "${CURL_OPTS[@]}" -o "$work/response.json" -w '%{http_code}' \
  -X POST -H 'content-type: application/json' \
  -d "{\"answers\":{\"019ff400-0000-7000-8000-0000000000d1\":\"Rauchtest\",\"019ff400-0000-7000-8000-0000000000d2\":{\"files\":[{\"ref\":\"$file_ref\",\"name\":\"$ATTACHMENT_NAME\"}]}}}" \
  "$BASE/api/public/forms/$slug/responses")"
if [ "$submit_status" = '200' ] \
  && [ -n "$(json '.confirmationTitle' < "$work/response.json")" ]; then
  ok 'die Einreichung ist angenommen'
else
  bad "die Einreichung antwortete $submit_status: $(head -c 200 "$work/response.json")"
fi

# ---------------------------------------------------------------------------
step '5/6 Die Mail-Warteschlange arbeitet'
# ⚠️ **What is waited for is `sent`, not „a row exists".** A row
# arises on submission; whether it reaches the mailbox is decided by the
# mail worker — and that one can be switched off via `MAIL_WORKER_INTERVAL_MS`.
# Exactly this case (row there, worker off) looks healthy in every container status.
#
# The deadline is generous: the worker runs at the default rate every 15 seconds,
# and a real SMTP server may take its time.
mail_status=''
for _ in $(seq 1 "${SMOKE_MAIL_ATTEMPTS:-30}"); do
  api GET "/mail-log?formId=$FORM_ID" > "$work/maillog.json"
  mail_status="$(json '.entries?.[0]?.status ?? ""' < "$work/maillog.json")"
  [ "$mail_status" = 'sent' ] && break
  [ "$mail_status" = 'failed' ] && break
  sleep 2
done
case "$mail_status" in
  sent) ok 'die mail_log-Zeile steht auf sent' ;;
  failed) bad 'die mail_log-Zeile steht auf failed — der Mailserver hat abgelehnt' ;;
  queued) bad 'die mail_log-Zeile bleibt auf queued — der Mail-Worker arbeitet nicht' ;;
  '') bad "keine mail_log-Zeile zu diesem Formular: $(head -c 200 "$work/maillog.json")" ;;
  *) bad "unerwarteter Status der mail_log-Zeile: $mail_status" ;;
esac

# ---------------------------------------------------------------------------
step '6/6 Anlage zurück und Export mit gültiger Dateisignatur'
# Fetch the attachment back over the API — **over the checksum**, not over its
# existence. A file of the right size with wrong content is the case that
# „exists" does not see.
if [ -n "$file_ref" ]; then
  curl "${CURL_OPTS[@]}" -b "$work/cookies" -o "$work/zurueck.bin" \
    "$BASE/api/responses/files/$file_ref"
  actual_sum="$(sha256sum "$work/zurueck.bin" | cut -d' ' -f1)"
  if [ "$actual_sum" = "$expected_sum" ]; then
    ok 'die Anlage kommt mit gleicher Prüfsumme zurück'
  else
    bad "die Anlage kam verändert zurück (erwartet ${expected_sum:0:16}…, bekommen ${actual_sum:0:16}…)"
  fi
fi

# ⚠️ **What is checked is the signature of the file, not its status and not
# its content type.** Both can be right while the body is something else —
# the double in `smoke.test.sh` delivers exactly this case.
export_code="$(curl "${CURL_OPTS[@]}" -o "$work/export.xlsx" -w '%{http_code}' \
  -b "$work/cookies" "$BASE/api/forms/$FORM_ID/export.xlsx")"
if [ "$export_code" != '200' ]; then
  bad "der Export antwortete $export_code"
else
  # `PK` (0x50 0x4b) is the beginning of every ZIP container, and an
  # xlsx workbook **is** a ZIP container. A JSON array of the same bytes
  # begins with `{`.
  signature="$(head -c 2 "$work/export.xlsx")"
  size="$(wc -c < "$work/export.xlsx")"
  if [ "$signature" = 'PK' ]; then
    ok "der Export ist eine Arbeitsmappe (Signatur PK, $size Bytes)"
  else
    bad "der Export beginnt mit „$signature“ statt PK — ein Tabellenprogramm öffnet das nicht"
    printf '     Anfang der Datei: %s\n' "$(head -c 80 "$work/export.xlsx")"
  fi
  # And the CSV path, because it is the one most people use: the first line
  # must be a header line and not a JSON bracket.
  csv_first="$(curl "${CURL_OPTS[@]}" -b "$work/cookies" \
    "$BASE/api/forms/$FORM_ID/export.csv" | head -c 1)"
  case "$csv_first" in
    '{' | '[') bad 'der CSV-Export liefert JSON' ;;
    '') bad 'der CSV-Export ist leer' ;;
    *) ok 'der CSV-Export beginnt mit einer Kopfzeile' ;;
  esac
fi

# ---------------------------------------------------------------------------
# ## 7. The schema state (review finding)
#
# ⚠️ **Not checkable is something other than in order.** The question „are
# migrations outstanding?" is answered only by the Prisma CLI, and that one is
# inside the `migrate` image — without `docker compose` there is no answer here,
# and then the smoke test says so instead of silently skipping the promise.
printf '\n== 7. Schemastand ==\n'
schema_unknown() {
  printf '  \033[33m—\033[0m Schemastand **nicht geprüft** (%s)\n' "$1"
  printf '      Auf dem Server nachholen: docker compose run --rm migrate migrate status\n'
}
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  # No `bad`: the smoke test also runs from a machine that only has HTTP
  # to the installation. A promise that would **always** be red there would
  # devalue the whole test.
  schema_unknown 'kein docker compose erreichbar'
else
  migrate_out="$(docker compose run --rm migrate migrate status 2>&1)"
  # ⚠️⚠️ **Three exits, not two — and the third is the expensively learned one.**
  # The first draft read the exit code alone, and that one is ≠ 0 for *both*:
  # „there are migrations outstanding" **and** „I could not ask at all" (no
  # daemon, image missing, database not reachable). In this environment —
  # `docker compose` present, daemon not — it promptly reported an
  # outstanding migration state that nobody had measured. The decision is
  # therefore made on Prisma's **own output**; everything else is „not checked".
  case "$migrate_out" in
    *'Database schema is up to date'*)
      ok 'die Datenbank ist auf dem Stand des Codes' ;;
    *'not yet been applied'* | *'have not yet been applied'* | *'following migration'* | *'Following migration'*)
      bad 'es stehen Migrationen aus — nach einer Wiederherstellung fehlt „docker compose run --rm migrate"' ;;
    *)
      schema_unknown "$(printf '%s' "$migrate_out" | tr '\n' ' ' | cut -c1-80)" ;;
  esac
fi

# ---------------------------------------------------------------------------
printf '\n'
if [ "$failures" -eq 0 ]; then
  printf '\033[32mOK: alle Zusagen gehalten.\033[0m\n'
  exit 0
fi
printf '\033[31m%d Zusage(n) nicht gehalten.\033[0m\n' "$failures"
exit 1
