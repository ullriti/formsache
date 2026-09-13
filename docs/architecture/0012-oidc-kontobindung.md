# 12. OIDC-Kontobindung an *(Issuer, Subject)* — nie an das Subject allein

- **Status:** accepted
- **Date:** 2026-07-30

## Context

[ADR-0005](0005-auth-sessions-oidc.md) entscheidet, **dass** es OIDC gibt: Sessions
über httpOnly-Cookies, lokale Nutzer mit Argon2id, Standard-OIDC mit Discovery,
Konfiguration **je Organisation**, Client-Secrets verschlüsselt in der Datenbank. Was er
nicht sagt, ist, **woran ein Konto hängt**. Genau das ist in einer
mandantenfähigen Anwendung die Entscheidung mit der größten Reichweite, und sie
fällt vor dem Bau des Anmeldewegs an (Punkt 3), nicht danach: der Anmeldeweg baut auf diesem
Schlüssel auf, und ein Schlüssel, der erst danach geändert wird, ist eine Datenmigration über echte Konten.

Der Rahmen ist ungewöhnlich und macht die Frage scharf: **jede Organisation konfiguriert
ihren eigenen Identity-Provider.** Es gibt keine gemeinsame Vertrauensquelle,
gegen die alle prüfen, sondern so viele Vertrauensquellen wie Organisationen — und eine Organisation darf ihren IdP eintragen, ohne dass eine andere Organisation oder der Betreiber
zustimmt. Wer in diesem Aufbau an das falsche Feld bindet, hat keine Lücke
gebaut, sondern einen **Generalschlüssel** verteilt.

Der Datenbank-Boden liegt: `user` trägt `@@unique([oidcIssuer, oidcSubject])`.
Was fehlte, war die Anwendung, die ihn benutzt — und die niedergeschriebene
Begründung, warum die bequemere Variante ausscheidet.

## Decision

### 1. Der Schlüssel ist das Paar *(Issuer, Subject)*

Ein OIDC-Konto wird ausschließlich über **beide** Werte gefunden und angelegt:
den `iss`-Wert des ID-Tokens und den `sub`-Anspruch darin. Es gibt keinen
Lesepfad und keinen Schreibpfad, der `sub` allein als Schlüssel benutzt — auch
keinen „Fallback", wenn das Paar nichts findet.

**Warum `sub` allein ein Generalschlüssel wäre.** Ein `sub` ist laut OpenID
Connect Core **nur innerhalb seines Issuers** eindeutig; er ist „locally
unique". Über Issuer hinweg ist er eine beliebige Zeichenfolge, und sie ist bei
verbreiteten Providern weder unvorhersehbar noch geheim: Keycloak vergibt UUIDs,
andere vergeben laufende Nummern, wieder andere die E-Mail-Adresse oder den
Benutzernamen. Bindet die Anwendung an `sub` allein, gilt:

> Wer bei **seinem eigenen** IdP ein Konto mit dem `sub` eines fremden
> Mitglieds anlegt, **wird** dieser Mitglied.

Das ist kein Angriff von außen, sondern die normale Bedienung des eigenen
Providers — und der eigene Provider ist genau das, was jede Organisation in dieser
Anwendung selbst einträgt. Der Aufwand für den Angriff ist „ein Nutzer im
eigenen Keycloak mit gesetzter `sub`". Er trifft nicht eine Berechtigung, sondern
die **Identität**: die Sitzung gehört danach der fremden Person, mit deren
Mitgliedschaften, deren Organisationen und gegebenenfalls deren `is_superadmin`.

Zwei Varianten wurden erwogen und verworfen:

1. **`sub` allein.** Siehe oben. Sie ist auch nicht „für eine Installation mit
   einem IdP ausreichend": die Anwendung ist ausdrücklich mehr-IdP, und eine
   Bindung, die erst beim zweiten Organisation falsch wird, wird beim zweiten Organisation still
   falsch.
2. **E-Mail als Schlüssel.** Bequem, weil die Einladung ohnehin über eine
   E-Mail-Adresse läuft — und schlechter als `sub` allein. Die E-Mail steht in
   `email`, der Provider entscheidet, ob `email_verified` stimmt, und eine Organisation,
   der seinen IdP selbst betreibt, kann jede beliebige Adresse behaupten. Sie ist
   außerdem **veränderlich**: eine wiederverwendete Adresse würde ein Konto
   übernehmen. E-Mail bleibt Anzeige- und Zuordnungshilfe beim *Einladen*, nie
   Anmeldeschlüssel.

### 2. Der Issuer ist der **konfigurierte**, nicht der behauptete

Der `iss`-Wert aus dem ID-Token wird gegen den Issuer der Organisation geprüft, in den
angemeldet wird; stimmen sie nicht überein, ist die Anmeldung abgelehnt. Der
Schlüssel wird aus dem geprüften Wert gebildet.

Ohne diese Prüfung wäre Nr. 1 wirkungslos: ein Token, das seinen eigenen Issuer
mitbringt, macht das Paar wieder zu einer Angabe des Absenders.

**Verglichen werden beide Seiten in Normalform** (`new URL(x).href`), und das ist
kein Detail: `acceptableIssuer` entfernt beim Speichern abschließende
Schrägstriche, das ID-Token trägt den Bezeichner dagegen **wörtlich**. Bei einem
Provider mit Wurzel-Issuer — Auth0, Okta, Entra: `https://…/` — unterscheiden
sich die beiden Werte damit um genau ein Zeichen, und ein `!==` lehnte *jede*
Anmeldung einer Organisation ab, dessen Discovery gerade erfolgreich war. Das ist zwar
*fail closed* und damit still, aber der Reparaturdruck landete ausgerechnet auf
der Prüfung, die ganze Bindung trägt — der falscheste Ort für Druck.
`openid-client` normalisiert bei der Discovery mit demselben `.href`; die
Anwendung tut es jetzt auch. Ein `iss`, der kein String oder keine URL ist, gilt
als **ungleich**: die Ablehnung ist die Antwort, nie eine Ausnahme.

Die Discovery-Basis, gegen die geprüft wird, ist serverseitig normalisiert und
wird nur als `https` (oder `http` auf Loopback für den lokalen Test-IdP)
akzeptiert —
`apps/api/src/tenant-admin/oidc-issuer.ts`, geprüft **beim Speichern und beim
Ausliefern** (dieselbe Bauform wie die Farbprüfung aus der Anforderung). Zod's
`z.url()` allein genügt dafür nicht: es akzeptiert `javascript:`, `ftp:` und
Anmeldedaten in der Adresse.

### 3. Der erste Login mit einer bereits vorhandenen E-Mail

Nr. 1 sagt, **woran** gebunden wird. Sie sagt noch nicht, **wann** die Bindung
entsteht — und genau dort sitzt das eigentliche Übernahme-Risiko dieser
Entscheidung.

Der Anlass: `tenantMemberCreateSchema` trägt in seiner `oidc`-Variante
`email`, `name` und `groupId` — **keinen Issuer und kein Subject**. Ein OIDC-Konto wird beim Anlegen also über die **E-Mail-Adresse** benannt,
und das Paar *(Issuer, Subject)* kann erst beim ersten Login bekannt werden. Was
in diesem Moment mit einer Adresse geschieht, die es schon gibt, ist eine
Entscheidung und darf nicht als Selbstverständlichkeit im Anmeldecode landen.
`email` ist in diesem Projekt **installationsweit** eindeutig (`user.email
@unique`), die betroffene Person kann also in einer ganz anderen Organisation sitzen.

Vier Möglichkeiten, vollständig:

| | Verhalten beim ersten Login mit bekannter E-Mail | Bewertung |
|---|---|---|
| **(a)** | **Verknüpfen** — die vorhandene Zeile bekommt Issuer und Subject | **Verworfen.** Wer irgendeinen konfigurierten IdP betreibt, könnte jede Adresse der Installation beanspruchen — auch die eines **lokalen** Kontos, auch die eines Superadmins. Das ist derselbe Generalschlüssel wie `sub` allein, nur ein Feld weiter. |
| **(b)** | **Ablehnen** | Sicher, aber als *einzige* Regel wäre die `oidc`-Variante von `tenantMemberCreateSchema` tot: eine eingeladene Person käme nie herein. |
| **(c)** | **Zweites Konto anlegen** | **Verworfen.** `user.email` ist `@unique`, der Insert scheitert; und selbst ohne diesen Index entstünde jemand, der angemeldet ist, in keiner Organisation Mitglied ist (Nr. 5) und dessen Einladung unberührt danebenliegt — ein Zustand, den niemand erklären kann. |
| **(d)** | **Verknüpfen nur nach ausdrücklicher Bestätigung durch `can_manage_users`** | **Gewählt.** |

**Gewählt ist (d), und die Bestätigung ist die Einladung selbst** — vorab
erteilt, an *einen* Organisation und *einen* Issuer gebunden. Wo keine Einladung
vorliegt, gilt **(b)**: abgelehnt. Es gibt keinen dritten Ausgang.

Die Regel beim Login, in dieser Reihenfolge:

1. Nachschlagen über *(iss, sub)*. Treffer ⇒ das ist die Person. **Die E-Mail
   wird dabei nie befragt** — Nr. 1 gilt unverändert.
2. Kein Treffer ⇒ genau **eine** Zeile suchen mit
   `oidc_issuer = iss AND oidc_subject IS NULL AND password_hash IS NULL AND
   email = <verifizierte E-Mail des ID-Tokens>`. Treffer ⇒ die Einladung wird
   eingelöst, das Subject wird gesetzt.
3. Sonst ⇒ **abgelehnt**, mit einer Meldung, die kein Konto benennt: „keine
   Einladung" und „die Adresse gehört einem lokalen Konto" müssen sich gleich
   lesen, sonst ist der Login ein Verzeichnis der Installation.

Beide Randbedingungen sind damit eingehalten. `@@unique([oidcIssuer, oidcSubject])`
bleibt unangetastet und ist der Boden unter Schritt 2: zwei gleichzeitige
Einlösungen verlieren am Index, nicht an einer Prüfung davor. Und **ein IdP
entscheidet nie über ein lokales Konto**, weil `password_hash IS NULL` Teil der
Bedingung ist — eine Zeile mit Passwort ist von keinem Provider aus erreichbar.

### 3a. Die Einlösungsbedingung trägt die **Organisation**, nicht nur den Issuer

Naheliegend wäre: „Der IdP von Organisation B erreicht die Einladung von
Organisation A nicht — der Issuer wird aus der Konfiguration der **einladenden**
Organisation gestempelt." Das stimmt nur unter einer Annahme, die **nirgends
erzwungen ist**: dass zwei Organisationen nie denselben Issuer eintragen.
`tenant.oidc_issuer` hat keinen Eindeutigkeits-Index, und eine **naheliegende**
Betriebsform macht die Annahme falsch — eine gemeinsame Keycloak-Realm mit
**einem Client je Organisation**: ein Issuer, viele Organisationen. Dann steht in jeder Einladung
derselbe Stempel, und die Bedingung trennt niemanden mehr.

Vier Möglichkeiten, vollständig:

| | Ansatz | Bewertung |
|---|---|---|
| **(a)** | **Eindeutigkeit auf `tenant.oidc_issuer` erzwingen** (partieller Unique-Index) | **Verworfen.** Macht die Annahme zwar zur Datenbanktatsache, verbietet dafür genau die Betriebsform, die ein Betreiber am ehesten wählt, und zwar mit einer Fehlermeldung beim Konfigurieren, die der zweiten Organisation erklären müsste, warum der gemeinsame IdP „schon vergeben" ist. Kostet außerdem Migration **und** eine Änderung in `tenant-admin/**`. |
| **(b)** | **Die Organisation in die Einlösungsbedingung aufnehmen** — eingelöst wird nur, wenn die Zeile eine Mitgliedschaft im Organisation hat, in den man sich gerade anmeldet | **Gewählt.** |
| **(c)** | **Die Einladung an den Client statt an den Issuer binden** (`oidc_client_id` mitstempeln) | **Verworfen.** Trägt fachlich dasselbe wie (b) — der Client ist je Organisation verschieden, und `aud` wird ohnehin geprüft —, kostet aber eine neue Spalte samt Migration, und der Client-Wechsel einer Organisation entwertete dann zusätzlich alle offenen Einladungen. Eine zweite Wahrheit über „welcher Organisation" neben der, die es schon gibt. |
| **(d)** | **Als benannte Annahme ins Bedrohungsmodell** („Organisationen teilen keine Issuer") | **Verworfen.** Eine Annahme, die Anwendung selbst nicht prüft, deren Verletzung nichts anzeigt und deren Folge eine Organisation ist, der sich die eingeladene Person einer anderen Organisation holt. Genau die Sorte Zusage, die dieser ADR sonst überall ablehnt. |

**Gewählt ist (b).** Die Bedingung aus Nr. 3 Schritt 2 trägt eine fünfte
Konjunktion: die Zeile muss eine `membership` in der **Organisation der Anmeldung** haben.
Die Organisation kommt dabei aus dem Transaktions-Cookie (Nr. 8), nie aus einem Token.

Das ist billig, weil die Auskunft schon existiert: `createOidcInvitation`
schreibt Einladung **und** Mitgliedschaft in *einer* Transaktion
(`tenant-scope.ts`), es gibt also keine Einladung ohne Organisation. Keine Migration,
keine Spalte, keine Änderung außerhalb von `apps/api/src/auth/**`.

**Der Preis, zweimal.** Erstens: nimmt eine Organisation die Mitgliedschaft einer noch
nicht eingelösten Einladung zurück, ist die Einladung tot — die Zeile bleibt
liegen und belegt die installationsweit eindeutige Adresse (Nr. 4). Das ist die
richtige Richtung (die Organisation hat die Einladung zurückgezogen), aber die
Oberfläche muss die Zeile aufräumen können. Zweitens: eine Person, die von zwei
Organisationen auf **derselben** Adresse eingeladen wäre, gibt es nicht — `user.email`
ist eindeutig, es gibt genau eine Einladung, und sie wird bei der Organisation
eingelöst, der sie ausgestellt hat.

**Nachstellung:** zwei Organisationen am *selben* Issuer, Einladung bei Organisation A, Anmeldung
über Organisation B — muss `abgelehnt` sein und die Einladung unberührt lassen
(`test/auth/oidc-login.spec.ts`, „does not let a second organisation on the same issuer
redeem the invitation"). Ohne die fünfte Bedingung ist der Test rot.

**Was das an der Datenbank kostet, und es ist nicht nichts.** Eine
unbeanspruchte Einladung ist eine `user`-Zeile mit Issuer, **ohne** Subject und
ohne Passwort. Heute verbieten das zwei `CHECK`-Bedingungen:
`user_has_credentials` (`password_hash IS NOT NULL OR oidc_subject IS NOT NULL`)
und `user_oidc_identity_complete` (`(oidc_issuer IS NULL) = (oidc_subject IS
NULL)`). Beide müssen additiv gelockert werden — „Passwort **oder** Subject
**oder** Issuer" und „Subject gesetzt ⇒ Issuer gesetzt" —, und das ist eine
Migration, zusammen mit der Route, die Zeile anlegt. Ohne
sie ist die `oidc`-Variante des Anlege-Schemas nicht ausführbar; das ist der
Befund, der diese Entscheidung ausgelöst hat, und er darf nicht erst im
Anmeldecode auffallen.

### 4. Ein Konto ist eine Person, eine Mitgliedschaft ist die Zugehörigkeit

Aus Nr. 1 folgt: ein Konto trägt **höchstens eine** OIDC-Identität. Die
Zugehörigkeit zu mehreren Organisationen ist Sache der `membership`-Zeilen,
nicht Sache einer zweiten Identität auf derselben Zeile.

Fachlich folgte daraus eigentlich weiter: dieselbe natürliche Person, die bei
**zwei** Organisationen mit **zwei** IdPs arbeitet, bräuchte **zwei** `user`-Zeilen — die
beiden Zeilen wären zwei unabhängige Identitätsbehauptungen zweier unabhängiger
Vertrauensquellen, und sie zusammenzuführen hieße, dem einen IdP zu erlauben, für
eine Identität zu bürgen, die der andere ausgestellt hat.

**Das ist heute nicht baubar, und dieser ADR behauptet es deshalb nicht:**
`user.email` ist installationsweit `@unique`, die zweite Zeile scheitert am
Index. Bis auf Weiteres gilt daher: eine Adresse, eine Zeile, **ein** IdP — wer
in einer zweiten Organisation mit einem anderen IdP arbeiten soll, arbeitet dort mit
einem lokalen Konto oder unter einer zweiten Adresse. Der Nebeneffekt derselben
Eindeutigkeit: eine unbeanspruchte Einladung belegt die Adresse für die ganze
Installation. Beides ist ein **offener Punkt** (E-Mail je Identität statt
je Installation) und ausdrücklich keine stillschweigende Annahme.

### 5. Anmelden verleiht keine Rechte — und ohne Mitgliedschaft **keine Sitzung**

Eine erfolgreiche OIDC-Anmeldung erzeugt **keine Mitgliedschaft**. Wer in keiner Organisation Mitglied ist, kommt an keine fachlichen Daten: die Guard-Kette bleibt
Tenant-Scope → Gruppenrechte → Formular-Restriktion, und der Tenant-Scope
entsteht aus einer Mitgliedschaft, die jemand mit `can_manage_users` vergeben
hat.

*(Der erste Satz dieses Abschnitts lautete bis zu einem Review
„erzeugt eine Sitzung und keine Mitgliedschaft". Gebaut ist etwas anderes, und
**der Code hat recht** — das Sicherheits-Review bestätigt es ausdrücklich; der
ADR wird nachgezogen, nicht die Anwendung.)*

Wer in **keinem** Organisation Mitglied ist, bekommt **gar keine Sitzung**. Eine Sitzung
ohne Mitgliedschaft wäre ein authentifizierter Principal, den niemand autorisiert
hat: ein Cookie, das die Guard-Kette durchläuft, überall am Tenant-Scope
scheitert — und damit eine Angriffsfläche, die keinem Zweck dient. Sie wäre
zudem eine leere Hülle: eine Kopfzeile ohne Organisation und ohne Erklärung. Stattdessen
antwortet der Callback mit dem Ausgang `ohne-Organisation`, die Anmeldeseite sagt in
einem Satz, was zu tun ist, und es wird **kein** Sitzungs-Cookie gesetzt
(`OidcLoginService.finish`).

**Die eine Ausnahme ist der Superadmin**, und sie ist keine Bequemlichkeit: die
installationsweiten Routen (`/api/admin/**`) sind ohne Organisation
erreichbar und *sollen* es sein — ein Superadmin ohne Mitgliedschaft ist der
Normalfall, nicht der Sonderfall. `is_superadmin` steht auf der `user`-Zeile und
wird von keiner Gruppe und keinem Provider vergeben; die Anmeldung stellt sie
also nicht aus, sie liest sie nur. Die aktive Organisation einer solchen Sitzung bleibt
`null`, was *kein* Tenant-Scope heißt und nie „alle Organisationen"
(`AuthService.deriveActiveTenant`, von beiden Anmeldewegen benutzt).

Das ist die zweite Hälfte des Schutzes und der Grund, warum Nr. 1 nicht allein
steht. Selbst wenn eine Organisation seinen IdP auf eine fremde Nutzerbasis richtet,
entstehen daraus Konten ohne Zugehörigkeit — nicht Bearbeiter dieser Organisation. Eine
automatische Zuweisung („wer sich über den IdP der Organisation anmeldet, ist Mitglied
der Organisation") wurde ausdrücklich **nicht** gewählt: sie machte das Eintragen eines
Issuers zu einem Weg, Mitglieder zu erzeugen.

### 6. Wer den Issuer setzen darf, darf auch Nutzer verwalten

Aus Nr. 2 und Nr. 5 zusammen folgt die Rechteanforderung der
Konfigurationsroute: `GET`/`PUT /api/tenant/oidc` verlangt
`can_manage_settings` **und** `can_manage_users`.

Wer Issuer, Client-ID und Client-Secret setzt, bestimmt, **welcher
Identity-Provider für die Mitglieder dieser Organisation bürgt** — eine Aussage
darüber, wer sich anmelden kann, nicht darüber, wie ein Formular aussieht. Mit
`can_manage_settings` allein hätte eine Gruppe, die die Organisation einrichten
darf, einen Hebel auf deren Anmeldung. Dieselbe Form wie beim Export
(`can_export` **und** `can_view_responses`) und beim Versandprotokoll
(`can_manage_form_settings` **und** `can_view_responses`). Dass Formulare zu
konfigurieren seit [ADR-0021](0021-recht-formular-einstellungen.md) an einem
*eigenen*, engeren Recht hängt, verstärkt diese Anforderung nur: wer Formulare
einstellt, kommt an diese Route ohnehin nicht mehr heran. Der Branding-Teil
desselben Reiters bleibt bei seiner schwächeren Anforderung; ein Bearbeiter, der
die Farben sehen darf, bekommt hier ein 403 und die Oberfläche zeigt den Block
**abwesend** statt deaktiviert.

### 7. Das Client-Secret verlässt den Server nie

Ergänzend zu ADR-0005, dessen Formulierung („Secrets verschlüsselt in der DB")
offenließ, ob es wieder herausgegeben wird: **nein.** Das Zugangswort eines
Formulars bleibt lesbar, weil ein Bearbeiter es vorlesen und weitergeben können
muss; ein Client-Secret muss niemand vorlesen. Die Leseantwort trägt „gesetzt / nicht gesetzt" und keinen
Wert (`oidcConfigSchema`), und „gesetzt" ist eine **Server**-Aussage: Bytes, die
sich in *diesem* Organisation nicht öffnen lassen, gelten als nicht gesetzt, und SSO
lässt sich gegen sie nicht einschalten (*fail closed*).

**Und die unangemeldet erreichbare Angebotsroute stellt ihn gar nicht erst her.**
`GET /api/auth/oidc/providers` fragt als Boolean (`OidcSecretsService.isUsable`)
statt über `OidcConfigService.signIn(row)` — der hätte das entsiegelte Secret
jeder eingeschalteten Organisation in der Hand, nur um zu entscheiden, ob ein
Knopf erscheint. Auf diesem Weg gibt es keinen Ausdruck, in dem ein Klartext
vorkommt, und „verlässt den Server nie" hängt nicht daran, dass niemand
`oidcProviderSchema` erweitert. Rest — als Folgearbeit unten benannt: `isUsable`
ist intern weiterhin `open()` mit sofort verworfenem Ergebnis.

Versiegelt wird unter `tenant-oidc:<tenant>:oidc.client_secret`
(`secret-context.ts`). Der **Tenant** im AAD ist es, der ein Geheimnis von Organisation A
in der Spalte von Organisation B unbrauchbar macht; das **Feld** ist es, das verhindert,
dass es in `access.password` desselben Organisation geschoben und über die
Einstellungsseite im Klartext gelesen wird. Beide Nachstellungen sind gebaut
(`apps/api/test/tenant-admin/oidc-secret.spec.ts`).

### 8. Die `redirect_uri` ist eine Serverfunktion — und die Organisation reist im Cookie

Sie steht im **Lese**-Schema und in keinem Schreibschema, wird aus
`PUBLIC_BASE_URL` gebildet (`OIDC_CALLBACK_PATH` in `public-url.service.ts`) und
ist für alle Organisationen dieselbe Adresse. Eine `redirect_uri` aus der Anfrage machte
die Anmeldung zu einem offenen Redirector; eine Organisation-Segment im Pfad machte
ausgerechnet die eine Adresse, die nicht vom Aufrufer stammen darf, wieder zu
einem Aufrufer-Wert.

*(Dieser Abschnitt sagte zuvor: „welcher Organisation gemeint
ist, reist im `state`". Gebaut ist ein **Transaktions-Cookie**, und das ist
besser — der ADR wird nachgezogen.)*

Welcher Organisation gemeint ist, steht im **Transaktions-Cookie**
(`auth/oidc/oidc-transaction.ts`), zusammen mit `nonce` und dem
PKCE-`code_verifier`. Der `state` in der Adresse ist nur noch
`base64url(sha256(<Geheimnis im Cookie>))`. Drei Gründe, und der dritte ist der
eigentliche:

1. Ein `state` landet im Provider-Log, in der Browser-Historie, in `Referer` und
   in jedem Proxy dazwischen. Wandert die Organisation dort mit, wandert er dorthin mit;
   wandert dort nur ein Hash, ist nichts zu lesen.
2. Der Wert, der den Callback **autorisiert**, bleibt damit im Cookie. Wer einen
   `state` aus einem Log fischt, kann die Transaktion nicht nachbauen.
3. Ein Cookie **bindet den Ablauf an den Browser, der ihn begonnen hat**. Genau
   das lässt Login-CSRF scheitern — ein Angreifer, der seinen eigenen Ablauf im
   fremden Browser zu Ende bringt, damit das Opfer als er angemeldet ist: der
   Browser des Opfers legt seine eigene Transaktion vor (oder gar keine), und
   der `state` passt nicht.

**Was das Cookie nicht ist: serverseitig einmalig.** Es gibt bewusst keine
Tabelle — kein Migrations-, Purge- und Index-Aufwand für einen Zustand, der zwei
Requests lang lebt, und keine In-Memory-Landkarte, die bei jedem Deploy jede
laufende Anmeldung zerreißt und bei der zweiten Instanz falsch ist. Der Callback
löscht das Cookie auf **jedem** Pfad, ein Browser kann also nicht wiederholen;
wer es von Hand aufhebt, kann mit ihm einen zweiten Code einlösen. Das ist
tragbar: das Cookie ist `HttpOnly`, `SameSite=Lax`, hinter TLS `__Host-` und lebt
zehn Minuten, und ein zweiter Code entsteht nur, indem sich **jemand** beim
Provider anmeldet — dessen Konto die zweite Sitzung dann auch gehört. Beide
Hälften sind als Test festgehalten (`test/auth/oidc-login.spec.ts`), damit die
zweite nicht unbemerkt für die erste gehalten wird.

### 3b. Dieselbe Person in **mehreren** Organisationen — was dann gilt

Die Frage kam in Review-Runde 3 Nr. 13: *„Was passiert, wenn ein Nutzer in
mehreren Orgas mit OIDC drin ist mit der gleichen E-Mail?"* Sie ist mit Nr. 1
und Nr. 3 bereits beantwortet, aber nirgends zusammenhängend aufgeschrieben —
und die Oberfläche sagte dazu einen **falschen** Satz. Beides hier.

**Es gibt genau ein Konto.** `user.email` ist installationsweit eindeutig; ein
zweites zu derselben Adresse kann es nicht geben (Nr. 3, Variante (c)). Die
zweite Organisation *hängt* deshalb eine Mitgliedschaft an das vorhandene
Konto — `TenantUsersService.create` nennt das `attachExisting` —, sie legt
nichts an und verschickt keine Einladung.

**Die Anmeldung bleibt die, über die das Konto entstanden ist.** Gebunden ist
das Paar *(Issuer, Subject)*, und `oidc_subject` ist nach der ersten Anmeldung
gesetzt. Der Anmeldedienst der zweiten Organisation erreicht diese Zeile
nicht: Schritt 1 findet über *(iss_B, sub)* nichts, und Schritt 2 verlangt
`oidc_subject IS NULL`. Die Person meldet sich also weiterhin über den
**ersten** Dienst an und wechselt danach oben über die Organisationsauswahl
in die zweite.

Das ist kein Mangel, sondern Nr. 1 in Betrieb: eine zweite Bindung wäre ein
zweiter Anmeldedienst, der über dasselbe Konto entscheidet — und jede
Organisation trägt ihren Dienst selbst ein.

⚠️ **Was falsch war, war der Satz der Oberfläche.** Beim Anhängen eines
vorhandenen Kontos meldete die Mitgliederverwaltung: „Das Konto gab es schon —
die Anmeldung läuft mit dem vorhandenen Passwort." Bei einem SSO-Konto ist das
schlicht unwahr, es hat keins. Wer der Meldung glaubte, wartete auf ein
Passwort, das nie kommt, und suchte den Fehler in der eigenen
SSO-Einrichtung. Der Satz unterscheidet jetzt nach `accountKind` und sagt für
ein SSO-Konto, was oben steht.

**Die Sonderfälle, vollständig:**

| Lage | Was geschieht |
|---|---|
| Konto ist an Dienst A gebunden, Organisation B hängt es an | Mitgliedschaft entsteht; Anmeldung weiter über A, danach Organisationswechsel |
| Konto ist eine **offene** Einladung von A, B will es anhängen | Abgelehnt (`EMAIL_INVITED_ELSEWHERE_MESSAGE`) — B bekäme sonst jemanden, der sich hier nie anmelden kann |
| Konto ist **lokal**, B lädt per SSO ein | Abgelehnt (`EMAIL_IS_LOCAL_MESSAGE`) — kein Anmeldedienst entscheidet über ein lokales Konto |
| Konto ist SSO, B lädt **lokal** ein | Abgelehnt (`EMAIL_IS_OIDC_MESSAGE`) — kein zweiter, stiller Weg hinein |

## Consequences

- **Positiv:** der IdP einer Organisation ist kein Generalschlüssel. Ein `sub`, der bei
  einem fremden Provider nachgebaut wird, führt auf ein **anderes** Konto, weil
  der Issuer Teil des Schlüssels ist. Der Nachweis dazu ist der Zwei-Organisationen-,
  Zwei-Issuer-, **gleicher `sub`**-Test — ein Test mit zwei verschiedenen `sub`
  misst nichts.
- **Preis (Nr. 3):** ohne vorherige Einladung kommt niemand über SSO herein —
  auch nicht jemand, dessen Adresse der Organisation bekannt ist. Das ist die gewollte
  Richtung: die Organisation benennt seine Leute, nicht der Provider. Eine Organisation muss
  ihren Issuer deshalb konfiguriert haben, **bevor** sie OIDC-Personen einlädt
  (die Oberfläche sperrt die OIDC-Option ohnehin, solange SSO in der Organisation
  aus ist), und ein Issuer-Wechsel entwertet **unbeanspruchte** Einladungen — sie müssen neu
  ausgestellt werden.
- **Preis:** eine Adresse, eine Zeile, ein IdP — solange `user.email`
  installationsweit eindeutig ist. Eine unbeanspruchte Einladung belegt die
  Adresse für die ganze Installation. **Offener Punkt**, hier benannt
  statt angenommen.
- **Preis:** eine Änderung des Issuers einer Organisation entwertet dessen bestehende
  OIDC-Konten — sie werden über das neue Paar nicht mehr gefunden. Das ist der
  richtige Vorgabewert (der Provider hat gewechselt, also bürgt ein anderer), muss
  aber in der Oberfläche angesagt werden.
- **Folgearbeit:** die beiden `CHECK`-Bedingungen additiv lockern,
  damit eine unbeanspruchte Einladung überhaupt eine `user`-Zeile sein kann
  (Nr. 3, letzter Absatz) — **ohne diese Migration ist die `oidc`-Variante von
  `tenantMemberCreateSchema` nicht ausführbar.** Dazu: den Issuer der einladenden Organisation beim Anlegen stempeln.
- **Erledigt:** `state` und `nonce` prüfen, PKCE, die Ablehnung einer Organisation mit `oidcEnabled: false` **auch beim Direktaufruf**, die drei Schritte
  aus Nr. 3 samt einer Ablehnung, die kein Konto verrät, und die Entscheidung,
  wie ein angemeldetes Konto ohne Mitgliedschaft begrüßt wird (Nr. 5: gar keine
  Sitzung, dafür ein Satz auf der Anmeldeseite).
- **Folgearbeit (Web: Organisations-Verwaltung):** der Issuer-Wechsel muss in der
  Oberfläche **angesagt** werden — er entwertet die bestehenden OIDC-Konten der Organisation *und* dessen unbeanspruchte Einladungen. Dafür gibt es heute noch keine
  OIDC-Oberfläche, nur einen Knopf auf der Anmeldeseite. Sobald die Oberfläche der
  Organisations-Verwaltung entsteht, gehört der Hinweis dorthin.
- **Folgearbeit (`tenant-admin/**`):** ein Prädikat, das ein gespeichertes
  Client-Secret **prüft, ohne es zu entpacken**. `OidcSecretsService.isUsable`
  ist heute `open()` mit sofort verworfenem Ergebnis; die unangemeldet
  erreichbare Angebotsroute stellt damit zwar keinen Klartext mehr her, der über
  ihre eigene Grenze hinausreicht (`OidcLoginService.offers`), aber innerhalb von
  `tenant-admin` entsteht er weiterhin einmal je Organisation. Ein Weg, der nur den
  GCM-Tag prüft, macht daraus „gar kein Klartext" — und ist zugleich billiger auf
  einer Route, die dreißigmal in der Minute beantwortet wird.
- **Folgearbeit (`tenant-admin/**`, `admin/**`):** drei handgeschriebene
  `P2002`-Prädikate stehen noch in `users.service.ts`, `groups.service.ts` und
  `admin.service.ts`; `common/prisma-error.ts#isUniqueViolation` ist die
  richtige Heimat dafür.
- **Unberührt:** [ADR-0005](0005-auth-sessions-oidc.md) gilt weiter — diese
  Entscheidung ergänzt ihn um den Schlüssel, den er offenließ, und ersetzt
  nichts. Ebenso unberührt: [ADR-0011](0011-systemweite-einstellungen.md); die
  OIDC-Konfiguration ist **kein** Einstellungsdokument und erbt nichts.

## Fortschreibung 2026-09-05: der Issuer-Wechsel nimmt die offenen Einladungen mit (Review-Runde 5 Nr. 3)

Zwei Zeilen der Folgen oben sagten es voraus und ließen es stehen: *„ein
Issuer-Wechsel entwertet **unbeanspruchte** Einladungen — sie müssen neu
ausgestellt werden"* und die Folgearbeit *„der Issuer-Wechsel muss in der
Oberfläche angesagt werden"*. Beide waren als Preis gedacht, den eine Verwaltung
zahlt und kennt. Im Betrieb war es keiner, den jemand kannte:

```
warn OidcIdentityService: OIDC login at issuer https://konto.…/realms/hv for tenant …
  found no redeemable invitation for h***@…: the invitation was stamped with a
  different issuer.
```

Die eingeladene Person sah „abgelehnt", die Verwaltung sah nichts, und „neu
ausstellen" gab es nicht: **„Einladung erneut senden" erneuerte den Link und
nicht den Stempel** (`ScopedMembershipDelegate.resendInvitation`). Der einzige
Weg zurück war „entfernen und neu anlegen" — und der nimmt Rolle und
Formularrechte mit.

### Entscheidung

Der Stempel **wandert mit der Konfiguration**, an zwei Stellen und in derselben
Transaktion wie der Vorgang, zu dem er gehört:

1. **Beim Speichern eines neuen Issuers** (`ScopedTenantDelegate.updateOidc`)
   werden die offenen SSO-Einladungen dieser Organisation umgestempelt. Ein
   unveränderter Issuer ist ein No-op, ein `null` stempelt nichts um (ein Stempel
   `null` wäre eine Einladung, die keine Anmeldung je trifft). Die Anzahl steht in
   einer Logzeile — ohne Adressen und ohne Namen.
2. **Bei „Einladung erneut senden"** wird der Stempel mit erneuert, aus der
   eigenen Tenant-Zeile, gelesen in derselben Transaktion, die die Mail
   einreiht.

### Warum das keinen Schlüssel verschenkt

Der Stempel war nie das, was zwei Organisationen trennt — das tut die
Mitgliedschaftsbedingung aus Nr. 3a, und die bleibt unangetastet. Umgestempelt
wird nur, was ohnehin dieser Organisation gehört: `oidcSubject IS NULL` (nicht
eingelöst), `passwordHash IS NULL` (kein lokales Konto), **keine** Mitgliedschaft
außerhalb dieser Organisation (dieselbe Grenze, die `resendInvitation` schon als
`belongsElsewhere` zieht) und `isSuperadmin = false`. Der Wert kommt aus der
Spalte der einladenden Organisation, **nie** aus einer Anfrage — die Regel dieses
ADRs, unverändert.

⚠️ **Zwei Zustände bleiben unrepariert, und das ist benannt:** eine offene
Einladung, die zwei Organisationen gehört (keine der beiden darf sie umhängen),
und die eines Superadministrators (keine Organisation entscheidet, welcher
Provider ein Konto der Systemverwaltung beansprucht). Der Weg dort ist
„Superadmin entziehen, erneut senden, wieder befördern" oder ein Passwort durch
die Systemverwaltung.

⚠️ **Unverändert gilt:** bestehende, **eingelöste** OIDC-Konten entwertet ein
Issuer-Wechsel weiterhin — sie werden über das neue Paar nicht gefunden. Das ist
der richtige Vorgabewert (der Provider hat gewechselt, also bürgt ein anderer)
und keine Einladung, die man nachziehen könnte.

### Der zweite Weg, auf dem ein Stempel veraltete

Gefunden beim Umsetzen, und er erklärt dasselbe Log ohne jeden Wechsel: gestempelt
wurde der **rohe** Spaltenwert, verglichen wird beim Login gegen
`acceptableIssuer(spalte)` (`OidcConfigService.signIn`). Gleich waren beide nur,
solange jeder Schreiber der Spalte durch `checkedIssuer` gegangen ist. Eine von
Hand reparierte Zeile, ein älterer Stand oder ein künftiger Seed hinterlässt
`…/realms/hv/` **mit** Schluss-Schrägstrich — und dann trägt jede neue Einladung
einen Wert, den keine Anmeldung je trifft.

`issuerStamp()` (`tenant-admin/oidc-issuer.ts`) ist seitdem die eine Stelle, an
der Stempel und Vergleich dieselbe Rechnung benutzen; alle drei Stempelstellen
gehen durch sie. Ohne Allow-List, und das ist Absicht: die entscheidet, **ob**
eine Organisation SSO anbietet, nicht **wie** ihr Issuer geschrieben wird. `null`
heißt „damit darf nicht gestempelt werden" — die Aufrufer machen daraus eine
Absage statt einer Zeile, die niemand einlösen kann.
