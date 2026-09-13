# 5. Auth: Session-Cookies, lokale Nutzer (Argon2id), Standard-OIDC je Tenant

- **Status:** accepted
- **Date:** 2026-07-26

## Context

Nur Bearbeiter/Admins melden sich an — Teilnehmer füllen Formulare **ohne
Login** aus. Tenants konfigurieren ihren eigenen Identity-Provider (etwa
Keycloak); daneben gibt es lokale Nutzer mit E-Mail + Passwort. Die Applikation soll IdP-agnostisch bleiben.

## Decision

- **Sessions über httpOnly-Cookies** (SameSite=Lax) statt Token im Client.
- **Lokale Nutzer** mit **Argon2id**-Passwort-Hashing.
- **OIDC via `openid-client`** mit Discovery; Issuer/Client-ID/Secret werden
  **je Tenant** konfiguriert (Secrets verschlüsselt in der DB). Kein
  Keycloak-spezifischer Code — reines Standard-OIDC.
- Öffentliche Ausfüll-Endpunkte bleiben anonym; Schutz über optionales
  Formular-Passwort, Rate-Limiting und die Einstellungs-Limits.

## Consequences

- Jeder Standard-OIDC-Provider funktioniert; lokale Nutzer sind der Fallback
  für Tenants ohne IdP.
- Serverseitige Sessions vereinfachen Logout/Invalidierung und CSRF-Schutz
  (klassisches Cookie-Modell + CSRF-Token für mutierende Routen).
- Verschlüsselte Client-Secrets erfordern ein Schlüsselmanagement über
  Umgebungsvariablen (dokumentiert in `.env.example`).

## Fortschreibung 2026-09-05: `Secure` ist eine eigene Entscheidung (Review-Runde 5 Nr. 5)

Die Entscheidung oben sagt „Sessions über httpOnly-Cookies (SameSite=Lax)" und
ließ offen, woran `Secure` hängt. Gehangen hat es an `NODE_ENV`, und
`docker-compose.prod.yml` verdrahtet `NODE_ENV: production` fest. Damit trug das
Sitzungs-Cookie in jeder Produktivgestalt `Secure` und den Namen
`__Host-formsache_session` — auch dort, wo kein TLS davor steht.

**Der Befund:** *„auf lokalem System geht die Anmeldung nur mit localhost. Wenn
ich die IP verwende oder von extern komme geht es nicht."* Ein Browser nimmt ein
`Secure`-Cookie über `http://localhost` an (Loopback gilt als sicherer Kontext)
und verwirft es über `http://192.168.1.10` wortlos. Die Anmeldung antwortet 200,
das Cookie kommt nie an, jede weitere Anfrage ist anonym. Nichts schlägt fehl,
nichts warnt — und der Weg zur Ursache war verschlossen, weil sie an einer
Variablen hing, die fünf andere Dinge zugleich bedeutet.

**Entscheidung:** `SESSION_COOKIE_SECURE` (`apiEnvSchema`) entscheidet
ausdrücklich; `NODE_ENV === 'production'` ist nur noch die **Vorgabe**. Die
Vorgabe wird in `usesSecureCookies()` aufgelöst und nicht im Schema, weil die
Testanwendung ihr `ApiEnv` als Literal baut und das Schema nie durchläuft — eine
im Schema aufgelöste Vorgabe hätte für den Server gegolten und für die Suiten
nicht. Schreiber (Login, OIDC-Login, Logout) und Leser (`SessionGuard`,
`CsrfGuard`) gehen weiter durch diese eine Funktion; liefen sie auseinander,
setzte die Anmeldung `__Host-formsache_session`, während der Wächter
`formsache_session` sucht, und jede Anfrage danach käme mit 401 zurück.

`z.stringbool()` und nicht `z.coerce.boolean()`: Coercion hätte die Zeichenkette
`"false"` zu `true` gemacht — genau der eine Wert, den ein Betreiber hier je
schreibt.

**Der Preis, ausdrücklich getragen:** ohne `Secure` fällt der `__Host-`-Präfix
weg und mit ihm der einzige Schutz gegen Cookie-Tossing durch eine
Nachbardomain. `false` ist damit **nur** für einen Betrieb ohne TLS im eigenen
Netz vertretbar, niemals für eine öffentlich erreichbare Installation. Weil diese
Wahl nichts rot macht, meldet die API die geltende Fassung beim Start — und
`production` ohne `Secure` als **Warnung**, nicht als gewöhnliche Zeile.

Ein Wechsel des Wertes wechselt den Cookie-Namen: alle offenen Sitzungen sind
danach abgemeldet. Das ist eine richtige Zwangsabmeldung, kein Fehler.

⚠️ **Die SSO-Anmeldung hängt zusätzlich an der Basis-Adresse.** `redirect_uri`
und der Rückweg in die Anwendung entstehen ausschließlich aus der
**Basis-Adresse** der Systemeinstellungen (`PublicUrlService`), nie aus der
Aufruf-Adresse: eine geratene Herkunft wäre dort ein offener Weiterleiter. Wer
über eine IP-Adresse arbeitet, trägt deshalb genau diese Adresse als
Basis-Adresse ein; ob der Anmeldedienst eine `http`-`redirect_uri` annimmt,
entscheidet er selbst.
Betriebsanleitung: `docs/kb/09-betrieb.md`, Abschnitt „Betrieb ohne TLS", und
`docs/kb/04-build-run.md`, „Von einem anderen Gerät im Netz zugreifen".
