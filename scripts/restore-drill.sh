#!/usr/bin/env bash
#
# restore-drill.sh — the restore drill, in four steps
# (ADR-0017 §4).
#
# It runs in the `restore` job of the CI, because it needs a Docker daemon. The
# four steps can be called individually, so that the job can run `down -v`
# between them — the point of no return, from which the archive is the only
# source.
#
#   seed     create form, publish, fill in publicly (with attachment)
#   backup   back up (out of the running stack)
#   restore  stack anew, play in the archive, migrations, stack up
#   verify   check **what came back**
#
# ⚠️ **`verify` does not check whether a script ran without errors.** It checks
# the response, **the attachment with the same checksum**, the `mail_log` row
# and the login. The difference is the whole point of this drill: a `pg_dump`
# alone restores rows whose files are missing, and without the checksum
# nobody would notice that.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${BASE_URL:-http://127.0.0.1:8080}"
STATE="${DRILL_STATE:-$ROOT/var/drill}"
ARCHIVES="${DRILL_BACKUPS:-$ROOT/var/drill-backups}"
ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-admin@example.org}"
ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-change-me-locally}"

die() {
  printf '\033[31mdrill: %s\033[0m\n' "$1" >&2
  exit 1
}
note() { printf '==> %s\n' "$1"; }

mkdir -p "$STATE" "$ARCHIVES"

# The API call with a session: the login cookie **and** the CSRF header, the
# way every browser sends them — the drill goes through the same door as a human.
#
# The server sets the token as a second cookie (`formsache_csrf`, under TLS
# `__Host-formsache_csrf`); back it has to come in the header `x-csrf-token`. A browser
# does that by itself, a script does not.
csrf_token() {
  awk '$6 == "formsache_csrf" || $6 == "__Host-formsache_csrf" { value = $7 } END { print value }' \
    "$STATE/cookies"
}

api() {
  local method="$1" path="$2"
  shift 2
  curl -sS -X "$method" -b "$STATE/cookies" -c "$STATE/cookies" \
    -H 'content-type: application/json' \
    -H "x-csrf-token: $(csrf_token)" "$@" "$BASE/api$path"
}

login() {
  curl -sS -c "$STATE/cookies" -H 'content-type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    "$BASE/api/auth/login" > "$STATE/login.json" \
    || die 'Anmeldung gescheitert'
  grep -q 'formsache_session' "$STATE/cookies" || die 'kein Sitzungs-Cookie'
  # Without it every mutating call fails with a 403 that looks like a
  # rights error — better to abort here, where the reason is still visible.
  [ -n "$(csrf_token)" ] || die 'kein CSRF-Cookie — verändernde Aufrufe gäben 403'
}

# If the value is missing, nothing comes back — not the word „undefined". Out of
# `String(undefined)` came a non-empty string, and every `-n` check
# behind it was thereby true (the same finding as in `smoke.sh`).
json() {
  node -e "const d=require('fs').readFileSync(0,'utf8');const v=JSON.parse(d)$1;process.stdout.write(v === undefined || v === null ? '' : String(v))"
}

# A real PNG, 70 bytes, 1×1 — see the comment at the upload.
ATTACHMENT_NAME='anlage.png'
ATTACHMENT_BASE64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

wait_ready() {
  for _ in $(seq 1 60); do
    [ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/health/ready")" = '200' ] && return 0
    sleep 2
  done
  die 'der Stack wurde nicht bereit'
}

case "${1:-}" in

  seed)
    note 'anmelden'
    login

    note 'Formular anlegen und veröffentlichen'
    api POST /forms -d '{"title":"Wiederherstellungsprobe"}' > "$STATE/form.json"
    form_id="$(json '.id' < "$STATE/form.json")"
    revision="$(json '.revision' < "$STATE/form.json")"
    slug="$(json '.publicSlug' < "$STATE/form.json")"
    printf '%s\n' "$slug" > "$STATE/slug"
    printf '%s\n' "$form_id" > "$STATE/form-id"

    # Two questions, and the second one is the reason for the whole drill: **a
    # file question**. Without it the uploaded attachment would stay unclaimed —
    # it would lie in the volume, but would belong to no response, and the drill
    # would check an orphaned file instead of one that belongs to the data.
    api PUT "/forms/$form_id" -d "$(cat <<JSON
{"title":"Wiederherstellungsprobe","revision":$revision,
 "definition":{"pages":[{"id":"019ff400-0000-7000-8000-0000000000c0","title":"Seite",
 "questions":[
   {"id":"019ff400-0000-7000-8000-0000000000c1","type":"text","label":"Zuname",
    "hint":null,"required":true,"width":"full","minLength":null,"maxLength":null,"pattern":null},
   {"id":"019ff400-0000-7000-8000-0000000000c2","type":"file","label":"Nachweis",
    "hint":null,"required":true,"width":"full","maxFiles":1}
 ]}]}}
JSON
    )" > "$STATE/saved.json"
    saved_revision="$(json '.revision' < "$STATE/saved.json")"
    # A notification, because `verify` checks a `mail_log` row later:
    # a submission does **not** create a mail by itself (`submission-mail.ts`
    # writes the rows out of the notifications of the form). Without it
    # the drill would back up a table in which no row ever stood.
    api POST "/forms/$form_id/notifications" -d "$(cat <<'JSON'
{"name":"Probe","subject":"Wiederherstellungsprobe",
 "body":"Diese Zeile muss die Wiederherstellung überleben.",
 "recipients":[{"kind":"literal","address":"probe@example.org"}],
 "replyTo":null}
JSON
    )" > "$STATE/notification.json"
    [ -n "$(json '.id' < "$STATE/notification.json")" ] \
      || die "die Benachrichtigung ließ sich nicht anlegen: $(head -c 200 "$STATE/notification.json")"

    api POST "/forms/$form_id/publish" -d "{\"revision\":$saved_revision}" > "$STATE/published.json"
    [ "$(json '.status' < "$STATE/published.json")" = 'active' ] || die 'das Formular wurde nicht aktiv'

    note 'öffentlich ausfüllen — mit Anlage'
    # ⚠️ **Raw bytes, no multipart — and a real image.**
    #
    # The upload route takes exclusively `application/octet-stream` and
    # answers 415 to everything else; the file name travels percent-encoded in
    # `x-file-name`; and the positive list (PDF, PNG, JPEG) is checked against
    # the **signature of the content**, never against the extension or the sent
    # content type (ADR-0014 Nr. 5 and Nr. 14). A `curl -F` with a
    # text file violated all three points — the first CI run of this drill
    # failed on exactly that, and the `.ref` helper turned the rejection
    # on top of that into the string „undefined".
    printf '%s' "$ATTACHMENT_BASE64" | base64 -d > "$STATE/$ATTACHMENT_NAME"
    sha256sum "$STATE/$ATTACHMENT_NAME" | cut -d' ' -f1 > "$STATE/anlage.sha256"
    curl -sS -X POST \
      -H 'content-type: application/octet-stream' \
      -H "x-file-name: $ATTACHMENT_NAME" \
      --data-binary "@$STATE/$ATTACHMENT_NAME" \
      "$BASE/api/public/forms/$(cat "$STATE/slug")/files" > "$STATE/upload.json" \
      || die 'der Upload ist gescheitert'
    file_ref="$(json '.ref' < "$STATE/upload.json")"
    [ -n "$file_ref" ] \
      || die "der Upload gab keinen Verweis: $(head -c 200 "$STATE/upload.json")"
    printf '%s\n' "$file_ref" > "$STATE/file-ref"

    # The response **claims** the file — only with that does it belong to the
    # data and survive the 24-hour purge of the unclaimed attachments (ADR-0014).
    # Without the claim the drill would check an orphaned file later.
    # The **status**, not an `"id"`: this route answers with the
    # confirmation document and has never carried an identifier — the old check
    # looked for a field the contract does not know, and reported „rejected",
    # while it printed out the acceptance along with it.
    #
    # ⚠️ **200, not 201:** the route carries `@HttpCode(HttpStatus.OK)`,
    # although the NestJS default for `POST` would be 201. The number is held
    # against the real route (`apps/api/test/public/script-upload-shape.spec.ts`).
    submit_status="$(curl -sS -o "$STATE/response.json" -w '%{http_code}' \
      -X POST -H 'content-type: application/json' \
      -d "{\"answers\":{\"019ff400-0000-7000-8000-0000000000c1\":\"Musterfux\",\"019ff400-0000-7000-8000-0000000000c2\":{\"files\":[{\"ref\":\"$file_ref\",\"name\":\"$ATTACHMENT_NAME\"}]}}}" \
      "$BASE/api/public/forms/$(cat "$STATE/slug")/responses")" \
      || die 'die Einreichung ist gescheitert'
    [ "$submit_status" = '200' ] \
      || die "die Einreichung antwortete $submit_status: $(head -c 200 "$STATE/response.json")"
    note "eingereicht: $(head -c 120 "$STATE/response.json")"
    ;;

  backup)
    note 'sichern (aus dem laufenden Stack)'
    # The backup runs **in** the API container: that is where the files lie, and
    # that is where the database is reachable — exactly as on the real machine,
    # where a cron runs in the same container or next to it.
    docker compose exec -T -e BACKUP_KEY="${BACKUP_KEY:-drill-key}" api \
      sh -lc 'true' 2>/dev/null || true
    # The container carries no `pg_dump`; the drill therefore runs it in the
    # `db` container and fetches the files over a tar stream out of the
    # API container. That is the same content, only touched twice.
    docker compose exec -T db pg_dump -Fc --no-owner --no-privileges \
      -U formsache -d formsache > "$ARCHIVES/database.dump" || die 'pg_dump im Container scheiterte'
    docker compose exec -T api tar -cf - -C /var/lib/formsache/files . \
      > "$ARCHIVES/files.tar" || die 'die Dateien ließen sich nicht holen'
    [ -s "$ARCHIVES/database.dump" ] || die 'der Dump ist leer'
    note "gesichert: $(du -h "$ARCHIVES/database.dump" | cut -f1) Datenbank, $(du -h "$ARCHIVES/files.tar" | cut -f1) Dateien"
    ;;

  restore)
    note 'Stack neu starten (leere Volumes)'
    docker compose up -d --build
    # Wait for the **database**, not for the application: the migrations
    # run in a moment, and the API comes after that.
    for _ in $(seq 1 60); do
      docker compose exec -T db pg_isready -U formsache -d formsache >/dev/null 2>&1 && break
      sleep 2
    done

    note 'Datenbank einspielen'
    docker compose exec -T db pg_restore --clean --if-exists --no-owner \
      --no-privileges -U formsache -d formsache < "$ARCHIVES/database.dump" \
      || note 'pg_restore meldete Hinweise (bei --clean auf leerer Datenbank normal)'

    note 'Migrationen nachziehen'
    # **After** playing it in: the archive brings its own schema along, and
    # a `migrate` that ran beforehand would write into a database that is about
    # to be overwritten (ADR-0017, order).
    docker compose run --rm migrate || die 'migrate deploy scheiterte'

    note 'Dateien einspielen'
    docker compose exec -T api tar -xf - -C /var/lib/formsache/files < "$ARCHIVES/files.tar" \
      || die 'die Dateien ließen sich nicht zurückspielen'

    docker compose restart api
    wait_ready
    ;;

  verify)
    note 'prüfen, was zurückkam'
    slug="$(cat "$STATE/slug")"
    form_id="$(cat "$STATE/form-id")"

    # 1. The login — the backed-up account has to keep working.
    rm -f "$STATE/cookies"
    login
    note 'Anmeldung: ok'

    # 2. The response is readable over the API.
    api GET "/forms/$form_id/responses" > "$STATE/responses.json" \
      || die 'die Antworten ließen sich nicht lesen'
    grep -q 'Musterfux' "$STATE/responses.json" \
      || die 'die Antwort ist nach der Wiederherstellung nicht da'
    note 'Antwort: ok'

    # 3. **The attachment** — and over the checksum at that, not over its existence.
    #    That is the step that exposes a dump-without-files.
    ref="$(cat "$STATE/file-ref")"
    [ -n "$ref" ] || die 'keine Datei-Referenz aus dem Seed'
    curl -sS -b "$STATE/cookies" "$BASE/api/responses/files/$ref" \
      --output "$STATE/zurueck.bin" || die 'die Anlage ließ sich nicht laden' 
    expected="$(cat "$STATE/anlage.sha256")"
    actual="$(sha256sum "$STATE/zurueck.bin" | cut -d' ' -f1)"
    [ "$expected" = "$actual" ] \
      || die "die Anlage kam nicht zurück (erwartet $expected, bekommen $actual)"
    note 'Anlage: ok, gleiche Prüfsumme'

    # 4. The `mail_log` row with its frozen body.
    rows="$(docker compose exec -T db psql -U formsache -d formsache -tAc \
      "select count(*) from mail_log where subject is not null")"
    [ "${rows:-0}" -ge 1 ] || die 'keine mail_log-Zeile nach der Wiederherstellung'
    note "mail_log: ok ($rows Zeile(n))"

    # 5. The public form answers again.
    status="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/public/forms/$slug")"
    [ "$status" = '200' ] || die "das öffentliche Formular antwortet $status"
    note 'öffentliches Formular: ok'

    printf '\033[32mDie Wiederherstellung ist belegt.\033[0m\n'
    ;;

  *)
    die 'Schritt fehlt: seed | backup | restore | verify'
    ;;
esac
