# Vorlage 02 — Anbieterangaben einer Organisation

> **Wer füllt das aus:** die Organisation (Mandant), in ihren
> Organisationseinstellungen. Recht: `can_manage_settings`.
> **Wo erscheint es:** unter `/o/<kurzname>/imprint`, verlinkt aus der
> Fußzeile jeder öffentlichen Seite eines Formulars dieser Organisation, unter
> der Überschrift *„Verantwortlich für dieses Formular"*.
> **Rechtsgrundlage:** § 18 Abs. 1 MStV; § 5 DDG, soweit die Organisation unter
> **eigener** Adresse erreichbar ist (`tenant.public_base_url`); außerdem
> Art. 13 Abs. 1 lit. a DSGVO, der die Identität des Verantwortlichen verlangt.

---

## Warum es diese Seite zusätzlich zum Impressum des Betreibers gibt

Zwei Fragen, zwei Antworten, und sie fallen hier auseinander:

- **„Wer betreibt die Website, auf der ich gerade bin?"** — das ist der
  Betreiber der Installation. Seine Angaben stehen im
  [Impressum]([[ADRESSE_DES_BETREIBER_IMPRESSUMS]]).
- **„Wer bekommt meine Daten und wer entscheidet, wofür?"** — das ist die
  Organisation, die dieses Formular anbietet. Ihre Angaben stehen hier.

⚠️ Ist die Organisation unter einer **eigenen** Adresse erreichbar
(`tenant.public_base_url` gesetzt), ist sie unter dieser Adresse selbst
Diensteanbieterin. Dann ist diese Seite nicht ergänzend, sondern das
**maßgebliche** Impressum, und die Pflichtangaben nach § 5 DDG sind vollständig
zu erfüllen — dann bitte zusätzlich die Blöcke aus
[Vorlage 01](01-impressum-betreiber.md) übernehmen (Register,
Umsatzsteuer-Identifikationsnummer, Aufsichtsbehörde).

---

## Anbieter dieses Formulars

### Verantwortliche Stelle

[[NAME_DER_ORGANISATION]]
⟪NUR WENN JURISTISCHE PERSON ODER PERSONENGESELLSCHAFT⟫[[RECHTSFORM]]⟪ENDE⟫
[[STRASSE_UND_HAUSNUMMER]]
[[PLZ]] [[ORT]]
[[LAND]]

⟪NUR WENN JURISTISCHE PERSON ODER PERSONENGESELLSCHAFT⟫
**Vertreten durch:** [[NAME_DER_VERTRETUNGSBERECHTIGTEN_PERSON_EN]]
⟪ENDE⟫

### Kontakt

Telefon: [[TELEFONNUMMER]]
E-Mail: [[E_MAIL_ADRESSE_DER_ORGANISATION]]

⟪NUR WENN EINGETRAGEN⟫
### Registereintrag

Registergericht: [[REGISTERGERICHT]]
Registernummer: [[REGISTERNUMMER]]
⟪ENDE⟫

### Fragen zum Datenschutz

Wie [[NAME_DER_ORGANISATION]] mit den Angaben aus diesem Formular umgeht, steht
in den
[Datenschutzhinweisen]([[ADRESSE_DER_DATENSCHUTZHINWEISE_DER_ORGANISATION]]).

⟪NUR WENN EIN DATENSCHUTZBEAUFTRAGTER BESTELLT IST⟫
Datenschutzbeauftragte Person: [[NAME]], [[KONTAKTWEG_E_MAIL_ODER_POSTANSCHRIFT]]
⟪ENDE⟫

### Technischer Betrieb

Die technische Bereitstellung dieses Formulars erfolgt durch
[[NAME_DES_BETREIBERS]] im Auftrag von [[NAME_DER_ORGANISATION]]. Angaben zum
technischen Betrieb stehen im
[Impressum des Betreibers]([[ADRESSE_DES_BETREIBER_IMPRESSUMS]]) und in dessen
[Datenschutzerklärung]([[ADRESSE_DER_BETREIBER_DATENSCHUTZERKLAERUNG]]).

---

## Anzeige, wenn nichts hinterlegt ist

⚠️ **Nicht erfinden, nicht verstecken.** Hat die Organisation noch nichts
eingetragen, zeigt die Seite den folgenden Text — und zwar vollständig. Der
Link in der Fußzeile bleibt bestehen. Begründung: `docs/legal/README.md`,
Abschnitt 5.4.

> ### Anbieterangaben
>
> Für dieses Formular sind bislang keine Anbieterangaben hinterlegt.
>
> Das Formular wird bereitgestellt von der Organisation
> **⟨Name der Organisation aus `tenant.name`⟩**. Weitere Angaben zu ihr —
> Anschrift, Vertretung, Kontaktweg — liegen dieser Installation nicht vor.
>
> ⟪NUR WENN `tenant.reply_to` GESETZT IST⟫
> Antworten auf Nachrichten dieser Organisation erreichen sie unter
> ⟨`tenant.reply_to`⟩.
> ⟪ENDE⟫
>
> **Wenn Sie die Organisation erreichen müssen** — etwa um Auskunft über Ihre
> Daten zu verlangen oder deren Löschung —, wenden Sie sich an den Betreiber
> dieser Installation, ⟨Name aus den Systemeinstellungen⟩,
> ⟨Kontaktadresse aus den Systemeinstellungen⟩. Er ist verpflichtet, Ihr
> Anliegen unverzüglich an die verantwortliche Organisation weiterzuleiten.
>
> Welche Daten die Anwendung technisch verarbeitet und wie lange sie gespeichert
> bleiben, steht unabhängig davon in den
> [Datenschutzhinweisen](⟨Adresse⟩), Abschnitt B.

**Und im Verwaltungsbereich**, nicht auf dieser Seite: ein Hinweis für die
Organisation selbst — im Einrichtungsassistenten und beim Veröffentlichen eines
Formulars (`apps/web/src/views/builder/PublishNotice.tsx`):

> Für diese Organisation sind keine Anbieterangaben hinterlegt. Teilnehmende
> sehen auf der Seite *Anbieterangaben* einen entsprechenden Hinweis. Ohne
> diese Angaben lässt sich nicht erkennen, wer für dieses Formular
> verantwortlich ist (§ 18 Abs. 1 MStV, Art. 13 Abs. 1 lit. a DSGVO).
