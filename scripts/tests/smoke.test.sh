#!/usr/bin/env bash
#
# smoke.test.sh — scenarios for scripts/smoke.sh.
#
# **What it is there for.** `smoke.sh` is the promise "this installation does
# what it is there for" — and a smoke test that stays green on a broken
# installation is worse than none: it is believed. The same build as
# `backup.test.sh` and `dev-setup.test.sh`: the script is **run**, against
# a double that breaks itself on command — not read.
#
# **The double is an HTTP server, not a mock-up of the application.** It speaks
# exactly the routes that `smoke.sh` touches, and every fault is a switch:
# readiness off, mail stays in the queue, attachment comes back
# changed, export is JSON. What is **not** checked here is the
# application itself — for that the `stack` job runs the same smoke test against
# the real stack.
#
# ⚠️ **The most important scenario is „Export als JSON".** Once the
# Excel export went out with status 200, the right content type and 34 KB — and
# opened in no spreadsheet program. This scenario runs exactly this case
# **and** the shortened check next to it, so that it stands in black and white
# that „Status 200" stays green where the signature check turns red.
#
# Needs: node (for the double), curl.
#
# Usage: scripts/tests/smoke.test.sh
# Exit: 0 = all scenarios fit, 1 = at least one did not.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE="$ROOT/scripts/smoke.sh"

failures=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

work="$(mktemp -d)"
server_pid=''
stop_double() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
  server_pid=''
}
trap 'stop_double; rm -rf "$work"' EXIT

cat > "$work/double.js" <<'NODE'
// The double: exactly the routes that smoke.sh touches.
//
// `BREAK` switches off one promise each. The addresses and bodies are those of
// the real API — what is not right here shows up in the `stack` job, where the
// same smoke test runs against the real application.
const http = require('node:http');

const BREAK = process.env.BREAK ?? 'none';
const state = { deleted: false, submitted: false, notified: false };
const FORM_ID = '019ff400-0000-7000-8000-00000000abcd';
const SLUG = 'rauchtest-doppel';
const REF = 'file-ref-1';
// The uploaded bytes, as they arrived. A constant here would mean: the
// intact scenario would compare the attachment's checksum with that of anything.
let uploaded = Buffer.alloc(0);

/**
 * ⚠️ **The three conditions of the real upload route** (ADR-0014 Nr. 5, Nr. 14).
 *
 * A double that accepted **every** body under **every** content type and
 * answered with 201 would measure nothing: `smoke.sh` sends `curl -F` with
 * a text file — all three conditions violated —, and a lenient
 * double would let every scenario stay green. The same pattern as with the
 * CSRF token one session earlier: **a double that is more lenient than the
 * original measures the leniency of the double.**
 *
 * 1. `application/octet-stream`, otherwise 415 — a route that does *not* take
 *    multipart is unreachable for a foreign HTML form.
 * 2. `x-file-name`, percent-encoded, otherwise 400.
 * 3. The signature of the **content** in the positive list, otherwise 415 — never
 *    the extension, never the sent content type.
 */
const SIGNATURES = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from('%PDF-', 'ascii'), // PDF
];

function refuseUpload(req, body) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
  if (type !== 'application/octet-stream') {
    return [415, `Der Upload muss als application/octet-stream gesendet werden (war: ${type || 'nichts'}).`];
  }
  if (typeof req.headers['x-file-name'] !== 'string') {
    return [400, 'Der Dateiname fehlt (Kopfzeile x-file-name).'];
  }
  if (!SIGNATURES.some((sig) => body.subarray(0, sig.length).equals(sig))) {
    return [415, 'Dieser Dateityp wird nicht angenommen.'];
  }
  return null;
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));

  if (path === '/api/health/ready') {
    return BREAK === 'ready'
      ? json(res, 503, {})
      : json(res, 200, { status: 'ok' });
  }
  if (path === '/api/health') {
    return json(res, 200, { status: 'ok', version: '9.9.9-doppel' });
  }
  if (path === '/api/auth/login') {
    if (BREAK === 'login') return json(res, 401, {});
    // **Two cookies, like the real application** — session *and* CSRF token.
    // For a long time the double set only the first, and exactly for that reason
    // all scenarios stayed green, while `smoke.sh` against the real stack got a
    // 403 at the first changing route. A double that is looser than the
    // original measures the leniency of the double.
    res.setHeader('set-cookie', [
      'formsache_session=doppel; Path=/; HttpOnly',
      'formsache_csrf=doppel-csrf; Path=/',
    ]);
    return json(res, 200, { id: 'user-1' });
  }
  // ⚠️ **The CSRF guard of the double, and it is the core of this test.**
  //
  // Every changing route of the real application lies behind `CsrfGuard`
  // : the token comes as a cookie and has to come back in the header
  // `x-csrf-token`. The double demands it in just the same way — otherwise it
  // would be more lenient than the original, and the first CI run against a real
  // stack would find what seven green scenarios have not found. Exactly that happened.
  if (
    req.method !== 'GET' &&
    path !== '/api/auth/login' &&
    !path.startsWith('/api/public/')
  ) {
    if (req.headers['x-csrf-token'] !== 'doppel-csrf') {
      state.csrfRefusals = (state.csrfRefusals ?? 0) + 1;
      return json(res, 403, { message: 'csrf' });
    }
  }
  if (path === '/api/forms' && req.method === 'POST') {
    return json(res, 201, { id: FORM_ID, revision: 1, publicSlug: SLUG });
  }
  if (path === `/api/forms/${FORM_ID}` && req.method === 'PUT') {
    return json(res, 200, { id: FORM_ID, revision: 2 });
  }
  if (path === `/api/forms/${FORM_ID}/notifications` && req.method === 'POST') {
    state.notified = true;
    return json(res, 201, { id: 'notification-1', name: 'Rauchtest' });
  }
  if (path === `/api/forms/${FORM_ID}` && req.method === 'DELETE') {
    state.deleted = true;
    return json(res, 200, {});
  }
  if (path === `/api/forms/${FORM_ID}/publish`) {
    return json(res, 200, {
      id: FORM_ID,
      status: BREAK === 'publish' ? 'draft' : 'active',
    });
  }
  if (path === `/api/public/forms/${SLUG}`) {
    return BREAK === 'public'
      ? json(res, 404, {})
      : json(res, 200, { slug: SLUG, locked: false });
  }
  if (path === `/api/public/forms/${SLUG}/files`) {
    return req.on('end', () => {
      const body = Buffer.concat(chunks);
      const refusal = refuseUpload(req, body);
      if (refusal !== null) {
        return json(res, refusal[0], { message: refusal[1] });
      }
      uploaded = body;
      json(res, 201, {
        ref: REF,
        fileName: decodeURIComponent(req.headers['x-file-name']),
        contentType: 'image/png',
        byteSize: body.length,
      });
    });
  }
  if (path === `/api/public/forms/${SLUG}/responses`) {
    state.submitted = true;
    // ⚠️ **The confirmation document, not `{id}`.** This route has never carried
    // an identifier — the response ID is none of the participant's business. A
    // double that handed one out anyway, and a smoke test that searches for
    // exactly that, would agree — "accepted" —, although the real
    // application does not know this field.
    //
    // And **200**, not 201: the route carries `@HttpCode(HttpStatus.OK)`,
    // not the NestJS default 201 for `POST`.
    return json(res, 200, {
      confirmationTitle: 'Vielen Dank!',
      confirmationMessage: 'Die Antwort wurde übermittelt.',
      redirect: null,
      editUrl: null,
    });
  }
  if (path === '/api/mail-log') {
    // ⚠️ **Two conditions, not one.** Without a submission there is no row
    // — otherwise promise 4 would check a row that would exist even without the
    // path leading there. And without a **notification** there is just as
    // little: a submission does not by itself produce a mail, what goes out is a
    // policy on the form (`submission-mail.ts`). A double that were
    // generous here would let exactly that smoke test pass green which on a
    // real installation would never find a row.
    if (!state.submitted || !state.notified) {
      return json(res, 200, { entries: [], counts: {} });
    }
    const status = BREAK === 'mail' ? 'queued' : 'sent';
    return json(res, 200, {
      entries: [{ id: 'mail-1', status, subject: 'Rauchtest' }],
      counts: { total: 1, sent: status === 'sent' ? 1 : 0, failed: 0, queued: status === 'sent' ? 0 : 1 },
    });
  }
  if (path === `/api/responses/files/${REF}`) {
    res.writeHead(200, { 'content-type': 'image/png' });
    // „Verändert zurück" is the case that an existence check does not see:
    // same order of magnitude, different content.
    return res.end(BREAK === 'checksum' ? Buffer.from('etwas anderes\n') : uploaded);
  }
  if (path === `/api/forms/${FORM_ID}/export.xlsx`) {
    // ⚠️ **The fault case that status and content type alone do not show.**
    // 200, the right content type, plausible size — and the body is
    // JSON.
    res.writeHead(200, {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="export.xlsx"',
    });
    if (BREAK === 'export') {
      return res.end(
        JSON.stringify({ type: 'Buffer', data: [80, 75, 3, 4, 20, 0] }),
      );
    }
    // A real ZIP begins with PK\x03\x04 — the signature check needs no more
    // than that, and more would be a rebuilt workbook.
    return res.end(
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(512)]),
    );
  }
  if (path === `/api/forms/${FORM_ID}/export.csv`) {
    res.writeHead(200, { 'content-type': 'text/csv' });
    return res.end(
      BREAK === 'csv' ? '{"rows":[]}' : 'Zuname,Nachweis\nRauchtest,anlage.png\n',
    );
  }
  return json(res, 404, { message: `unbekannt: ${req.method} ${path}` });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});

// The cleanup proof: on termination the double says whether smoke.sh has
// cleared its form away again.
process.on('SIGTERM', () => {
  process.stdout.write(`DELETED=${state.deleted}\n`);
  process.exit(0);
});
NODE

# Starts the double and puts its base address into $BASE.
start_double() {
  local mode="$1"
  stop_double
  : > "$work/double.log"
  BREAK="$mode" node "$work/double.js" > "$work/double.log" 2>&1 &
  server_pid=$!
  for _ in $(seq 1 50); do
    if grep -q '^PORT=' "$work/double.log" 2>/dev/null; then
      BASE="http://127.0.0.1:$(sed -n 's/^PORT=//p' "$work/double.log" | head -n 1)"
      return 0
    fi
    sleep 0.1
  done
  printf 'das Doppel startete nicht: %s\n' "$(cat "$work/double.log")" >&2
  exit 1
}

# Runs smoke.sh against the double; output in $work/out, return value in $code.
run_smoke() {
  # Two attempts instead of thirty: the double answers immediately, and the
  # waiting loop of promise 4 should not lengthen the scenario by a
  # minute.
  SMOKE_MAIL_ATTEMPTS=2 "$SMOKE" "$BASE" > "$work/out" 2>&1
  code=$?
}

printf '\n== Eine heile Installation: alle Zusagen ==\n'
start_double none
run_smoke
if [ "$code" -eq 0 ]; then ok 'smoke.sh meldet Erfolg'; else bad "smoke.sh scheiterte ($code): $(grep '✗' "$work/out" | head -n 2)"; fi
for promise in 'Bereitschaft' 'Anmeldung' 'öffentlich abrufbar' 'mail_log-Zeile steht auf sent' \
  'gleicher Prüfsumme' 'Arbeitsmappe (Signatur PK'; do
  if grep -qF "$promise" "$work/out"; then ok "geprüft: $promise"; else bad "nicht geprüft: $promise"; fi
done
# ⚠️ **Promise 7 is *named* here, not measured.** Without `docker compose`
# the smoke test cannot ask for the schema state — and exactly that it has to
# say, instead of skipping the promise. What is checked here is therefore the
# **honesty** of the case: either a result or a „nicht geprüft" with
# the command to catch up. Silence would be the error (review finding).
if grep -qE 'Stand des Codes|Migrationen aus|nicht geprüft' "$work/out"; then
  ok 'Zusage 7 (Schemastand) sagt, was sie messen konnte'
else
  bad 'Zusage 7 fehlt in der Ausgabe — der Schemastand wird stillschweigend übergangen'
fi
# And it leaves nothing behind — the form is gone again.
stop_double
sleep 0.2
if grep -q '^DELETED=true' "$work/double.log"; then
  ok 'das angelegte Formular wurde wieder abgeräumt'
else
  bad 'smoke.sh ließ sein Formular stehen'
fi

printf '\n== Gegenprobe: das Doppel nimmt die alte Upload-Gestalt nicht mehr an ==\n'
# ⚠️ **Without this section the green run above proves nothing.** It only shows
# that `smoke.sh` and its double agree — even when both
# do the same thing wrong. That was exactly the state: `curl -F` with a
# text file, a double that accepted every body, seven green scenarios and a
# `stack` job that failed at the real route.
#
# What is therefore run is what the double has to **reject** — the three
# conditions of the real route, individually.
start_double none
probe() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$@" \
    "$BASE/api/public/forms/rauchtest-doppel/files"
}
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
  | base64 -d > "$work/anlage.png"
printf 'Klartext, kein Bild.\n' > "$work/anlage.txt"

# 1. The old shape: multipart with a text file. Both wrong.
code_multipart="$(probe -F "file=@$work/anlage.txt;type=text/plain")"
if [ "$code_multipart" = '415' ]; then
  ok "multipart wird abgewiesen ($code_multipart) — die Gestalt, die einmal grün war"
else
  bad "das Doppel nahm multipart an ($code_multipart) — es ist nachsichtiger als die echte Route"
fi

# 2. Right content type, but no file name.
code_noname="$(probe -H 'content-type: application/octet-stream' \
  --data-binary "@$work/anlage.png")"
if [ "$code_noname" = '400' ]; then
  ok "ohne x-file-name wird abgewiesen ($code_noname)"
else
  bad "das Doppel nahm einen Upload ohne Dateinamen an ($code_noname)"
fi

# 3. Everything packaged correctly — and the content is still not a permitted type.
#    That is the condition that an extension or a sent content type
#    does not check: the signature of the content.
code_wrongbytes="$(probe -H 'content-type: application/octet-stream' \
  -H 'x-file-name: anlage.png' --data-binary "@$work/anlage.txt")"
if [ "$code_wrongbytes" = '415' ]; then
  ok "Klartext unter dem Namen anlage.png wird abgewiesen ($code_wrongbytes)"
else
  bad "das Doppel entschied nach der Endung statt nach dem Inhalt ($code_wrongbytes)"
fi

# 4. And the shape that `smoke.sh` runs comes through — otherwise the
#    section above would be green only by accident.
code_good="$(probe -H 'content-type: application/octet-stream' \
  -H 'x-file-name: anlage.png' --data-binary "@$work/anlage.png")"
if [ "$code_good" = '201' ]; then
  ok "rohe PNG-Bytes mit Dateinamen werden angenommen ($code_good)"
else
  bad "das Doppel lehnte die richtige Gestalt ab ($code_good)"
fi
stop_double

printf '\n== Bereitschaft aus: der Lauf bricht sofort ab ==\n'
start_double ready
run_smoke
if [ "$code" -ne 0 ]; then ok "smoke.sh wird rot ($code)"; else bad 'smoke.sh blieb grün, obwohl die Bereitschaft 503 meldet'; fi
if grep -qF '/api/health/ready antwortet 503' "$work/out"; then
  ok 'und sagt, woran es lag'
else
  bad 'die Meldung nennt die Bereitschaft nicht'
fi
# ⚠️ Whoever asked `/api/health` here instead of `/api/health/ready` would get
# 200 and would run merrily on — that is the whole reason for two routes.
if grep -qF 'die Installation läuft auf Fassung' "$work/out"; then
  bad 'smoke.sh lief nach der 503 weiter'
else
  ok 'der Lauf endet vor den übrigen Zusagen'
fi

printf '\n== Der Mail-Worker arbeitet nicht: die Zeile bleibt in der Warteschlange ==\n'
start_double mail
run_smoke
if [ "$code" -ne 0 ]; then ok "smoke.sh wird rot ($code)"; else bad 'eine steckengebliebene Warteschlange blieb unbemerkt'; fi
if grep -qF 'Mail-Worker arbeitet nicht' "$work/out"; then
  ok 'und benennt den Mail-Worker'
else
  bad "die Meldung benennt den Mail-Worker nicht: $(grep '✗' "$work/out" | head -n 1)"
fi

printf '\n== Die Anlage kommt verändert zurück ==\n'
start_double checksum
run_smoke
if [ "$code" -ne 0 ]; then ok "smoke.sh wird rot ($code)"; else bad 'eine veränderte Anlage blieb unbemerkt'; fi
if grep -qF 'verändert zurück' "$work/out"; then
  ok 'und nennt die Prüfsumme'
else
  bad 'die Meldung nennt die Prüfsumme nicht'
fi

printf '\n== Der Export ist JSON — Status 200, Header richtig (der frühere Fund) ==\n'
start_double export
run_smoke
if [ "$code" -ne 0 ]; then
  ok "smoke.sh wird rot ($code)"
else
  bad 'ein JSON-Export unter xlsx-Namen blieb unbemerkt'
fi
if grep -qF 'statt PK' "$work/out"; then
  ok 'und benennt die Dateisignatur'
else
  bad 'die Meldung nennt die Signatur nicht'
fi
# ⚠️ **The counter-check to the trap, executed instead of asserted:** the same
# call, shortened to „Status 200". It stays green — and exactly for that reason
# smoke.sh checks the signature.
shortened="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/forms/019ff400-0000-7000-8000-00000000abcd/export.xlsx")"
if [ "$shortened" = '200' ]; then
  ok "die verkuerzte Pruefung (nur „Status 200“) meldet $shortened — sie bliebe gruen"
else
  bad "die verkürzte Prüfung meldete $shortened, erwartet war 200 — das Szenario stellt den Fund nicht nach"
fi

printf '\n== Der CSV-Export liefert JSON ==\n'
start_double csv
run_smoke
if [ "$code" -ne 0 ]; then ok "smoke.sh wird rot ($code)"; else bad 'ein JSON-CSV blieb unbemerkt'; fi
if grep -qF 'CSV-Export liefert JSON' "$work/out"; then
  ok 'und benennt den CSV-Weg'
else
  bad 'die Meldung benennt den CSV-Weg nicht'
fi

printf '\n== Ohne Basis-Adresse gibt es keinen Lauf ==\n'
if "$SMOKE" > /dev/null 2>&1; then
  bad 'smoke.sh ohne Argument meldete Erfolg'
else
  ok 'smoke.sh ohne Argument bricht ab'
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf '\033[32mOK: alle Szenarien passten.\033[0m\n'
  exit 0
fi
printf '\033[31m%d Szenario(s) fehlgeschlagen.\033[0m\n' "$failures"
exit 1
